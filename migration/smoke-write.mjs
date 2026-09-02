// Authenticated end-to-end exercise of the migrated stack.
//
//   node migration/smoke-write.mjs
//
// The contract suites are read-only by design (SPEC 9.4: registering on the
// LIVE service provisions an undeletable custody wallet), so nothing in them
// ever gets past the auth gate. This script covers the happy paths instead, and
// it is safe because it only ever touches the *migrated* D1 copies and the
// *migrated* R2 bucket — Azure and Atlas are never contacted. Every row it
// creates carries a `ctest_` prefix and is removed by migration/smoke-clean.sql.
//
// Covered: register -> login -> me -> avatar -> interests -> search -> friend
// request/accept -> friends list/profile/card -> duels -> ranked activities ->
// suggestions -> hangout create -> photo upload (R2) -> /uploads round-trip ->
// nfc token -> confirm -> memories -> leaderboard -> shop -> secret -> wallet
// (which proves app -> custody -> custody D1) -> world ws-ticket -> WebSocket.
import tls from 'node:tls';

const APP = process.env.APP_URL ?? 'https://tomo-together-api.cloudflare-disjoin783.workers.dev';
const suffix = process.env.SMOKE_SUFFIX ?? String(Date.now()).slice(-6);
const A = `ctest_a${suffix}`;
const B = `ctest_b${suffix}`;

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

async function call(method, path, { token, body, raw, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(APP + path, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

console.log(`accounts: ${A}, ${B}`);

// ---------------------------------------------------------------- accounts --
const regA = await call('POST', '/auth/register', {
  body: { username: A, name: 'Ctest A', birthday: '2000-01-01', password: 'hunter22', species: 'frog', interests: ['ramen', 'boba'] },
});
check('register A', regA.status === 200 && typeof regA.json?.token === 'string', regA.json);
const tokenA = regA.json?.token;

const regB = await call('POST', '/auth/register', {
  body: { username: B, name: 'Ctest B', birthday: '1999-12-25', password: 'hunter22' },
});
check('register B', regB.status === 200, regB.json);
let tokenB = regB.json?.token;

check('register is idempotent-hostile (409 on repeat)',
  (await call('POST', '/auth/register', { body: { username: A, name: 'x', birthday: '2000-01-01', password: 'hunter22' } })).status === 409);

const login = await call('POST', '/auth/login', { body: { username: A, password: 'hunter22' } });
check('login returns the same token', login.status === 200 && login.json.token === tokenA, login.json);
check('login rejects a wrong password',
  (await call('POST', '/auth/login', { body: { username: A, password: 'nope123' } })).status === 401);

const me = await call('GET', '/me', { token: tokenA });
check('GET /me', me.status === 200 && me.json.me.username === A && me.json.me.acorns === 50, me.json);
check('registered species survived', me.json?.me?.species === 'frog', me.json?.me);
check('interests were sanitised', JSON.stringify(me.json?.me?.interests) === '["ramen","boba"]', me.json?.me);

const interests = await call('PUT', '/me/interests', { token: tokenA, body: { interests: ['sushi', 'nope', 'sushi', 'gym'] } });
check('PUT /me/interests dedupes and filters',
  JSON.stringify(interests.json?.me?.interests) === '["sushi","gym"]', interests.json?.me);

const avatar = await call('PUT', '/me/avatar', { token: tokenA, body: { color: '#123456', species: 'duck', equipped: ['crown'] } });
check('PUT /me/avatar drops unowned items',
  avatar.json?.me?.color === '#123456' && avatar.json?.me?.species === 'duck' &&
  JSON.stringify(avatar.json?.me?.equipped) === '[]', avatar.json?.me);

// ----------------------------------------------------------------- friends --
const search = await call('GET', `/users/search?q=${B.slice(0, 8)}`, { token: tokenA });
check('GET /users/search finds B', search.json?.users?.some((u) => u.username === B), search.json);

check('friend request', (await call('POST', '/friends/request', { token: tokenA, body: { username: B } })).status === 200);
check('duplicate friend request is 409',
  (await call('POST', '/friends/request', { token: tokenA, body: { username: B } })).status === 409);
check('accept', (await call('POST', '/friends/accept', { token: tokenB, body: { username: A } })).status === 200);

const friends = await call('GET', '/friends', { token: tokenA });
check('GET /friends lists the accepted friend',
  friends.json?.friends?.length === 1 && friends.json.friends[0].username === B, friends.json);
check('a brand-new friendship is titled "New friend"',
  friends.json?.friends?.[0]?.title === 'New friend', friends.json?.friends?.[0]);

const profile = await call('GET', `/friends/${B}`, { token: tokenA });
check('GET /friends/:username', profile.status === 200 && profile.json.friend.username === B, profile.json);
const card = await call('GET', `/friends/${B}/card`, { token: tokenA });
check('GET /friends/:username/card', card.status === 200 && card.json.card.username === B, card.json);

// --------------------------------------------------------- duels + ranking --
check('duel', (await call('POST', '/duels', { token: tokenA, body: { winner: 'ramen', loser: 'gym' } })).status === 200);
const ranked = await call('GET', '/activities/ranked', { token: tokenA });
check('GET /activities/ranked is sorted', ranked.json?.activities?.[0]?.combined >= ranked.json?.activities?.at(-1)?.combined);
const suggestion = await call('GET', '/suggestions', { token: tokenA });
check('GET /suggestions proposes the new friend', suggestion.json?.suggestion?.friend?.username === B, suggestion.json);

// ---------------------------------------------------------------- hangouts --
const past = new Date(Date.now() - 3600_000).toISOString();
const created = await call('POST', '/hangouts', {
  token: tokenA,
  body: { activity: 'ramen', date: past, place: 'ctest', friendUsernames: [B] },
});
check('POST /hangouts', created.status === 200 && typeof created.json.hangout.id === 'number', created.json);
const hid = created.json?.hangout?.id;
check('hangout members are ordered creator-first',
  created.json?.hangout?.members?.[0]?.username === A, created.json?.hangout?.members);

// multipart photo upload -> R2
const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const form = new FormData();
form.append('photo', new File([png], 'proof.png', { type: 'image/png' }));
const uploaded = await fetch(`${APP}/hangouts/${hid}/photo`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${tokenA}` },
  body: form,
});
const uploadedJson = await uploaded.json();
check('POST /hangouts/:id/photo', uploaded.status === 200 && typeof uploadedJson.hangout.photoUrl === 'string', uploadedJson);
const photoUrl = uploadedJson?.hangout?.photoUrl;
check('the photo filename keeps its extension', /^\/uploads\/[0-9a-f]{20}\.png$/.test(photoUrl ?? ''), photoUrl);
if (photoUrl) {
  const fetched = await fetch(APP + photoUrl);
  const bytes = new Uint8Array(await fetched.arrayBuffer());
  check('the uploaded photo round-trips through R2',
    fetched.status === 200 && bytes.length === png.length && bytes.every((b, i) => b === png[i]),
    { status: fetched.status, length: bytes.length });
  check('the uploaded photo has static headers',
    fetched.headers.get('cache-control') === 'public, max-age=0' &&
    fetched.headers.get('accept-ranges') === 'bytes' &&
    !!fetched.headers.get('etag'));
}

// NFC handshake
const nfc = await call('GET', `/hangouts/${hid}/nfc-token`, { token: tokenB });
check('GET /hangouts/:id/nfc-token', /^TY1\|\d+\|ctest_b/.test(nfc.json?.payload ?? ''), nfc.json);
const nfcToken = nfc.json?.payload?.split('|')?.[3];
check('a wrong tap is rejected',
  (await call('POST', `/hangouts/${hid}/confirm`, { token: tokenA, body: { username: B, token: 'deadbeef' } })).status === 400);
const confirmed = await call('POST', `/hangouts/${hid}/confirm`, { token: tokenA, body: { username: B, token: nfcToken } });
check('POST /hangouts/:id/confirm awards vibe',
  confirmed.status === 200 && confirmed.json.vibeGain === 15, confirmed.json);
check('the confirmed pair is visible',
  JSON.stringify(confirmed.json?.hangout?.confirmedPairs) === JSON.stringify([[A, B]]), confirmed.json?.hangout);
check('an all-pairs + photo hangout auto-completes',
  typeof confirmed.json?.hangout?.completedAt === 'string', confirmed.json?.hangout);
check('confirming twice is idempotent',
  (await call('POST', `/hangouts/${hid}/confirm`, { token: tokenA, body: { username: B, token: nfcToken } })).json?.vibeGain === 0);

const memories = await call('GET', '/memories', { token: tokenA });
check('GET /memories', memories.json?.memories?.some((m) => m.id === hid), memories.json);
const board = await call('GET', '/leaderboard', { token: tokenA });
check('GET /leaderboard counts both players', board.json?.leaderboard?.length === 2, board.json);

// ---------------------------------------------------------------- wardrobe --
check('buying beyond your acorns is refused',
  (await call('POST', '/shop/buy', { token: tokenA, body: { itemId: 'crown' } })).status === 400);
const bought = await call('POST', '/shop/buy', { token: tokenA, body: { itemId: 'bowtie' } });
check('POST /shop/buy debits acorns',
  bought.status === 200 && bought.json.me.acorns === 10 && bought.json.me.owned.includes('bowtie'), bought.json?.me);
const secret = await call('POST', '/secret/acorns', { token: tokenA });
check('POST /secret/acorns', secret.json?.me?.acorns === 20, secret.json?.me);

// ------------------------------------------------------------------ wallet --
const wallet = await call('GET', '/wallet', { token: tokenA });
check('GET /wallet reaches the custody Worker',
  wallet.status === 200 && wallet.json.enabled === true && wallet.json.balanceUnits === '0', wallet.json);
check('the cash-out threshold comes from custody config',
  wallet.json?.cashoutThresholdUnits === '3000000', wallet.json);
check('withdraw without a valid Idempotency-Key is a 400',
  (await call('POST', '/wallet/withdraw', { token: tokenA, body: { amountUnits: '1' } })).json?.error === 'invalid_idempotency_key');

// ------------------------------------------------------------------- world --
const ticket = await call('POST', '/world/ws-ticket', { token: tokenA });
check('POST /world/ws-ticket', typeof ticket.json?.ticket === 'string' && ticket.headers.get('cache-control') === 'no-store', ticket.json);

if (ticket.json?.ticket) {
  const wsUrl = `${APP.replace(/^https/, 'wss')}/ws?ticket=${encodeURIComponent(ticket.json.ticket)}`;
  const frames = await new Promise((resolve) => {
    const out = [];
    const ws = new WebSocket(wsUrl);
    const done = () => {
      try { ws.close(); } catch {}
      resolve(out);
    };
    const timer = setTimeout(done, 8000);
    ws.addEventListener('message', (e) => {
      out.push(JSON.parse(e.data));
      if (out.length >= 1) {
        ws.send(JSON.stringify({ type: 'move', x: 1234, y: 567 }));
        setTimeout(() => { clearTimeout(timer); done(); }, 1500);
      }
    });
    ws.addEventListener('error', () => { clearTimeout(timer); done(); });
  });
  const init = frames.find((f) => f.type === 'init');
  check('the world socket accepts a valid ticket and sends init', !!init, frames);
  check('init carries the world size and the caller identity',
    init?.world?.w === 2400 && init?.world?.h === 1800 && init?.me === A, init);
  // undici refuses to send an Upgrade header, so the replay uses a raw socket.
  const replay = await new Promise((resolve) => {
    const target = new URL(wsUrl.replace(/^wss/, 'https'));
    const CRLF = String.fromCharCode(13, 10);
    const request =
      `GET ${target.pathname}${target.search} HTTP/1.1${CRLF}` +
      `Host: ${target.host}${CRLF}` +
      `Upgrade: websocket${CRLF}Connection: Upgrade${CRLF}` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==${CRLF}` +
      `Sec-WebSocket-Version: 13${CRLF}${CRLF}`;
    const socket = tls.connect(
      { host: target.hostname, port: 443, servername: target.hostname },
      () => socket.write(request),
    );
    let buf = '';
    const done = () => { socket.destroy(); resolve(buf.split(CRLF)[0]); };
    socket.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes(CRLF + CRLF)) done();
    });
    socket.on('error', () => done());
    setTimeout(done, 8000);
  });
  check('the ticket is single-use', /^HTTP\/1\.1 401/.test(replay), replay);
}

console.log(failures === 0 ? '\nall smoke checks passed' : `\n${failures} smoke check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
