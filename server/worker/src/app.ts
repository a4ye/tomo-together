// Tomo Together server on Hono. A line-for-line port of server/index.js:
// accounts, friends, hangouts, vibe, wardrobe, leaderboard, staking, world.
//
// The middleware order below is Express's, and it matters:
//   CORS -> express.json() -> /uploads static -> host-conditional webapp static
//   -> public static -> /apk -> routes -> finalhandler 404 -> error handler
// which is why a malformed JSON body on a *protected* route answers 500 and not
// 401, and why `app.tomo-together.com` answers every GET with the SPA shell.
//
// The legacy ht6.icinoxis.net / ht6-app.icinoxis.net redirects are deliberately
// NOT ported: those hostnames are unbound and return Azure's own 404 (SPEC 9.4).
import { Hono } from 'hono';
import { scryptSync } from 'node:crypto';

import type { Env } from './env';
import { Store, DuplicateKeyError, type HangoutRow, type UserRow } from './ports/store';
import {
  ACTIVITIES, ACORNS_PER_LEVEL, HOLIDAYS, ITEMS, SPECIES,
  VIBE_PER_CONFIRM, VIBE_PER_LEVEL, labelOf,
} from './domain/catalog';
import {
  AUTH0_DISABLED_PREFIX, asString, attendeeIdSet, bonusFor, duelUpdate, friendTitle,
  getBearerToken, hangoutStatsFrom, hangoutView, interestsOf, level, meView, nextFriday18,
  nowIso, pair, parseId, publicUser, rankScore, rankedActivities, safeJsonArray,
  sanitizeInterests, validCryptoInteger,
} from './domain/logic';
import { CryptoApi, CryptoError, CryptoUnavailableError, cryptoEventRsvp, extId } from './crypto/client';
import { json, notFoundResponse, sendBody } from './http/express';
import { directoryRedirect, serveObject, serveStatic } from './http/static';
import { canonicalizePath } from './routes';

export interface Ctx {
  Bindings: Env;
  Variables: {
    store: Store;
    crypto: CryptoApi;
    body: any;
    user: UserRow;
  };
}

/** Body-parser's SyntaxError: status 400, but the error handler answers 500. */
class BodyParseError extends Error {}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * crypto.scryptSync(pw, salt, 32).toString('hex'). The parameters are Node's
 * defaults (N=16384, r=8, p=1) on both runtimes, so a password hashed by the
 * App Service verifies here unchanged — which the migrated `users` rows require.
 */
const hash = (pw: string, salt: string): string =>
  toHex(new Uint8Array(scryptSync(pw, salt, 32)));
const hex = (bytes: number): string => toHex(crypto.getRandomValues(new Uint8Array(bytes)));
const newToken = (): string => hex(24);

export const app = new Hono<Ctx>({ strict: false });

// ---------------------------------------------------------------- plumbing --

app.use('*', async (c, next) => {
  c.set('store', new Store(c.env.DB));
  c.set('crypto', new CryptoApi(c.env));
  await next();
});

/**
 * express.json(): parses only when the Content-Type is JSON, leaves req.body as
 * {} otherwise, and throws on malformed input or a body above 100kb.
 */
app.use('*', async (c, next) => {
  const type = c.req.header('content-type') ?? '';
  const isJson = /^application\/json\s*(;|$)/i.test(type.trim());
  if (!isJson) {
    c.set('body', {});
    return next();
  }
  const raw = await c.req.raw.clone().text();
  if (raw.length > 100 * 1024) throw new BodyParseError('request entity too large');
  if (raw.trim() === '') {
    c.set('body', {});
    return next();
  }
  try {
    c.set('body', JSON.parse(raw));
  } catch (error) {
    throw new BodyParseError(error instanceof Error ? error.message : 'invalid json');
  }
  return next();
});

// --- static trees, in Express's registration order -------------------------
// app.use('/uploads', express.static(UPLOAD_DIR))
app.use('*', async (c, next) => {
  const method = c.req.method;
  if (method !== 'GET' && method !== 'HEAD') return next();
  const path = new URL(c.req.url).pathname;
  // Router.use() mounts are case-insensitive; the remainder is not, because
  // serve-static resolves it against a case-sensitive filesystem.
  if (!/^\/uploads(\/|$)/i.test(path)) return next();
  // UPLOAD_DIR is mkdir'd at startup, so the mount point always exists as a
  // directory: `/uploads` without a trailing slash is a 301, exactly as
  // serve-static's `redirect: true` does on the App Service.
  if (path.length === '/uploads'.length) return directoryRedirect(c.req.raw);
  const served = await serveStatic(c.env.DATA, 'uploads', path.slice('/uploads'.length), c.req.raw);
  return served ?? next();
});

// react-native-web clone of the app: CI exports the same src/ to static files
// and drops them in webapp/; we serve them for the app.* host only, with an SPA
// fallback that swallows every unmatched GET (verified live: /health on
// app.tomo-together.com returns the shell, not JSON).
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname !== (c.env.WEB_HOST || 'app.tomo-together.com')) return next();
  const method = c.req.method;
  if (method !== 'GET' && method !== 'HEAD') return next();
  const served = await serveStatic(c.env.DATA, 'webapp', url.pathname, c.req.raw);
  if (served) return served;
  // SPA fallback: any non-file GET gets the app shell.
  const shell = await serveObject(c.env.DATA, 'webapp/index.html', c.req.raw);
  if (method === 'GET' && shell) return shell;
  return next();
});

// Marketing homepage (server/public).
app.use('*', async (c, next) => {
  const method = c.req.method;
  if (method !== 'GET' && method !== 'HEAD') return next();
  const path = new URL(c.req.url).pathname;
  const served = await serveStatic(c.env.DATA, 'public', path, c.req.raw);
  return served ?? next();
});

const jsonRes = (c: any, value: unknown, status = 200) =>
  json(c.req.raw.headers, c.req.method, value, { status });

function notSignedIn(c: any) {
  return json(c.req.raw.headers, c.req.method, { error: 'Not signed in' }, {
    status: 401,
    headers: { 'www-authenticate': 'Bearer' },
  });
}

const auth = async (c: any, next: () => Promise<void>) => {
  const token = getBearerToken(c.req.header('authorization') ?? null);
  if (!token) return notSignedIn(c);
  const user = await c.get('store').userByToken(token);
  if (!user) return notSignedIn(c);
  c.set('user', user);
  await next();
};

function sendCryptoError(c: any, error: unknown) {
  if (error instanceof CryptoUnavailableError) {
    return jsonRes(c, { error: error.code, message: error.message }, 503);
  }
  if (error instanceof CryptoError) {
    const status = [400, 403, 404, 409].includes(error.status)
      ? error.status
      : error.status === 503
        ? 503
        : 502;
    return jsonRes(
      c,
      {
        error: status === 502 ? 'crypto_upstream_failed' : error.code,
        message: status === 502 ? 'Crypto service request failed. Please try again.' : error.message,
      },
      status,
    );
  }
  console.error('[crypto] unexpected proxy failure', {
    name: (error as any)?.name,
    status: (error as any)?.status,
  });
  return jsonRes(
    c,
    { error: 'crypto_upstream_failed', message: 'Crypto service request failed. Please try again.' },
    502,
  );
}

// ------------------------------------------------------------------ shared --

async function viewHangout(c: any, h: HangoutRow, meId: number) {
  const members = await c.get('store').usersByIds(h.member_ids);
  return hangoutView(h, meId, members);
}

async function interestSetOf(store: Store, userId: number): Promise<Set<string>> {
  const u = await store.userById(userId);
  return new Set(u ? interestsOf(u) : []);
}

async function hangoutStats(store: Store, meId: number, otherId: number) {
  return hangoutStatsFrom(await store.completedAtForPair(meId, otherId));
}

/**
 * A staked hangout is completed by /end only after the remote payout has been
 * reconciled; non-staked hangouts keep the automatic all-pairs completion.
 */
async function maybeComplete(store: Store, hangoutId: number): Promise<void> {
  const h = await store.hangoutById(hangoutId);
  if (!h || h.completed_at) return;
  const need = (h.member_ids.length * (h.member_ids.length - 1)) / 2;
  const got = h.confirms.length;
  if (h.photo && got >= need && !h.crypto_event_id) {
    await store.completeIfOpen(hangoutId, nowIso());
  }
}

// -------------------------------------------------------------------- auth --

app.post('/auth/register', async (c) => {
  const { username, name, birthday, password, color, species, interests } = c.get('body') || {};
  if (!/^[a-z0-9_]{3,20}$/.test(username || ''))
    return jsonRes(c, { error: 'Username must be 3-20 chars: a-z, 0-9, _' }, 400);
  if (!name || name.length < 1 || name.length > 40)
    return jsonRes(c, { error: 'Name is required' }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday || '') || isNaN(new Date(birthday).getTime()))
    return jsonRes(c, { error: 'Birthday must be a valid date' }, 400);
  if (!password || password.length < 6)
    return jsonRes(c, { error: 'Password must be at least 6 characters' }, 400);

  const store = c.get('store');
  if (await store.userByUsername(username))
    return jsonRes(c, { error: 'Username is taken' }, 409);

  const salt = hex(8);
  const token = newToken();
  const doc = {
    id: await store.nextId('users'),
    username,
    name,
    birthday,
    pass_hash: hash(password, salt),
    salt,
    token,
    auth0_sub: null,
    acorns: 50,
    color: color || '#A8D8C8',
    species: SPECIES.includes(species) ? species : 'cat',
    owned: [] as string[],
    equipped: [] as string[],
    interests: sanitizeInterests(interests),
    pos_x: null,
    pos_y: null,
    created_at: nowIso(),
  };
  try {
    await store.insertUser(doc);
  } catch (error) {
    if (error instanceof DuplicateKeyError) return jsonRes(c, { error: 'Username is taken' }, 409);
    throw error;
  }
  // best-effort wallet registration
  c.executionCtx.waitUntil(c.get('crypto').ensureUser(username).catch(() => {}));
  return jsonRes(c, { token, me: meView(doc as UserRow) });
});

app.post('/auth/login', async (c) => {
  const { username, password } = c.get('body') || {};
  const pass = asString(password);
  const store = c.get('store');
  const u = await store.userByUsername(asString(username));
  if (!u) return jsonRes(c, { error: 'Wrong username or password' }, 401);

  // Accounts provisioned during the Auth0 era carry a placeholder password. The
  // first self-hosted login claims the username and mints a real bearer token.
  if (typeof u.pass_hash === 'string' && u.pass_hash.startsWith(AUTH0_DISABLED_PREFIX)) {
    if (!pass || pass.length < 6) {
      return jsonRes(c, { error: 'Password must be at least 6 characters' }, 400);
    }
    const salt = hex(8);
    const token = newToken();
    await store.claimAuth0Account(u.id, hash(pass, salt), salt, token);
    c.executionCtx.waitUntil(c.get('crypto').ensureUser(u.username).catch(() => {}));
    return jsonRes(c, { token, me: meView(u) });
  }

  if (hash(pass, u.salt) !== u.pass_hash)
    return jsonRes(c, { error: 'Wrong username or password' }, 401);
  c.executionCtx.waitUntil(c.get('crypto').ensureUser(u.username).catch(() => {}));
  return jsonRes(c, { token: u.token, me: meView(u) });
});

app.get('/me', auth, (c) => jsonRes(c, { me: meView(c.get('user')) }));

app.put('/me/interests', auth, async (c) => {
  const store = c.get('store');
  const interests = sanitizeInterests(c.get('body')?.interests);
  await store.setInterests(c.get('user').id, interests);
  return jsonRes(c, { me: meView((await store.userById(c.get('user').id))!) });
});

app.put('/me/avatar', auth, async (c) => {
  const store = c.get('store');
  const me = c.get('user');
  const { color, equipped, species } = c.get('body') || {};
  const owned = safeJsonArray(me.owned);
  const eq = Array.isArray(equipped) ? equipped.filter((i: string) => owned.includes(i)) : [];
  await store.setAvatar(
    me.id,
    typeof color === 'string' && color ? color : me.color,
    eq,
    SPECIES.includes(species) ? species : me.species,
  );
  return jsonRes(c, { me: meView((await store.userById(me.id))!) });
});

// ----------------------------------------------------------------- catalog --

app.get('/catalog', (c) => jsonRes(c, { activities: ACTIVITIES, items: ITEMS, holidays: HOLIDAYS }));

// ------------------------------------------------------ users and friends --

/** Express 4's qs query parser turns `?q=a&q=b` into an array; String() joins it. */
function queryString(c: any, name: string): string {
  const all = new URL(c.req.url).searchParams.getAll(name);
  if (all.length === 0) return '';
  return all.length === 1 ? all[0] : String(all);
}

app.get('/users/search', auth, async (c) => {
  const q = queryString(c, 'q').toLowerCase().trim();
  if (q.length < 2) return jsonRes(c, { users: [] });
  const rows = await c.get('store').searchUsers(c.get('user').id, q);
  return jsonRes(c, { users: rows.map(publicUser) });
});

app.get('/friends', auth, async (c) => {
  const store = c.get('store');
  const me = c.get('user').id;
  const rows = await store.friendshipsForUser(me);
  const friends: any[] = [];
  const incoming: any[] = [];
  const outgoing: any[] = [];
  for (const f of rows) {
    const otherId = f.a_id === me ? f.b_id : f.a_id;
    const u = (await store.userById(otherId))!;
    const view = {
      ...publicUser(u),
      birthday: u.birthday.slice(5),
      vibe: f.vibe,
      vibeLevel: level(f.vibe),
      vibeIntoLevel: f.vibe % VIBE_PER_LEVEL,
      vibePerLevel: VIBE_PER_LEVEL,
    };
    if (f.status === 'accepted') {
      const stats = await hangoutStats(store, me, otherId);
      const title = friendTitle({
        vibeLevel: view.vibeLevel, streak: stats.streak,
        lastHangoutAt: stats.lastHangoutAt, friendsSince: f.created_at,
      });
      friends.push({ ...view, ...stats, ...title });
    } else if (f.requested_by === me) outgoing.push(view);
    else incoming.push(view);
  }
  friends.sort((x, y) => y.vibe - x.vibe);
  return jsonRes(c, { friends, incoming, outgoing });
});

app.get('/friends/:username', auth, async (c) => {
  const store = c.get('store');
  const me = c.get('user').id;
  const other = await store.userByUsername(c.req.param('username'));
  if (!other) return jsonRes(c, { error: 'No such user' }, 404);
  const f = await store.friendship(me, other.id);
  if (!f || f.status !== 'accepted') return jsonRes(c, { error: 'Not your friend' }, 403);

  const shared = await store.hangoutsForPair(me, other.id);
  const completed = shared.filter((h) => h.completed_at);
  const upcoming = shared.filter((h) => !h.completed_at && new Date(h.date).getTime() >= Date.now());

  const counts: Record<string, number> = {};
  for (const h of completed) counts[h.activity_label] = (counts[h.activity_label] || 0) + 1;
  const topActivities = Object.entries(counts)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([label]) => label);

  const stats = await hangoutStats(store, me, other.id);
  const recentMemories = [];
  for (const h of completed.slice(0, 4)) recentMemories.push(await viewHangout(c, h, me));

  return jsonRes(c, {
    friend: {
      ...publicUser(other),
      birthday: other.birthday.slice(5),
      vibe: f.vibe,
      vibeLevel: level(f.vibe),
      vibeIntoLevel: f.vibe % VIBE_PER_LEVEL,
      vibePerLevel: VIBE_PER_LEVEL,
      friendsSince: f.created_at,
      lastHangout: completed[0] ? completed[0].date : null,
      hangoutCount: completed.length,
      upcomingCount: upcoming.length,
      topActivities,
      interests: interestsOf(other).map(labelOf).filter(Boolean),
      recentMemories,
      ...friendTitle({
        vibeLevel: level(f.vibe),
        streak: stats.streak,
        lastHangoutAt: completed[0] ? completed[0].completed_at : null,
        friendsSince: f.created_at,
      }),
    },
  });
});

app.post('/friends/request', auth, async (c) => {
  const store = c.get('store');
  const me = c.get('user');
  const other = await store.userByUsername(asString(c.get('body')?.username));
  if (!other) return jsonRes(c, { error: 'No such username' }, 404);
  if (other.id === me.id) return jsonRes(c, { error: 'That is you' }, 400);
  const existing = await store.friendship(me.id, other.id);
  if (existing) {
    if (existing.status === 'accepted') return jsonRes(c, { error: 'Already friends' }, 409);
    if (existing.requested_by === me.id) return jsonRes(c, { error: 'Request already sent' }, 409);
    await store.acceptFriendship(existing.id);
    return jsonRes(c, { ok: true, accepted: true });
  }
  const [a, b] = pair(me.id, other.id);
  await store.insertFriendship({
    id: await store.nextId('friendships'),
    a_id: a,
    b_id: b,
    status: 'pending',
    requested_by: me.id,
    vibe: 0,
    created_at: nowIso(),
  });
  return jsonRes(c, { ok: true, accepted: false });
});

app.post('/friends/accept', auth, async (c) => {
  const store = c.get('store');
  const me = c.get('user');
  const other = await store.userByUsername(asString(c.get('body')?.username));
  if (!other) return jsonRes(c, { error: 'No such username' }, 404);
  const f = await store.friendship(me.id, other.id);
  if (!f || f.status !== 'pending' || f.requested_by === me.id)
    return jsonRes(c, { error: 'No pending request from them' }, 400);
  await store.acceptFriendship(f.id);
  return jsonRes(c, { ok: true });
});

app.get('/friends/:username/card', auth, async (c) => {
  const store = c.get('store');
  const me = c.get('user');
  const u = await store.userByUsername(c.req.param('username'));
  const f = u && (await store.friendship(me.id, u.id));
  if (!u || !f || f.status !== 'accepted') return jsonRes(c, { error: 'Not your friend' }, 404);
  const labels = (ids: string[]) =>
    ids.map((id) => ACTIVITIES.find((a) => a.id === id)).filter(Boolean).slice(0, 3).map((a) => a!.label);
  const likes = labels(await store.rankedActivities(u.id, 52, 'gt'));
  const dislikes = labels(await store.rankedActivities(u.id, 48, 'lt'));
  return jsonRes(c, {
    card: {
      ...publicUser(u),
      birthday: u.birthday.slice(5),
      vibeLevel: level(f.vibe),
      lastHangoutAt: (await hangoutStats(store, me.id, u.id)).lastHangoutAt,
      likes,
      dislikes,
    },
  });
});

// ------------------------------------------------- activity weights, duels --

app.get('/activities/ranked', auth, async (c) => {
  const store = c.get('store');
  const usernames = queryString(c, 'with').split(',').filter(Boolean);
  const ids = [c.get('user').id];
  for (const un of usernames) {
    const u = await store.userByUsername(un);
    if (u) ids.push(u.id);
  }
  const sets = new Map<number, Set<string>>();
  for (const id of ids) sets.set(id, await interestSetOf(store, id));
  const weights = await store.weightsFor(ids);
  return jsonRes(c, { activities: rankedActivities(ids, weights, sets) });
});

app.post('/duels', auth, async (c) => {
  const store = c.get('store');
  const me = c.get('user').id;
  const { winner, loser } = c.get('body') || {};
  if (!ACTIVITIES.some((a) => a.id === winner) || !ACTIVITIES.some((a) => a.id === loser))
    return jsonRes(c, { error: 'Unknown activity' }, 400);
  const weights = await store.weightsFor([me]);
  const next = duelUpdate(
    rankScore(weights, me, winner, null),
    rankScore(weights, me, loser, null),
  );
  await store.upsertWeight(me, winner, next.winner);
  await store.upsertWeight(me, loser, next.loser);
  return jsonRes(c, { ok: true });
});

// ------------------------------------------------------------- suggestions --

app.get('/suggestions', auth, async (c) => {
  const store = c.get('store');
  const me = c.get('user').id;
  const fr = await store.friendshipsForUser(me, true);
  let best: { otherId: number; t: number; vibe: number; lastHangoutAt: string | null } | null = null;
  for (const f of fr) {
    const otherId = f.a_id === me ? f.b_id : f.a_id;
    // don't re-suggest a pair that already has a hangout in the works
    if ((await store.countOpenForPair(me, otherId)) > 0) continue;
    const { lastHangoutAt } = await hangoutStats(store, me, otherId);
    const t = lastHangoutAt ? new Date(lastHangoutAt).getTime() : -Infinity;
    if (!best || t < best.t || (t === best.t && f.vibe > best.vibe)) {
      best = { otherId, t, vibe: f.vibe, lastHangoutAt };
    }
  }
  if (!best) return jsonRes(c, { suggestion: null });
  const u = (await store.userById(best.otherId))!;
  const sets = new Map<number, Set<string>>([
    [me, await interestSetOf(store, me)],
    [u.id, await interestSetOf(store, u.id)],
  ]);
  const weights = await store.weightsFor([me, u.id]);
  const top = ACTIVITIES.map((a) => ({
    ...a,
    combined:
      rankScore(weights, me, a.id, sets.get(me)!) + rankScore(weights, u.id, a.id, sets.get(u.id)!),
  })).sort((x, y) => y.combined - x.combined)[0];
  const stale = !best.lastHangoutAt || best.t < Date.now() - 14 * 24 * 3600 * 1000;
  return jsonRes(c, {
    suggestion: {
      friend: publicUser(u),
      activity: { id: top.id, label: top.label },
      date: nextFriday18().toISOString(),
      reason: stale ? 'stale' : 'vibe',
    },
  });
});

// ---------------------------------------------------------------- hangouts --

app.post('/hangouts', auth, async (c) => {
  const store = c.get('store');
  const cryptoApi = c.get('crypto');
  const me = c.get('user');
  const { activity, date, place, friendUsernames, stakeUnits } = c.get('body') || {};
  const act = ACTIVITIES.find((a) => a.id === activity);
  if (!act) return jsonRes(c, { error: 'Pick an activity' }, 400);
  if (!date || isNaN(new Date(date).getTime())) return jsonRes(c, { error: 'Pick a date' }, 400);

  const others: UserRow[] = [];
  for (const un of friendUsernames || []) {
    const u = await store.userByUsername(asString(un));
    if (!u) return jsonRes(c, { error: `No such user: ${un}` }, 404);
    const f = await store.friendship(me.id, u.id);
    if (!f || f.status !== 'accepted')
      return jsonRes(c, { error: `${u.name} is not your friend yet` }, 400);
    others.push(u);
  }
  if (others.length < 1) return jsonRes(c, { error: 'Invite at least one friend' }, 400);
  const ids = [me.id, ...others.map((u) => u.id)];
  const bonus = bonusFor(date, await store.usersByIds(ids));

  // A requested stake is never silently downgraded: the remote event is created
  // here, but the host stakes through the same explicit, retryable action as
  // everyone else, so no money moves before the local hangout is durable.
  let cryptoEventId: string | null = null;
  let stake: string | null = null;
  if (stakeUnits !== undefined) {
    if (typeof stakeUnits !== 'string' || !/^[1-9]\d*$/.test(stakeUnits) || stakeUnits.length > 34) {
      return jsonRes(c, {
        error: 'invalid_stake',
        message: 'Stake must be a positive integer amount in USDC base units.',
      }, 400);
    }
    try {
      await cryptoApi.ensureUser(me.username);
      // Cashable USDC is backed only by real deposits + redistributed stakes, so
      // the stake multiplier is always 1x; the holiday/birthday bonus applies to
      // acorns/vibe only.
      const ev = await cryptoApi.createEvent(me.username, act.label, stakeUnits, {
        multiplierBps: 10000,
        startsAt: date,
      });
      if (!ev || typeof ev.id !== 'string' || ev.id.length < 1) {
        throw new CryptoError(502, 'Crypto service returned an invalid event.', 'crypto_upstream_invalid');
      }
      cryptoEventId = ev.id;
      stake = stakeUnits;
    } catch (e) {
      return sendCryptoError(c, e);
    }
  }

  const hid = await store.nextId('hangouts');
  await store.insertHangout({
    id: hid,
    creator_id: me.id,
    activity: act.id,
    activity_label: act.label,
    date,
    place: place || 'Somewhere',
    bonus_mult: bonus.mult,
    bonus_reason: bonus.reason,
    photo: null,
    photo_by: null,
    completed_at: null,
    created_at: nowIso(),
    stake_units: stake,
    crypto_event_id: cryptoEventId,
    settled_at: null,
    member_ids: ids,
  });
  return jsonRes(c, { hangout: await viewHangout(c, (await store.hangoutById(hid))!, me.id) });
});

app.post('/hangouts/:id/stake', auth, async (c) => {
  const store = c.get('store');
  const cryptoApi = c.get('crypto');
  const me = c.get('user');
  const h = await store.hangoutById(parseId(c.req.param('id')));
  if (!h || !h.member_ids.includes(me.id)) return jsonRes(c, { error: 'Hangout not found' }, 404);
  if (!h.crypto_event_id) return jsonRes(c, { error: 'This hangout has no stake' }, 400);
  if (h.settled_at) return jsonRes(c, { error: 'crypto_conflict', message: 'Already settled' }, 409);
  if (h.stakes.some((s) => s.user_id === me.id)) {
    return jsonRes(c, { hangout: await viewHangout(c, h, me.id) });
  }
  try {
    await cryptoApi.ensureUser(me.username);
    let remoteEvent = await cryptoApi.getEvent(h.crypto_event_id);
    if (!remoteEvent || remoteEvent.id !== h.crypto_event_id || !Array.isArray(remoteEvent.rsvps)) {
      throw new CryptoError(502, 'Crypto service returned an invalid event.', 'crypto_upstream_invalid');
    }
    if (remoteEvent.status === 'settled') {
      throw new CryptoError(409, 'Already settled', 'crypto_conflict');
    }
    if (!cryptoEventRsvp(remoteEvent, me.username)) {
      try {
        remoteEvent = await cryptoApi.rsvp(h.crypto_event_id, me.username);
      } catch (error) {
        // A concurrent or response-lost RSVP may have succeeded. Re-read once and
        // accept only a durable matching RSVP.
        remoteEvent = await cryptoApi.getEvent(h.crypto_event_id);
        if (!cryptoEventRsvp(remoteEvent, me.username)) throw error;
      }
    }
    const rsvp = cryptoEventRsvp(remoteEvent, me.username);
    if (!rsvp || !['staked', 'attended'].includes(rsvp.status) || rsvp.stakedUnits !== h.stake_units) {
      throw new CryptoError(502, 'Crypto service returned an invalid RSVP.', 'crypto_upstream_invalid');
    }
  } catch (e) {
    return sendCryptoError(c, e);
  }
  await store.pushStake(h.id, me.id, nowIso());
  return jsonRes(c, { hangout: await viewHangout(c, (await store.hangoutById(h.id))!, me.id) });
});

function invalidCryptoUpstream(message = 'Crypto service returned an invalid settlement.') {
  return new CryptoError(502, message, 'crypto_upstream_invalid');
}

/**
 * Reconcile the authoritative RSVP set, replay all local attendance proof, and
 * validate the full payout before publishing it. With `complete`, settlement and
 * completion become visible together.
 */
async function settleStakeAndMirror(
  c: any,
  h: HangoutRow,
  attendeeIds: Set<number>,
  { complete = false }: { complete?: boolean } = {},
): Promise<HangoutRow> {
  const store: Store = c.get('store');
  const cryptoApi: CryptoApi = c.get('crypto');
  const current = await store.hangoutById(h.id);
  if (!current) throw invalidCryptoUpstream('Hangout disappeared during settlement.');
  if (!current.crypto_event_id || current.settled_at) {
    if (complete) await store.completeIfOpen(current.id, nowIso());
    return (await store.hangoutById(current.id))!;
  }

  const remoteEvent = await cryptoApi.getEvent(current.crypto_event_id);
  if (
    !remoteEvent ||
    remoteEvent.id !== current.crypto_event_id ||
    !['open', 'settled'].includes(remoteEvent.status) ||
    !Array.isArray(remoteEvent.rsvps) ||
    (remoteEvent.stakeUnits != null && remoteEvent.stakeUnits !== current.stake_units)
  ) {
    throw invalidCryptoUpstream('Crypto service returned an invalid event.');
  }
  // Events are always created at 1x: bonus_mult boosts acorns/vibe only, never
  // cashable USDC, so the payout bonus term below is always zero.
  const expectedMultiplierBps = 10_000;
  if (remoteEvent.multiplierBps != null && remoteEvent.multiplierBps !== expectedMultiplierBps) {
    throw invalidCryptoUpstream('Crypto event multiplier does not match this hangout.');
  }

  const memberDocs = await store.usersByIds(current.member_ids);
  const usersById = new Map(memberDocs.map((u) => [u.id, u]));
  const members = new Map(memberDocs.map((u) => [extId(u.username), u]));
  const seenRemote = new Set<string>();
  const remoteStakes: number[] = [];
  for (const rsvp of remoteEvent.rsvps) {
    const user = rsvp && members.get(rsvp.userId);
    if (
      !user ||
      seenRemote.has(rsvp.userId) ||
      rsvp.stakedUnits !== current.stake_units ||
      !['staked', 'attended', 'flaked', 'refunded'].includes(rsvp.status)
    ) {
      throw invalidCryptoUpstream('Crypto event does not match this hangout.');
    }
    seenRemote.add(rsvp.userId);
    remoteStakes.push(user.id);
  }
  // Mirror the durable remote RSVP set: drop local stakes that are not durable
  // remotely, then add missing remote stakes idempotently.
  await store.pruneStakes(current.id, remoteStakes);
  for (const userId of remoteStakes) await store.pushStake(current.id, userId, nowIso());

  const mirrored = (await store.hangoutById(current.id))!;
  const localStakes = [...mirrored.stakes]
    .sort((a, b) => a.user_id - b.user_id)
    .map((s) => ({ user_id: s.user_id, username: usersById.get(s.user_id)!.username }));

  if (remoteEvent.status !== 'settled') {
    // A failed check-in aborts settlement; it is never swallowed as a no-show.
    for (const staker of localStakes) {
      if (attendeeIds.has(staker.user_id)) {
        await cryptoApi.checkin(current.crypto_event_id, staker.username);
      }
    }
  }
  const result = await cryptoApi.settle(current.crypto_event_id);

  const expected = new Map(localStakes.map((row) => [extId(row.username), row]));
  const attendingStakers = new Set(
    localStakes.filter((row) => attendeeIds.has(row.user_id)).map((row) => row.user_id),
  );
  const stakeUnits = BigInt(current.stake_units!);
  const attendeeCount = BigInt(attendingStakers.size);
  const flakerCount = BigInt(localStakes.length - attendingStakers.size);
  const expectedForfeit = attendeeCount === 0n ? 0n : stakeUnits * flakerCount;
  const forfeitShare = attendeeCount === 0n ? 0n : expectedForfeit / attendeeCount;
  const forfeitRemainder = attendeeCount === 0n ? 0n : expectedForfeit % attendeeCount;
  const expectedPayouts = new Map<string, string>();
  let attendeeIndex = 0n;
  for (const rsvp of remoteEvent.rsvps) {
    const local = members.get(rsvp.userId);
    if (!local) throw invalidCryptoUpstream();
    if (attendeeCount === 0n) {
      expectedPayouts.set(rsvp.userId, current.stake_units!);
    } else if (!attendingStakers.has(local.id)) {
      expectedPayouts.set(rsvp.userId, '0');
    } else {
      const basePayout = stakeUnits + forfeitShare + (attendeeIndex < forfeitRemainder ? 1n : 0n);
      const bonus = (basePayout * BigInt(expectedMultiplierBps - 10_000)) / 10_000n;
      expectedPayouts.set(rsvp.userId, String(basePayout + bonus));
      attendeeIndex += 1n;
    }
  }

  const seen = new Set<string>();
  const validated: Array<{ user_id: number; status: string; payout_units: string }> = [];
  if (
    !result ||
    result.eventId !== current.crypto_event_id ||
    result.status !== 'settled' ||
    !validCryptoInteger(result.forfeitPoolUnits) ||
    !Array.isArray(result.results) ||
    result.results.length !== expected.size
  ) {
    throw invalidCryptoUpstream();
  }
  for (const entry of result.results) {
    const local = entry && expected.get(entry.userId);
    const expectedStatus = local && attendingStakers.has(local.user_id)
      ? 'attended'
      : attendingStakers.size === 0 ? 'refunded' : 'flaked';
    if (
      !local ||
      seen.has(entry.userId) ||
      entry.status !== expectedStatus ||
      entry.stakedUnits !== current.stake_units ||
      !validCryptoInteger(entry.payoutUnits) ||
      entry.payoutUnits !== expectedPayouts.get(entry.userId)
    ) {
      throw invalidCryptoUpstream();
    }
    seen.add(entry.userId);
    validated.push({ user_id: local.user_id, status: entry.status, payout_units: entry.payoutUnits });
  }
  if (BigInt(result.forfeitPoolUnits) !== expectedForfeit) throw invalidCryptoUpstream();

  await store.publishSettlement(current.id, validated, nowIso(), complete);
  return (await store.hangoutById(current.id))!;
}

app.get('/hangouts', auth, async (c) => {
  const me = c.get('user').id;
  const rows = await c.get('store').hangoutsForUser(me);
  const hangouts = [];
  for (const h of rows) hangouts.push(await viewHangout(c, h, me));
  return jsonRes(c, { hangouts });
});

app.get('/hangouts/:id', auth, async (c) => {
  const me = c.get('user').id;
  const h = await c.get('store').hangoutById(parseId(c.req.param('id')));
  if (!h || !h.member_ids.includes(me)) return jsonRes(c, { error: 'Hangout not found' }, 404);
  return jsonRes(c, { hangout: await viewHangout(c, h, me) });
});

app.post('/hangouts/:id/photo', auth, async (c) => {
  const store = c.get('store');
  const me = c.get('user');
  const h = await store.hangoutById(parseId(c.req.param('id')));
  if (!h || !h.member_ids.includes(me.id)) return jsonRes(c, { error: 'Hangout not found' }, 404);

  // multer's diskStorage: 10 MB limit, 10 random bytes + the original extension.
  let file: File | null = null;
  const contentType = c.req.header('content-type') ?? '';
  if (/^multipart\/form-data\s*;/i.test(contentType.trim())) {
    try {
      const form = await c.req.raw.formData();
      const candidate = form.get('photo');
      if (candidate instanceof File) file = candidate;
    } catch {
      file = null;
    }
  }
  if (!file) return jsonRes(c, { error: 'No photo attached' }, 400);
  if (file.size > 10 * 1024 * 1024) throw new Error('File too large');

  const original = file.name || '';
  const dot = original.lastIndexOf('.');
  const ext = (dot > 0 ? original.slice(dot) : '.jpg').slice(0, 8);
  const filename = hex(10) + ext;
  await c.env.DATA.put(`uploads/${filename}`, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });

  await store.setPhoto(h.id, filename, me.id);
  await maybeComplete(store, h.id);
  return jsonRes(c, { hangout: await viewHangout(c, (await store.hangoutById(h.id))!, me.id) });
});

app.post('/hangouts/:id/end', auth, async (c) => {
  const store = c.get('store');
  const me = c.get('user');
  const h = await store.hangoutById(parseId(c.req.param('id')));
  if (!h || !h.member_ids.includes(me.id)) return jsonRes(c, { error: 'Hangout not found' }, 404);
  if (h.completed_at) return jsonRes(c, { hangout: await viewHangout(c, h, me.id) });
  if (new Date(h.date).getTime() > Date.now())
    return jsonRes(c, { error: 'Cannot end before the hangout starts' }, 400);
  if (!h.photo) return jsonRes(c, { error: 'Take the photo first, then end it' }, 400);

  try {
    const ended = await settleStakeAndMirror(c, h, attendeeIdSet(h), { complete: true });
    return jsonRes(c, { hangout: await viewHangout(c, ended, me.id) });
  } catch (error) {
    return sendCryptoError(c, error);
  }
});

app.get('/hangouts/:id/nfc-token', auth, async (c) => {
  const store = c.get('store');
  const me = c.get('user');
  const h = await store.hangoutById(parseId(c.req.param('id')));
  if (!h || !h.member_ids.includes(me.id)) return jsonRes(c, { error: 'Hangout not found' }, 404);
  const token = hex(6);
  await store.upsertNfcToken(h.id, me.id, token, Date.now() + 10 * 60 * 1000);
  return jsonRes(c, { payload: `TY1|${h.id}|${me.username}|${token}` });
});

app.post('/hangouts/:id/confirm', auth, async (c) => {
  const store = c.get('store');
  const cryptoApi = c.get('crypto');
  const me = c.get('user');
  const h = await store.hangoutById(parseId(c.req.param('id')));
  if (!h || !h.member_ids.includes(me.id)) return jsonRes(c, { error: 'Hangout not found' }, 404);
  const { username, token } = c.get('body') || {};
  const other = await store.userByUsername(asString(username));
  if (!other || !h.member_ids.includes(other.id))
    return jsonRes(c, { error: 'That person is not in this hangout' }, 400);
  if (other.id === me.id) return jsonRes(c, { error: 'Cannot confirm with yourself' }, 400);

  const [u1, u2] = pair(me.id, other.id);
  const already = h.confirms.some((cf) => cf.u1 === u1 && cf.u2 === u2);
  if (!already) {
    const t = h.nfc_tokens.find((entry) => entry.user_id === other.id);
    if (!t || t.token !== token || t.expires_at < Date.now())
      return jsonRes(c, { error: 'Tap not valid, try again' }, 400);
  }
  let vibeGain = 0;
  let acornGain = 0;
  if (!already) {
    const inserted = await store.pushConfirm(h.id, u1, u2, nowIso());
    if (inserted) {
      const f = await store.friendship(u1, u2);
      if (f) {
        vibeGain = Math.round(VIBE_PER_CONFIRM * h.bonus_mult);
        const before = level(f.vibe);
        const after = level(f.vibe + vibeGain);
        await store.incVibe(f.id, vibeGain);
        if (after > before) {
          acornGain = ACORNS_PER_LEVEL * (after - before);
          await store.incAcorns([u1, u2], acornGain);
        }
      }
      await maybeComplete(store, h.id);
    }
  }
  // Retry attendance sync even when this confirmation already existed (for
  // example because a previous crypto response was lost).
  if (h.crypto_event_id) {
    const fresh = (await store.hangoutById(h.id))!;
    const stakedIds = new Set(fresh.stakes.map((s) => s.user_id));
    try {
      for (const [uid, uname] of [[me.id, me.username], [other.id, other.username]] as const) {
        if (stakedIds.has(uid as number)) await cryptoApi.checkin(h.crypto_event_id, uname as string);
      }
    } catch (error) {
      return sendCryptoError(c, error);
    }
  }
  return jsonRes(c, {
    hangout: await viewHangout(c, (await store.hangoutById(h.id))!, me.id),
    vibeGain,
    acornGain,
    bonusReason: h.bonus_reason,
  });
});

// ------------------------------------------------------------ memory book --

app.get('/memories', auth, async (c) => {
  const me = c.get('user').id;
  const rows = await c.get('store').completedHangoutsForUser(me);
  const memories = [];
  for (const h of rows) memories.push(await viewHangout(c, h, me));
  return jsonRes(c, { memories });
});

// ------------------------------------------------------------ leaderboard --

app.get('/leaderboard', auth, async (c) => {
  const store = c.get('store');
  const me = c.get('user').id;
  const fr = await store.friendshipsForUser(me, true);
  const ids = [me, ...fr.map((f) => (f.a_id === me ? f.b_id : f.a_id))];
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const rows = [];
  for (const id of ids) {
    const u = (await store.userById(id))!;
    const count = await store.countCompletedSince(id, monthStart.toISOString());
    rows.push({ ...publicUser(u), count, isMe: id === me });
  }
  rows.sort((x, y) => y.count - x.count);
  return jsonRes(c, { leaderboard: rows, month: monthStart.toISOString().slice(0, 7) });
});

// --------------------------------------------------------------- wardrobe --

app.post('/shop/buy', auth, async (c) => {
  const store = c.get('store');
  const me = c.get('user');
  const item = ITEMS.find((i) => i.id === c.get('body')?.itemId);
  if (!item) return jsonRes(c, { error: 'No such item' }, 404);
  const owned = safeJsonArray(me.owned);
  if (owned.includes(item.id)) return jsonRes(c, { error: 'Already owned' }, 409);
  if (me.acorns < item.price) return jsonRes(c, { error: 'Not enough acorns' }, 400);
  await store.buyItem(me.id, item.id, item.price);
  return jsonRes(c, { me: meView((await store.userById(me.id))!) });
});

// Easter egg: tapping the Leaderboard title rains acorns. Sshh.
app.post('/secret/acorns', auth, async (c) => {
  const store = c.get('store');
  const me = c.get('user');
  await store.incAcorns([me.id], 10);
  return jsonRes(c, { me: meView((await store.userById(me.id))!) });
});

// ----------------------------------------------------------------- wallet --

app.get('/wallet', auth, async (c) => {
  const cryptoApi = c.get('crypto');
  if (!(await cryptoApi.ready())) return jsonRes(c, { enabled: false });
  try {
    const w = await cryptoApi.getWallet(c.get('user').username);
    return jsonRes(c, {
      enabled: true,
      balanceUnits: w.balanceUnits,
      readyToCashOut: w.readyToCashOut,
      cashoutThresholdUnits: w.cashoutThresholdUnits,
      withdrawals: w.withdrawals,
    });
  } catch (e) {
    return sendCryptoError(c, e);
  }
});

app.post('/wallet/add-funds', auth, async (c) => {
  try {
    return jsonRes(c, await c.get('crypto').addFunds(c.get('user').username));
  } catch (e) {
    return sendCryptoError(c, e);
  }
});

app.post('/wallet/refresh', auth, async (c) => {
  try {
    return jsonRes(c, await c.get('crypto').refreshDeposits(c.get('user').username));
  } catch (e) {
    return sendCryptoError(c, e);
  }
});

app.post('/wallet/withdraw', auth, async (c) => {
  const { amountUnits, destination } = c.get('body') || {};
  // Express counted raw Idempotency-Key headers; workerd merges repeats into one
  // comma-joined value. Both a repeated header and a comma inside a single value
  // are rejected here, and the Express build answered 400 with this same body in
  // both cases too — so the observable behaviour is identical.
  const raw = c.req.header('idempotency-key') ?? null;
  const key = raw === null || raw.includes(',') ? null : raw;
  const { validIdempotencyKey } = await import('./crypto/client');
  if (key === null || !validIdempotencyKey(key)) {
    return jsonRes(c, {
      error: 'invalid_idempotency_key',
      message: 'Exactly one valid Idempotency-Key header is required (8-128 characters).',
    }, 400);
  }
  try {
    const result = await c.get('crypto').withdraw(c.get('user').username, amountUnits, destination, key);
    return jsonRes(c, result.data, result.status);
  } catch (e) {
    return sendCryptoError(c, e);
  }
});

app.get('/health', (c) => jsonRes(c, { ok: true, name: 'tomo-yard' }));

// ------------------------------------------------------------ world ticket --

app.post('/world/ws-ticket', auth, async (c) => {
  const stub = c.env.WORLD.get(c.env.WORLD.idFromName('world'));
  const res = await stub.fetch('https://world/issue-ticket', {
    method: 'POST',
    body: JSON.stringify({ userId: c.get('user').id }),
    headers: { 'content-type': 'application/json' },
  });
  const { ticket } = (await res.json()) as { ticket: string };
  return json(c.req.raw.headers, c.req.method, { ticket }, {
    headers: { 'cache-control': 'no-store' },
  });
});

// ------------------------------------------------------- APK + static tail --

app.get('/apk', async (c) => {
  // CI drops the freshly built APK into apk/ (was DATA_DIR/apk, outside wwwroot).
  const served = await serveObject(c.env.DATA, 'apk/tomo-yard.apk', c.req.raw, {
    downloadName: 'tomo-yard.apk',
  });
  return served ?? (await jsonRes(c, { error: 'APK not built yet' }, 404));
});

app.get('/apk/version', async (c) => {
  const object = await c.env.DATA.get('apk/version.json');
  if (!object) return jsonRes(c, { error: 'No version info yet' }, 404);
  // res.type('json').send(<file contents>) — the file's own bytes, not a re-encode.
  return sendBody(c.req.raw.headers, c.req.method, new Uint8Array(await object.arrayBuffer()), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
});

// ------------------------------------------------------------- error tails --

app.notFound((c) => notFoundResponse(c.req.method, new URL(c.req.url).pathname));

// Keep error responses stable and non-sensitive, preserving a Bearer challenge on
// 401 so clients can prompt for sign-in.
app.onError(async (error: any, c) => {
  const status = Number(error && (error.statusCode || error.status));
  if (status === 401 || status === 403) {
    return json(
      c.req.raw.headers,
      c.req.method,
      {
        error: error.code || (status === 401 ? 'invalid_token' : 'forbidden'),
        message: status === 401 ? 'Authentication required' : 'Access forbidden',
      },
      { status, headers: status === 401 ? { 'www-authenticate': 'Bearer' } : {} },
    );
  }
  console.error(error);
  return json(
    c.req.raw.headers,
    c.req.method,
    { error: 'server_error', message: 'Internal server error' },
    { status: 500 },
  );
});

export { canonicalizePath };
