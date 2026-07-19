// Tomo Yard server: accounts, friends, hangouts, vibe, wardrobe, leaderboard.
const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { WebSocketServer } = require('ws');
const {
  AuthConfigurationError,
  bindAuth0Subject,
  classifyBearerToken,
  createAuth0JwtMiddleware,
  getBearerToken,
  isLegacyAuthEnabled,
  isLegacyTokenAllowed,
} = require('./auth0');

const PORT = process.env.PORT || 4000;
// DATA_DIR is overridable so hosted deploys can keep state outside the app dir
// (on Azure App Service, /home/data survives redeploys while wwwroot does not).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'tomoyard.sqlite'));
// WAL needs shared memory and cannot work on network mounts (App Service /home);
// set SQLITE_JOURNAL=delete there.
db.pragma(`journal_mode = ${process.env.SQLITE_JOURNAL || 'WAL'}`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  birthday TEXT NOT NULL,         -- YYYY-MM-DD
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  auth0_sub TEXT,
  acorns INTEGER NOT NULL DEFAULT 50,
  color TEXT NOT NULL DEFAULT '#A8D8C8',
  owned TEXT NOT NULL DEFAULT '[]',     -- JSON array of item ids
  equipped TEXT NOT NULL DEFAULT '[]',  -- JSON array of item ids
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS weights (
  user_id INTEGER NOT NULL,
  activity TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 50,
  PRIMARY KEY (user_id, activity)
);
CREATE TABLE IF NOT EXISTS friendships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  a_id INTEGER NOT NULL,          -- a_id < b_id
  b_id INTEGER NOT NULL,
  status TEXT NOT NULL,           -- pending | accepted
  requested_by INTEGER NOT NULL,
  vibe INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (a_id, b_id)
);
CREATE TABLE IF NOT EXISTS hangouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL,
  activity TEXT NOT NULL,
  activity_label TEXT NOT NULL,
  date TEXT NOT NULL,             -- ISO datetime
  place TEXT NOT NULL,
  bonus_mult REAL NOT NULL DEFAULT 1,
  bonus_reason TEXT,
  photo TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hangout_members (
  hangout_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (hangout_id, user_id)
);
CREATE TABLE IF NOT EXISTS confirms (
  hangout_id INTEGER NOT NULL,
  u1 INTEGER NOT NULL,            -- u1 < u2
  u2 INTEGER NOT NULL,
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY (hangout_id, u1, u2)
);
CREATE TABLE IF NOT EXISTS nfc_tokens (
  hangout_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (hangout_id, user_id)
);
`);

const SPECIES = ['cat', 'bear', 'bunny', 'frog', 'duck'];
// existing databases get the new column on startup
try {
  db.exec(`ALTER TABLE users ADD COLUMN species TEXT NOT NULL DEFAULT 'cat'`);
} catch {
  // column already exists
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN auth0_sub TEXT`);
} catch {
  // column already exists
}
// Auth0 identities are linked exclusively by the provider's stable `sub`.
// Legacy rows intentionally remain null and therefore do not participate.
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_auth0_sub_unique
  ON users(auth0_sub) WHERE auth0_sub IS NOT NULL`);

// --- walkable world position (safe on existing DBs) ---
for (const stmt of [
  `ALTER TABLE users ADD COLUMN pos_x REAL`,
  `ALTER TABLE users ADD COLUMN pos_y REAL`,
]) {
  try { db.exec(stmt); } catch { /* column exists */ }
}

// --- crypto staking columns/tables (safe on existing DBs) ---
for (const stmt of [
  `ALTER TABLE hangouts ADD COLUMN stake_units TEXT`,        // USDC base units, null = no stake
  `ALTER TABLE hangouts ADD COLUMN crypto_event_id TEXT`,    // Unifold event id
  `ALTER TABLE hangouts ADD COLUMN settled_at TEXT`,
  `ALTER TABLE hangouts ADD COLUMN photo_by INTEGER`,        // who took the photo = proof they showed
  `ALTER TABLE users ADD COLUMN interests TEXT NOT NULL DEFAULT '[]'`, // JSON array of activity ids
]) {
  try { db.exec(stmt); } catch { /* column exists */ }
}
// small key/value store for one-time migrations
db.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)`);
db.exec(`
CREATE TABLE IF NOT EXISTS hangout_stakes (
  hangout_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  staked_at TEXT NOT NULL,
  PRIMARY KEY (hangout_id, user_id)
);
CREATE TABLE IF NOT EXISTS hangout_settlements (
  hangout_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL,        -- attended | flaked | refunded
  payout_units TEXT NOT NULL,
  PRIMARY KEY (hangout_id, user_id)
);
`);

const cryptoApi = require('./crypto');

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function sendCryptoError(res, error) {
  if (error instanceof cryptoApi.CryptoUnavailableError) {
    return res.status(503).json({ error: error.code, message: error.message });
  }
  if (error instanceof cryptoApi.CryptoError) {
    const status = [400, 403, 404, 409].includes(error.status) ? error.status :
      error.status === 503 ? 503 : 502;
    return res.status(status).json({
      error: status === 502 ? 'crypto_upstream_failed' : error.code,
      message: status === 502 ? 'Crypto service request failed. Please try again.' : error.message,
    });
  }
  console.error('[crypto] unexpected proxy failure', {
    name: error && error.name,
    status: error && error.status,
  });
  return res.status(502).json({
    error: 'crypto_upstream_failed',
    message: 'Crypto service request failed. Please try again.',
  });
}

function cryptoEventRsvp(event, username) {
  if (!event || !Array.isArray(event.rsvps)) return null;
  return event.rsvps.find((rsvp) => rsvp && rsvp.userId === cryptoApi.extId(username)) || null;
}

// Activities double as interests. Grouped by category for the picker UI; the
// original twelve ids are kept so existing weights/hangouts/interests stay valid.
const ACTIVITY_GROUPS = [
  ['Food & Drink', [
    ['ramen', 'Ramen'], ['sushi', 'Sushi'], ['tacos', 'Tacos'], ['bbq', 'BBQ'],
    ['brunch', 'Brunch'], ['coffee', 'Coffee'], ['boba', 'Bubble Tea'],
    ['dessert', 'Dessert Run'], ['cooking', 'Cooking Together'], ['baking', 'Baking'],
    ['winenight', 'Wine Night'], ['brewery', 'Brewery'],
  ]],
  ['Outdoors', [
    ['hiking', 'Hiking'], ['picnic', 'Picnic'], ['beach', 'Beach Day'],
    ['camping', 'Camping'], ['fishing', 'Fishing'], ['kayaking', 'Kayaking'],
    ['stargazing', 'Stargazing'], ['gardening', 'Gardening'], ['roadtrip', 'Road Trip'],
  ]],
  ['Active & Sports', [
    ['gym', 'Gym'], ['yoga', 'Yoga'], ['running', 'Running'], ['cycling', 'Cycling'],
    ['climbing', 'Climbing'], ['basketball', 'Basketball'], ['soccer', 'Soccer'],
    ['tennis', 'Tennis'], ['volleyball', 'Volleyball'], ['swimming', 'Swimming'],
    ['skiing', 'Skiing'], ['surfing', 'Surfing'], ['skating', 'Skating'], ['bowling', 'Bowling'],
  ]],
  ['Games & Play', [
    ['boardgames', 'Board Games'], ['videogames', 'Video Games'], ['arcade', 'Arcade'],
    ['escaperoom', 'Escape Room'], ['lasertag', 'Laser Tag'], ['minigolf', 'Mini Golf'],
    ['trivia', 'Trivia Night'], ['chess', 'Chess'], ['ttrpg', 'D&D Night'], ['karting', 'Go Karting'],
  ]],
  ['Arts & Culture', [
    ['museum', 'Museum'], ['artgallery', 'Art Gallery'], ['theater', 'Theater'],
    ['pottery', 'Pottery'], ['painting', 'Painting'], ['photography', 'Photography'],
    ['bookcafe', 'Book Cafe'], ['bookclub', 'Book Club'],
  ]],
  ['Music & Nightlife', [
    ['karaoke', 'Karaoke'], ['concert', 'Concert'], ['livemusic', 'Live Music'],
    ['dancing', 'Dancing'], ['barhopping', 'Bar Hopping'], ['comedy', 'Comedy Show'],
  ]],
  ['Chill & Social', [
    ['film', 'Movie Night'], ['anime', 'Anime Night'], ['shopping', 'Shopping'],
    ['thrifting', 'Thrifting'], ['spa', 'Spa Day'], ['cafe', 'Cafe Hangout'],
    ['volunteering', 'Volunteering'], ['petpark', 'Dog Park'],
    ['amusementpark', 'Amusement Park'], ['aquarium', 'Aquarium'],
  ]],
];
const ACTIVITIES = ACTIVITY_GROUPS.flatMap(([category, items]) =>
  items.map(([id, label]) => ({ id, label, category })));

// ---------- interests (stated activity preferences) ----------
// An interest is one of the activity ids above. It gives that activity a lift in
// every ranking (suggestions + the activity tree), on top of the learned duel
// weights, and shows on your profile.
const INTEREST_BOOST = 15;
const ACTIVITY_IDS = new Set(ACTIVITIES.map((a) => a.id));
const labelOf = (id) => (ACTIVITIES.find((a) => a.id === id) || {}).label;

function safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sanitizeInterests(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) if (ACTIVITY_IDS.has(x) && !out.includes(x)) out.push(x);
  return out.slice(0, 12);
}
function interestsOf(u) {
  return sanitizeInterests(safeJsonArray(u && u.interests));
}
function interestSetOf(userId) {
  const u = db.prepare('SELECT interests FROM users WHERE id = ?').get(userId);
  return new Set(u ? interestsOf(u) : []);
}

// One-time: give accounts that predate this feature a starter set of interests
// drawn from the activities they've already upvoted (falling back to popular
// picks), so their profiles and suggestions aren't blank. Guarded by app_meta so
// a user who later clears their interests on purpose stays cleared.
function seedInterestsForExistingUsers() {
  if (db.prepare('SELECT 1 FROM app_meta WHERE key = ?').get('interests_seeded')) return;
  const DEFAULTS = ['ramen', 'boba', 'film', 'boardgames', 'karaoke'];
  const users = db.prepare("SELECT id FROM users WHERE interests IS NULL OR interests = '[]'").all();
  const set = db.prepare('UPDATE users SET interests = ? WHERE id = ?');
  const seedOne = db.transaction(() => {
    for (const u of users) {
      const liked = db.prepare(
        'SELECT activity FROM weights WHERE user_id = ? AND weight > 52 ORDER BY weight DESC LIMIT 6'
      ).all(u.id).map((r) => r.activity).filter((a) => ACTIVITY_IDS.has(a));
      const picks = [...liked];
      for (const d of DEFAULTS) { if (picks.length >= 3) break; if (!picks.includes(d)) picks.push(d); }
      set.run(JSON.stringify(picks), u.id);
    }
    db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run('interests_seeded', '1');
  });
  seedOne();
}
seedInterestsForExistingUsers();

const ITEMS = [
  { id: 'party_hat', name: 'Party Hat', price: 60 },
  { id: 'beanie', name: 'Beanie', price: 50 },
  { id: 'flower_crown', name: 'Flower Crown', price: 80 },
  { id: 'crown', name: 'Crown', price: 150 },
  { id: 'round_glasses', name: 'Round Glasses', price: 40 },
  { id: 'star_glasses', name: 'Star Glasses', price: 70 },
  { id: 'sunglasses', name: 'Sunglasses', price: 55 },
  { id: 'scarf', name: 'Scarf', price: 45 },
  { id: 'bowtie', name: 'Bow Tie', price: 40 },
  { id: 'wizard_hat', name: 'Wizard Hat', price: 120 },
  { id: 'cowboy_hat', name: 'Cowboy Hat', price: 90 },
  { id: 'chef_hat', name: "Chef's Puff", price: 75 },
  { id: 'halo', name: 'Halo', price: 160 },
  { id: 'cat_ears', name: 'Cat Ears', price: 65 },
  { id: 'propeller_cap', name: 'Propeller Cap', price: 85 },
  { id: 'viking_helm', name: 'Viking Helm', price: 150 },
  { id: 'monocle', name: 'Fancy Monocle', price: 95 },
  { id: 'eyepatch', name: 'Pirate Patch', price: 60 },
  { id: 'heart_glasses', name: 'Heart Shades', price: 70 },
  { id: 'ski_goggles', name: 'Ski Goggles', price: 80 },
  { id: 'bandana', name: 'Bandana', price: 40 },
  { id: 'bell_collar', name: 'Jingle Collar', price: 55 },
  { id: 'bow_ribbon', name: 'Big Bow', price: 65 },
];

// Fixed-date holidays (month, day). Bonus multiplies vibe gains.
const HOLIDAYS = [
  { month: 1, day: 1, label: 'New Year' },
  { month: 2, day: 14, label: 'Valentines' },
  { month: 7, day: 30, label: 'Friendship Day' },
  { month: 10, day: 31, label: 'Halloween' },
  { month: 12, day: 25, label: 'Christmas' },
  { month: 12, day: 31, label: 'New Years Eve' },
];

const VIBE_PER_CONFIRM = 15;
const VIBE_PER_LEVEL = 60;
const ACORNS_PER_LEVEL = 30;

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Idempotency-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));
// react-native-web clone of the app: CI exports the same src/ to static files and
// drops them in DATA_DIR/webapp; we serve them for the ht6-app.* host only.
const WEB_HOST = process.env.WEB_HOST || 'ht6-app.icinoxis.net';
const WEB_DIR = path.join(DATA_DIR, 'webapp');
const webStatic = express.static(WEB_DIR);
app.use((req, res, next) => {
  if (req.hostname !== WEB_HOST) return next();
  webStatic(req, res, () => {
    // SPA fallback: any non-file GET gets the app shell.
    const shell = path.join(WEB_DIR, 'index.html');
    if (req.method === 'GET' && fs.existsSync(shell)) return res.sendFile(shell);
    next();
  });
});
// Marketing homepage (server/public) + APK download.
app.use(express.static(path.join(__dirname, 'public')));
app.get('/apk', (_req, res) => {
  // CI drops the freshly built APK into DATA_DIR/apk (outside wwwroot).
  const apk = path.join(DATA_DIR, 'apk', 'tomo-yard.apk');
  if (!fs.existsSync(apk)) return res.status(404).json({ error: 'APK not built yet' });
  res.download(apk, 'tomo-yard.apk');
});
// Version metadata for the in-app updater; CI writes version.json with the APK.
app.get('/apk/version', (_req, res) => {
  const f = path.join(DATA_DIR, 'apk', 'version.json');
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'No version info yet' });
  res.type('json').send(fs.readFileSync(f, 'utf8'));
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').slice(0, 8);
      cb(null, crypto.randomBytes(10).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ---------- helpers ----------
const now = () => new Date().toISOString();
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
const pair = (x, y) => (x < y ? [x, y] : [y, x]);
const level = (vibe) => Math.floor(vibe / VIBE_PER_LEVEL) + 1;

let auth0JwtMiddleware = null;
let auth0ConfigurationError = null;
try {
  auth0JwtMiddleware = createAuth0JwtMiddleware();
} catch (error) {
  auth0ConfigurationError = error;
}

function publicUser(u) {
  return {
    username: u.username,
    name: u.name,
    color: u.color,
    species: u.species,
    equipped: safeJsonArray(u.equipped),
  };
}

function notSignedIn(res) {
  res.setHeader('WWW-Authenticate', 'Bearer');
  return res.status(401).json({ error: 'Not signed in' });
}

function requireLegacyAuthEnabled(_req, res, next) {
  if (!isLegacyAuthEnabled()) {
    return res.status(403).json({ error: 'Legacy authentication is disabled' });
  }
  next();
}

// JWT-only identity validation for profile discovery/onboarding. This path is
// deliberately separate from legacy auth: even a malformed JWT is verified as
// a JWT and can never fall back to a database token lookup.
function auth0Identity(req, res, next) {
  const token = getBearerToken(req);
  if (classifyBearerToken(token) !== 'jwt') return notSignedIn(res);
  if (auth0ConfigurationError) return next(auth0ConfigurationError);
  if (!auth0JwtMiddleware) {
    return next(new AuthConfigurationError('Auth0 JWT verification is unavailable'));
  }
  auth0JwtMiddleware(req, res, (error) => {
    if (error) return next(error);
    bindAuth0Subject(req, res, next);
  });
}

function requireAuth0Profile(req, res, next) {
  const user = db.prepare('SELECT * FROM users WHERE auth0_sub = ?').get(req.auth0Sub);
  if (!user) return res.status(409).json({ error: 'PROFILE_REQUIRED' });
  req.user = user;
  next();
}

function auth(req, res, next) {
  const token = getBearerToken(req);
  const kind = classifyBearerToken(token);

  if (kind === 'legacy') {
    if (!isLegacyTokenAllowed(token)) return notSignedIn(res);
    const user = db.prepare('SELECT * FROM users WHERE token = ? AND auth0_sub IS NULL').get(token);
    if (!user) return notSignedIn(res);
    req.user = user;
    return next();
  }

  if (kind === 'jwt') {
    return auth0Identity(req, res, (error) => {
      if (error) return next(error);
      requireAuth0Profile(req, res, next);
    });
  }

  return notSignedIn(res);
}

function bonusFor(dateISO, memberIds) {
  const d = new Date(dateISO);
  const hol = HOLIDAYS.find((h) => h.month === d.getMonth() + 1 && h.day === d.getDate());
  if (hol) return { mult: 2, reason: hol.label };
  const mmdd = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  for (const id of memberIds) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (u && u.birthday.slice(5) === mmdd) {
      return { mult: 2, reason: `${u.name}'s birthday` };
    }
  }
  return { mult: 1, reason: null };
}

function friendship(meId, otherId) {
  const [a, b] = pair(meId, otherId);
  return db.prepare('SELECT * FROM friendships WHERE a_id = ? AND b_id = ?').get(a, b);
}

function memberIds(hangoutId) {
  return db.prepare('SELECT user_id FROM hangout_members WHERE hangout_id = ?')
    .all(hangoutId).map((r) => r.user_id);
}

// A short status/title for a friendship, from vibe + streak + staleness.
// TITLE_STALE_MS is intentionally low so "Need to hang out" is demoable.
const TITLE_STALE_MS = 2 * 60 * 1000; // 2 minutes
function friendTitle({ vibeLevel, streak, lastHangoutAt, friendsSince }) {
  const now = Date.now();
  const last = lastHangoutAt ? new Date(lastHangoutAt).getTime() : null;
  const since = friendsSince ? new Date(friendsSince).getTime() : now;
  const stale = last != null ? now - last > TITLE_STALE_MS : now - since > TITLE_STALE_MS;
  if (stale) return { title: 'Need to hang out', titleKind: 'stale' };
  if (streak) return { title: 'On a streak', titleKind: 'streak' };
  if (vibeLevel >= 3) return { title: 'Best friend', titleKind: 'best' };
  if (last == null) return { title: 'New friend', titleKind: 'new' };
  if (vibeLevel >= 2) return { title: 'Close friend', titleKind: 'close' };
  return { title: 'Friend', titleKind: 'friend' };
}

// Completed hangouts both users attended: last one + count over the past 30 days.
function hangoutStats(meId, otherId) {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const r = db.prepare(`SELECT MAX(h.completed_at) last, SUM(h.completed_at > ?) recent
    FROM hangouts h
    JOIN hangout_members m1 ON m1.hangout_id = h.id AND m1.user_id = ?
    JOIN hangout_members m2 ON m2.hangout_id = h.id AND m2.user_id = ?
    WHERE h.completed_at IS NOT NULL`).get(cutoff, meId, otherId);
  return { lastHangoutAt: r.last, recentHangouts: r.recent || 0, streak: (r.recent || 0) >= 3 };
}

// Next Friday 18:00 local, strictly in the future (today 18:00 if Friday before 18:00).
function nextFriday18(from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7));
  d.setHours(18, 0, 0, 0);
  if (d <= from) d.setDate(d.getDate() + 7);
  return d;
}

function allPairs(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) out.push(pair(ids[i], ids[j]));
  return out;
}

// Who actually showed up: the photo taker (present to snap it) plus anyone who
// confirmed (tapped) with someone. Everyone else is a no-show.
function attendeeIdSet(h, ids) {
  const set = new Set();
  if (h.photo_by != null) set.add(h.photo_by);
  const confirms = db.prepare('SELECT u1, u2 FROM confirms WHERE hangout_id = ?').all(h.id);
  for (const c of confirms) { set.add(c.u1); set.add(c.u2); }
  return set;
}

function hangoutView(h, meId) {
  const ids = memberIds(h.id);
  const attendees = attendeeIdSet(h, ids);
  const members = ids.map((id) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return { ...publicUser(u), attended: attendees.has(id) };
  });
  const confirms = db.prepare('SELECT * FROM confirms WHERE hangout_id = ?').all(h.id);
  const confirmedPairs = confirms.map((c) => {
    const ua = db.prepare('SELECT username FROM users WHERE id = ?').get(c.u1);
    const ub = db.prepare('SELECT username FROM users WHERE id = ?').get(c.u2);
    return [ua.username, ub.username];
  });
  const pairsTotal = (ids.length * (ids.length - 1)) / 2;

  // staking state, entirely from the local DB (no crypto call in list views)
  let stake = null;
  if (h.stake_units) {
    const stakedRows = db.prepare('SELECT user_id FROM hangout_stakes WHERE hangout_id = ?').all(h.id);
    const stakedIds = new Set(stakedRows.map((r) => r.user_id));
    const settleRows = db.prepare('SELECT * FROM hangout_settlements WHERE hangout_id = ?').all(h.id);
    const settleByUser = new Map(settleRows.map((r) => [r.user_id, r]));
    stake = {
      stakeUnits: h.stake_units,
      settled: !!h.settled_at,
      poolUnits: String(BigInt(h.stake_units) * BigInt(stakedIds.size)),
      members: ids.map((id) => {
        const u = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
        const s = settleByUser.get(id);
        return {
          username: u.username,
          staked: stakedIds.has(id),
          settleStatus: s ? s.status : null,
          payoutUnits: s ? s.payout_units : null,
        };
      }),
      iStaked: stakedIds.has(meId),
    };
  }

  return {
    id: h.id,
    activity: h.activity,
    activityLabel: h.activity_label,
    date: h.date,
    place: h.place,
    bonusMult: h.bonus_mult,
    bonusReason: h.bonus_reason,
    photoUrl: h.photo ? `/uploads/${h.photo}` : null,
    completedAt: h.completed_at,
    members,
    confirmedPairs,
    pairsTotal,
    mine: ids.includes(meId),
    // can be force-ended once it has started and there's a photo (proof)
    canEnd: !h.completed_at && !!h.photo && new Date(h.date).getTime() < Date.now(),
    stake,
  };
}

function maybeComplete(hangoutId) {
  const h = db.prepare('SELECT * FROM hangouts WHERE id = ?').get(hangoutId);
  if (!h || h.completed_at) return;
  const ids = memberIds(hangoutId);
  const need = (ids.length * (ids.length - 1)) / 2;
  const got = db.prepare('SELECT COUNT(*) c FROM confirms WHERE hangout_id = ?').get(hangoutId).c;
  // A staked hangout is completed by /end only after the remote payout has
  // been reconciled and mirrored locally. Non-staked hangouts can retain the
  // original automatic all-pairs completion behavior.
  if (h.photo && got >= need && !h.crypto_event_id) {
    db.prepare('UPDATE hangouts SET completed_at = ? WHERE id = ?').run(now(), hangoutId);
  }
}

// ---------- auth ----------
function isValidBirthday(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

app.get('/auth/profile', auth0Identity, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE auth0_sub = ?').get(req.auth0Sub);
  res.json({ me: user ? meView(user) : null });
});

const provisionAuth0Profile = db.transaction((profile) => {
  const existing = db.prepare('SELECT * FROM users WHERE auth0_sub = ?').get(profile.auth0Sub);
  if (existing) return { created: false, user: existing };
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(profile.username)) {
    return { conflict: true };
  }

  // These values satisfy the old NOT NULL schema without creating a second
  // credential. Their prefixes cannot be classified as a legacy bearer token,
  // and legacy password login explicitly excludes Auth0-linked rows.
  const disabledPasswordHash = `auth0-disabled:${crypto.randomBytes(32).toString('hex')}`;
  const disabledSalt = `auth0-disabled:${crypto.randomBytes(16).toString('hex')}`;
  const disabledToken = `auth0-disabled:${crypto.randomBytes(32).toString('hex')}`;
  db.prepare(`INSERT INTO users
    (username, name, birthday, pass_hash, salt, token, auth0_sub, color, species, interests, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    profile.username,
    profile.name,
    profile.birthday,
    disabledPasswordHash,
    disabledSalt,
    disabledToken,
    profile.auth0Sub,
    profile.color,
    profile.species,
    JSON.stringify(profile.interests),
    now(),
  );
  return {
    created: true,
    user: db.prepare('SELECT * FROM users WHERE auth0_sub = ?').get(profile.auth0Sub),
  };
});

app.put('/auth/profile', auth0Identity, (req, res, next) => {
  // Retried onboarding requests return the already-linked row unchanged. In
  // particular, request claims or a later username cannot relink an identity.
  const existing = db.prepare('SELECT * FROM users WHERE auth0_sub = ?').get(req.auth0Sub);
  if (existing) return res.status(200).json({ me: meView(existing) });

  const { username, name, birthday, color, species, interests } = req.body || {};
  if (!/^[a-z0-9_]{3,20}$/.test(username || '')) {
    return res.status(400).json({ error: 'Username must be 3-20 chars: a-z, 0-9, _' });
  }
  if (typeof name !== 'string' || name.length < 1 || name.length > 40 ||
      name.trim() !== name || /[\u0000-\u001f\u007f]/.test(name)) {
    return res.status(400).json({ error: 'Name is required and must be at most 40 characters' });
  }
  if (!isValidBirthday(birthday)) {
    return res.status(400).json({ error: 'Birthday must be a valid date' });
  }
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
    return res.status(400).json({ error: 'Color must be a six-digit hex color' });
  }
  if (!SPECIES.includes(species)) {
    return res.status(400).json({ error: 'Species is not supported' });
  }
  let result;
  try {
    // IMMEDIATE serializes provisioning across server processes before either
    // the subject or username uniqueness checks are made.
    result = provisionAuth0Profile.immediate({
      auth0Sub: req.auth0Sub,
      username,
      name,
      birthday,
      color,
      species,
      interests: sanitizeInterests(interests),
    });
  } catch (error) {
    if (error && String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'Username is taken' });
    }
    return next(error);
  }
  if (result.conflict) return res.status(409).json({ error: 'Username is taken' });
  if (!result.created) return res.status(200).json({ me: meView(result.user) });

  cryptoApi.ensureUser(result.user.username).catch(() => {}); // best-effort wallet registration
  return res.status(201).json({ me: meView(result.user) });
});

app.post('/auth/register', requireLegacyAuthEnabled, (req, res) => {
  const { username, name, birthday, password, color, species, interests } = req.body || {};
  if (!/^[a-z0-9_]{3,20}$/.test(username || ''))
    return res.status(400).json({ error: 'Username must be 3-20 chars: a-z, 0-9, _' });
  if (!name || name.length < 1 || name.length > 40)
    return res.status(400).json({ error: 'Name is required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday || '') || isNaN(new Date(birthday).getTime()))
    return res.status(400).json({ error: 'Birthday must be a valid date' });
  if (!password || password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username))
    return res.status(409).json({ error: 'Username is taken' });
  const salt = crypto.randomBytes(8).toString('hex');
  const token = newToken();
  db.prepare(`INSERT INTO users (username, name, birthday, pass_hash, salt, token, color, species, interests, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(username, name, birthday, hash(password, salt), salt, token, color || '#A8D8C8',
      SPECIES.includes(species) ? species : 'cat', JSON.stringify(sanitizeInterests(interests)), now());
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  cryptoApi.ensureUser(username).catch(() => {}); // best-effort wallet registration
  res.json({ token, me: meView(u) });
});

app.post('/auth/login', requireLegacyAuthEnabled, (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!u || u.auth0_sub || hash(password || '', u.salt) !== u.pass_hash)
    return res.status(401).json({ error: 'Wrong username or password' });
  cryptoApi.ensureUser(u.username).catch(() => {}); // best-effort wallet registration
  res.json({ token: u.token, me: meView(u) });
});

function meView(u) {
  return {
    username: u.username,
    name: u.name,
    birthday: u.birthday,
    acorns: u.acorns,
    color: u.color,
    species: u.species,
    owned: safeJsonArray(u.owned),
    equipped: safeJsonArray(u.equipped),
    interests: interestsOf(u),
  };
}

app.get('/me', auth, (req, res) => res.json({ me: meView(req.user) }));

app.put('/me/interests', auth, (req, res) => {
  const interests = sanitizeInterests(req.body?.interests);
  db.prepare('UPDATE users SET interests = ? WHERE id = ?').run(JSON.stringify(interests), req.user.id);
  res.json({ me: meView(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

app.put('/me/avatar', auth, (req, res) => {
  const { color, equipped, species } = req.body || {};
  const owned = JSON.parse(req.user.owned);
  const eq = Array.isArray(equipped) ? equipped.filter((i) => owned.includes(i)) : [];
  db.prepare('UPDATE users SET color = ?, equipped = ?, species = ? WHERE id = ?')
    .run(color || req.user.color, JSON.stringify(eq),
      SPECIES.includes(species) ? species : req.user.species, req.user.id);
  res.json({ me: meView(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

// ---------- catalog ----------
app.get('/catalog', (_req, res) => res.json({ activities: ACTIVITIES, items: ITEMS, holidays: HOLIDAYS }));

// ---------- users and friends ----------
app.get('/users/search', auth, (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (q.length < 2) return res.json({ users: [] });
  const rows = db.prepare(
    `SELECT * FROM users WHERE (username LIKE ? OR lower(name) LIKE ?) AND id != ? LIMIT 6`
  ).all(`${q}%`, `%${q}%`, req.user.id);
  res.json({ users: rows.map(publicUser) });
});

app.get('/friends', auth, (req, res) => {
  const me = req.user.id;
  const rows = db.prepare(
    'SELECT * FROM friendships WHERE (a_id = ? OR b_id = ?)').all(me, me);
  const friends = [];
  const incoming = [];
  const outgoing = [];
  for (const f of rows) {
    const otherId = f.a_id === me ? f.b_id : f.a_id;
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
    const view = {
      ...publicUser(u),
      birthday: u.birthday.slice(5),
      vibe: f.vibe,
      vibeLevel: level(f.vibe),
      vibeIntoLevel: f.vibe % VIBE_PER_LEVEL,
      vibePerLevel: VIBE_PER_LEVEL,
    };
    if (f.status === 'accepted') {
      const stats = hangoutStats(me, otherId);
      const title = friendTitle({
        vibeLevel: view.vibeLevel, streak: stats.streak,
        lastHangoutAt: stats.lastHangoutAt, friendsSince: f.created_at,
      });
      friends.push({ ...view, ...stats, ...title });
    } else if (f.requested_by === me) outgoing.push(view);
    else incoming.push(view);
  }
  friends.sort((x, y) => y.vibe - x.vibe);
  res.json({ friends, incoming, outgoing });
});

// Detailed profile for one accepted friend, including your shared history.
app.get('/friends/:username', auth, (req, res) => {
  const me = req.user.id;
  const other = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!other) return res.status(404).json({ error: 'No such user' });
  const f = friendship(me, other.id);
  if (!f || f.status !== 'accepted') return res.status(403).json({ error: 'Not your friend' });

  // hangouts you two both attended
  const shared = db.prepare(
    `SELECT h.* FROM hangouts h
     JOIN hangout_members m1 ON m1.hangout_id = h.id AND m1.user_id = ?
     JOIN hangout_members m2 ON m2.hangout_id = h.id AND m2.user_id = ?
     ORDER BY h.date DESC`
  ).all(me, other.id);
  const completed = shared.filter((h) => h.completed_at);
  const upcoming = shared.filter((h) => !h.completed_at && new Date(h.date).getTime() >= Date.now());

  // favourite shared activities, by how often you've done them together
  const counts = {};
  for (const h of completed) counts[h.activity_label] = (counts[h.activity_label] || 0) + 1;
  const topActivities = Object.entries(counts)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([label]) => label);

  res.json({
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
      recentMemories: completed.slice(0, 4).map((h) => hangoutView(h, me)),
      ...friendTitle({
        vibeLevel: level(f.vibe),
        streak: hangoutStats(me, other.id).streak,
        lastHangoutAt: completed[0] ? completed[0].completed_at : null,
        friendsSince: f.created_at,
      }),
    },
  });
});

app.post('/friends/request', auth, (req, res) => {
  const other = db.prepare('SELECT * FROM users WHERE username = ?').get(req.body?.username || '');
  if (!other) return res.status(404).json({ error: 'No such username' });
  if (other.id === req.user.id) return res.status(400).json({ error: 'That is you' });
  const existing = friendship(req.user.id, other.id);
  if (existing) {
    if (existing.status === 'accepted') return res.status(409).json({ error: 'Already friends' });
    if (existing.requested_by === req.user.id)
      return res.status(409).json({ error: 'Request already sent' });
    // they already asked us: accept
    db.prepare('UPDATE friendships SET status = ? WHERE id = ?').run('accepted', existing.id);
    return res.json({ ok: true, accepted: true });
  }
  const [a, b] = pair(req.user.id, other.id);
  db.prepare(`INSERT INTO friendships (a_id, b_id, status, requested_by, created_at)
              VALUES (?, ?, 'pending', ?, ?)`).run(a, b, req.user.id, now());
  res.json({ ok: true, accepted: false });
});

app.post('/friends/accept', auth, (req, res) => {
  const other = db.prepare('SELECT * FROM users WHERE username = ?').get(req.body?.username || '');
  if (!other) return res.status(404).json({ error: 'No such username' });
  const f = friendship(req.user.id, other.id);
  if (!f || f.status !== 'pending' || f.requested_by === req.user.id)
    return res.status(400).json({ error: 'No pending request from them' });
  db.prepare('UPDATE friendships SET status = ? WHERE id = ?').run('accepted', f.id);
  res.json({ ok: true });
});

// Friend card: profile + vibe + tastes for the tap-on-friend detail view.
app.get('/friends/:username/card', auth, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  const f = u && friendship(req.user.id, u.id);
  if (!f || f.status !== 'accepted') return res.status(404).json({ error: 'Not your friend' });
  const labels = (rows) => rows
    .map((r) => ACTIVITIES.find((a) => a.id === r.activity))
    .filter(Boolean).slice(0, 3).map((a) => a.label);
  const likes = labels(db.prepare(
    'SELECT activity FROM weights WHERE user_id = ? AND weight > 52 ORDER BY weight DESC').all(u.id));
  const dislikes = labels(db.prepare(
    'SELECT activity FROM weights WHERE user_id = ? AND weight < 48 ORDER BY weight ASC').all(u.id));
  res.json({
    card: {
      ...publicUser(u),
      birthday: u.birthday.slice(5),
      vibeLevel: level(f.vibe),
      lastHangoutAt: hangoutStats(req.user.id, u.id).lastHangoutAt,
      likes,
      dislikes,
    },
  });
});

// ---------- activity weights and duels ----------
function weightOf(userId, activity) {
  const r = db.prepare('SELECT weight FROM weights WHERE user_id = ? AND activity = ?')
    .get(userId, activity);
  return r ? r.weight : 50;
}

// The score used to order activities for a person: their learned duel weight,
// lifted if it's one of their stated interests. This is what makes interests
// steer which hangouts get suggested.
function rankScore(userId, activity, interestSet) {
  const base = weightOf(userId, activity);
  return interestSet && interestSet.has(activity) ? Math.min(100, base + INTEREST_BOOST) : base;
}

app.get('/activities/ranked', auth, (req, res) => {
  const usernames = String(req.query.with || '').split(',').filter(Boolean);
  const ids = [req.user.id];
  for (const un of usernames) {
    const u = db.prepare('SELECT id FROM users WHERE username = ?').get(un);
    if (u) ids.push(u.id);
  }
  const sets = new Map(ids.map((id) => [id, interestSetOf(id)]));
  const ranked = ACTIVITIES.map((a) => ({
    ...a,
    combined: ids.reduce((s, id) => s + rankScore(id, a.id, sets.get(id)), 0) / ids.length,
  })).sort((x, y) => y.combined - x.combined);
  res.json({ activities: ranked });
});

app.post('/duels', auth, (req, res) => {
  const { winner, loser } = req.body || {};
  if (!ACTIVITIES.some((a) => a.id === winner) || !ACTIVITIES.some((a) => a.id === loser))
    return res.status(400).json({ error: 'Unknown activity' });
  const w = weightOf(req.user.id, winner);
  const l = weightOf(req.user.id, loser);
  const expected = 1 / (1 + Math.pow(10, (l - w) / 40));
  const dw = Math.max(1, Math.round(8 * (1 - expected)));
  const up = db.prepare(`INSERT INTO weights (user_id, activity, weight) VALUES (?, ?, ?)
    ON CONFLICT(user_id, activity) DO UPDATE SET weight = ?`);
  up.run(req.user.id, winner, Math.min(100, w + dw), Math.min(100, w + dw));
  up.run(req.user.id, loser, Math.max(0, l - dw / 2), Math.max(0, l - dw / 2));
  res.json({ ok: true });
});

// ---------- suggestions ----------
// One concrete plan: most-neglected friend + the pair's best activity, next Friday 18:00.
app.get('/suggestions', auth, (req, res) => {
  const me = req.user.id;
  const fr = db.prepare(
    `SELECT * FROM friendships WHERE (a_id = ? OR b_id = ?) AND status = 'accepted'`).all(me, me);
  let best = null;
  for (const f of fr) {
    const otherId = f.a_id === me ? f.b_id : f.a_id;
    // don't re-suggest a pair that already has a hangout in the works
    const open = db.prepare(`SELECT COUNT(*) AS c FROM hangouts h
      JOIN hangout_members m1 ON m1.hangout_id = h.id AND m1.user_id = ?
      JOIN hangout_members m2 ON m2.hangout_id = h.id AND m2.user_id = ?
      WHERE h.completed_at IS NULL`).get(me, otherId).c;
    if (open > 0) continue;
    const { lastHangoutAt } = hangoutStats(me, otherId);
    const t = lastHangoutAt ? new Date(lastHangoutAt).getTime() : -Infinity;
    if (!best || t < best.t || (t === best.t && f.vibe > best.vibe))
      best = { otherId, t, vibe: f.vibe, lastHangoutAt };
  }
  if (!best) return res.json({ suggestion: null });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(best.otherId);
  const meSet = interestSetOf(me);
  const uSet = interestSetOf(u.id);
  const top = ACTIVITIES.map((a) => ({ ...a, combined: rankScore(me, a.id, meSet) + rankScore(u.id, a.id, uSet) }))
    .sort((x, y) => y.combined - x.combined)[0];
  const stale = !best.lastHangoutAt || best.t < Date.now() - 14 * 24 * 3600 * 1000;
  res.json({
    suggestion: {
      friend: publicUser(u),
      activity: { id: top.id, label: top.label },
      date: nextFriday18().toISOString(),
      reason: stale ? 'stale' : 'vibe',
    },
  });
});

// ---------- hangouts ----------
app.post('/hangouts', auth, asyncRoute(async (req, res) => {
  const { activity, date, place, friendUsernames, stakeUnits } = req.body || {};
  const act = ACTIVITIES.find((a) => a.id === activity);
  if (!act) return res.status(400).json({ error: 'Pick an activity' });
  if (!date || isNaN(new Date(date).getTime()))
    return res.status(400).json({ error: 'Pick a date' });
  const others = [];
  for (const un of friendUsernames || []) {
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(un);
    if (!u) return res.status(404).json({ error: `No such user: ${un}` });
    const f = friendship(req.user.id, u.id);
    if (!f || f.status !== 'accepted')
      return res.status(400).json({ error: `${u.name} is not your friend yet` });
    others.push(u);
  }
  if (others.length < 1) return res.status(400).json({ error: 'Invite at least one friend' });
  const ids = [req.user.id, ...others.map((u) => u.id)];
  const bonus = bonusFor(date, ids);

  // A requested stake is never silently downgraded. Create the remote event,
  // but let the host use the same explicit, retryable Stake action as everyone
  // else. That avoids debiting real money before the local hangout is durable.
  let cryptoEventId = null;
  let stake = null;
  const wantStake = stakeUnits !== undefined;
  if (wantStake) {
    if (typeof stakeUnits !== 'string' || !/^[1-9]\d*$/.test(stakeUnits) || stakeUnits.length > 34) {
      return res.status(400).json({
        error: 'invalid_stake',
        message: 'Stake must be a positive integer amount in USDC base units.',
      });
    }
    try {
      await cryptoApi.ensureUser(req.user.username);
      const bps = Math.min(15000, Math.max(10000, Math.round(bonus.mult * 10000)));
      const ev = await cryptoApi.createEvent(req.user.username, act.label, stakeUnits, { multiplierBps: bps, startsAt: date });
      if (!ev || typeof ev.id !== 'string' || ev.id.length < 1) {
        throw new cryptoApi.CryptoError(502, 'Crypto service returned an invalid event.', 'crypto_upstream_invalid');
      }
      cryptoEventId = ev.id;
      stake = stakeUnits;
    } catch (e) {
      return sendCryptoError(res, e);
    }
  }

  const insertHangout = db.transaction(() => {
    const info = db.prepare(`INSERT INTO hangouts
      (creator_id, activity, activity_label, date, place, bonus_mult, bonus_reason, created_at, stake_units, crypto_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.user.id, act.id, act.label, date, place || 'Somewhere', bonus.mult, bonus.reason, now(), stake, cryptoEventId);
    const hid = info.lastInsertRowid;
    const ins = db.prepare('INSERT INTO hangout_members (hangout_id, user_id) VALUES (?, ?)');
    for (const id of ids) ins.run(hid, id);
    return hid;
  });
  const hid = insertHangout();
  res.json({ hangout: hangoutView(db.prepare('SELECT * FROM hangouts WHERE id = ?').get(hid), req.user.id) });
}));

// A member stakes into an existing staked hangout ("put your deposit in").
app.post('/hangouts/:id/stake', auth, asyncRoute(async (req, res) => {
  const h = db.prepare('SELECT * FROM hangouts WHERE id = ?').get(req.params.id);
  if (!h || !memberIds(h.id).includes(req.user.id))
    return res.status(404).json({ error: 'Hangout not found' });
  if (!h.crypto_event_id) return res.status(400).json({ error: 'This hangout has no stake' });
  if (h.settled_at) return res.status(409).json({ error: 'crypto_conflict', message: 'Already settled' });
  const already = db.prepare('SELECT 1 FROM hangout_stakes WHERE hangout_id = ? AND user_id = ?').get(h.id, req.user.id);
  if (already) {
    return res.json({ hangout: hangoutView(h, req.user.id) });
  }
  try {
    await cryptoApi.ensureUser(req.user.username);
    let remoteEvent = await cryptoApi.getEvent(h.crypto_event_id);
    if (!remoteEvent || remoteEvent.id !== h.crypto_event_id || !Array.isArray(remoteEvent.rsvps)) {
      throw new cryptoApi.CryptoError(502, 'Crypto service returned an invalid event.', 'crypto_upstream_invalid');
    }
    if (remoteEvent.status === 'settled') {
      throw new cryptoApi.CryptoError(409, 'Already settled', 'crypto_conflict');
    }
    if (!cryptoEventRsvp(remoteEvent, req.user.username)) {
      try {
        remoteEvent = await cryptoApi.rsvp(h.crypto_event_id, req.user.username);
      } catch (error) {
        // A concurrent or response-lost RSVP may have succeeded. Re-read once
        // and accept only a durable matching RSVP.
        remoteEvent = await cryptoApi.getEvent(h.crypto_event_id);
        if (!cryptoEventRsvp(remoteEvent, req.user.username)) throw error;
      }
    }
    const rsvp = cryptoEventRsvp(remoteEvent, req.user.username);
    if (!rsvp || !['staked', 'attended'].includes(rsvp.status) || rsvp.stakedUnits !== h.stake_units) {
      throw new cryptoApi.CryptoError(502, 'Crypto service returned an invalid RSVP.', 'crypto_upstream_invalid');
    }
  } catch (e) {
    return sendCryptoError(res, e);
  }
  db.prepare(`INSERT INTO hangout_stakes (hangout_id, user_id, staked_at) VALUES (?, ?, ?)
    ON CONFLICT(hangout_id, user_id) DO NOTHING`)
    .run(h.id, req.user.id, now());
  res.json({ hangout: hangoutView(db.prepare('SELECT * FROM hangouts WHERE id = ?').get(h.id), req.user.id) });
}));

function invalidCryptoUpstream(message = 'Crypto service returned an invalid settlement.') {
  return new cryptoApi.CryptoError(502, message, 'crypto_upstream_invalid');
}

function validCryptoInteger(value) {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 34;
}

function finishHangoutLocally(hangoutId) {
  db.prepare('UPDATE hangouts SET completed_at = COALESCE(completed_at, ?) WHERE id = ?')
    .run(now(), hangoutId);
}

// Reconcile the authoritative RSVP set, replay all local attendance proof, and
// validate the full payout before publishing it to local views. When `complete`
// is true, settlement and completion become visible in the same transaction.
async function settleStakeAndMirror(h, attendeeIds, { complete = false } = {}) {
  const current = db.prepare('SELECT * FROM hangouts WHERE id = ?').get(h.id);
  if (!current) throw invalidCryptoUpstream('Hangout disappeared during settlement.');
  if (!current.crypto_event_id) {
    if (complete) finishHangoutLocally(current.id);
    return db.prepare('SELECT * FROM hangouts WHERE id = ?').get(current.id);
  }
  if (current.settled_at) {
    if (complete) finishHangoutLocally(current.id);
    return db.prepare('SELECT * FROM hangouts WHERE id = ?').get(current.id);
  }

  // Only known members with this hangout's exact stake may enter the local
  // mirror. This also repairs response-lost RSVPs before attendance is replayed.
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
  const expectedMultiplierBps = Math.min(
    15_000,
    Math.max(10_000, Math.round(current.bonus_mult * 10_000)),
  );
  if (remoteEvent.multiplierBps != null && remoteEvent.multiplierBps !== expectedMultiplierBps) {
    throw invalidCryptoUpstream('Crypto event multiplier does not match this hangout.');
  }
  const members = new Map(memberIds(current.id).map((id) => {
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
    return user ? [cryptoApi.extId(user.username), user] : [null, null];
  }).filter(([externalId]) => externalId));
  const seenRemote = new Set();
  const remoteStakes = [];
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
  db.transaction(() => {
    const insert = db.prepare(`INSERT INTO hangout_stakes (hangout_id, user_id, staked_at)
      VALUES (?, ?, ?) ON CONFLICT(hangout_id, user_id) DO NOTHING`);
    for (const userId of remoteStakes) insert.run(current.id, userId, now());
    const mirrored = db.prepare(`SELECT hs.user_id, u.username
      FROM hangout_stakes hs JOIN users u ON u.id = hs.user_id
      WHERE hs.hangout_id = ?`).all(current.id);
    const remove = db.prepare('DELETE FROM hangout_stakes WHERE hangout_id = ? AND user_id = ?');
    for (const entry of mirrored) {
      if (!seenRemote.has(cryptoApi.extId(entry.username))) remove.run(current.id, entry.user_id);
    }
  })();

  const localStakes = db.prepare(`SELECT hs.user_id, u.username
    FROM hangout_stakes hs JOIN users u ON u.id = hs.user_id
    WHERE hs.hangout_id = ? ORDER BY hs.user_id`).all(current.id);
  if (remoteEvent.status !== 'settled') {
    // Both a photo taker and either side of an NFC confirmation count as present.
    // A failed check-in aborts settlement; it is never swallowed as a no-show.
    for (const staker of localStakes) {
      if (attendeeIds.has(staker.user_id)) {
        await cryptoApi.checkin(current.crypto_event_id, staker.username);
      }
    }
  }
  const result = await cryptoApi.settle(current.crypto_event_id);

  const expected = new Map(localStakes.map((row) => [cryptoApi.extId(row.username), row]));
  const attendingStakers = new Set(
    localStakes.filter((row) => attendeeIds.has(row.user_id)).map((row) => row.user_id),
  );
  const stakeUnits = BigInt(current.stake_units);
  const attendeeCount = BigInt(attendingStakers.size);
  const flakerCount = BigInt(localStakes.length - attendingStakers.size);
  const expectedForfeit = attendeeCount === 0n ? 0n : stakeUnits * flakerCount;
  const forfeitShare = attendeeCount === 0n ? 0n : expectedForfeit / attendeeCount;
  const forfeitRemainder = attendeeCount === 0n ? 0n : expectedForfeit % attendeeCount;
  const expectedPayouts = new Map();
  let attendeeIndex = 0n;
  for (const rsvp of remoteEvent.rsvps) {
    const local = members.get(rsvp.userId);
    if (!local) throw invalidCryptoUpstream();
    if (attendeeCount === 0n) {
      expectedPayouts.set(rsvp.userId, current.stake_units);
    } else if (!attendingStakers.has(local.id)) {
      expectedPayouts.set(rsvp.userId, '0');
    } else {
      const basePayout = stakeUnits + forfeitShare + (attendeeIndex < forfeitRemainder ? 1n : 0n);
      const bonus = (basePayout * BigInt(expectedMultiplierBps - 10_000)) / 10_000n;
      expectedPayouts.set(rsvp.userId, String(basePayout + bonus));
      attendeeIndex += 1n;
    }
  }
  const seen = new Set();
  const validated = [];
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
    validated.push({ ...entry, userId: local.user_id });
  }
  if (BigInt(result.forfeitPoolUnits) !== expectedForfeit) {
    throw invalidCryptoUpstream();
  }

  db.transaction(() => {
    db.prepare('DELETE FROM hangout_settlements WHERE hangout_id = ?').run(current.id);
    const insert = db.prepare(`INSERT INTO hangout_settlements
      (hangout_id, user_id, status, payout_units) VALUES (?, ?, ?, ?)`);
    for (const entry of validated) {
      insert.run(current.id, entry.userId, entry.status, entry.payoutUnits);
    }
    db.prepare('UPDATE hangouts SET settled_at = COALESCE(settled_at, ?) WHERE id = ?')
      .run(now(), current.id);
    if (complete) finishHangoutLocally(current.id);
  })();
  return db.prepare('SELECT * FROM hangouts WHERE id = ?').get(current.id);
}

app.get('/hangouts', auth, (req, res) => {
  const rows = db.prepare(`SELECT h.* FROM hangouts h
    JOIN hangout_members m ON m.hangout_id = h.id
    WHERE m.user_id = ? ORDER BY h.date DESC`).all(req.user.id);
  res.json({ hangouts: rows.map((h) => hangoutView(h, req.user.id)) });
});

app.get('/hangouts/:id', auth, (req, res) => {
  const h = db.prepare('SELECT * FROM hangouts WHERE id = ?').get(req.params.id);
  if (!h || !memberIds(h.id).includes(req.user.id))
    return res.status(404).json({ error: 'Hangout not found' });
  res.json({ hangout: hangoutView(h, req.user.id) });
});

app.post('/hangouts/:id/photo', auth, upload.single('photo'), (req, res) => {
  const h = db.prepare('SELECT * FROM hangouts WHERE id = ?').get(req.params.id);
  if (!h || !memberIds(h.id).includes(req.user.id))
    return res.status(404).json({ error: 'Hangout not found' });
  if (!req.file) return res.status(400).json({ error: 'No photo attached' });
  db.prepare('UPDATE hangouts SET photo = ?, photo_by = ? WHERE id = ?').run(req.file.filename, req.user.id, h.id);
  maybeComplete(h.id);
  res.json({ hangout: hangoutView(db.prepare('SELECT * FROM hangouts WHERE id = ?').get(h.id), req.user.id) });
});

// End the hangout with whoever showed up, even if some pairs never tapped.
// Requires the hangout to have started and a photo (proof). Attendees are the
// photo taker + anyone who confirmed; no-shows are the rest. Settles the pool
// (checking attendees in first) so no-shows' stakes go to the friends who came.
app.post('/hangouts/:id/end', auth, asyncRoute(async (req, res) => {
  const h = db.prepare('SELECT * FROM hangouts WHERE id = ?').get(req.params.id);
  if (!h || !memberIds(h.id).includes(req.user.id))
    return res.status(404).json({ error: 'Hangout not found' });
  if (h.completed_at) return res.json({ hangout: hangoutView(h, req.user.id) });
  if (new Date(h.date).getTime() > Date.now())
    return res.status(400).json({ error: 'Cannot end before the hangout starts' });
  if (!h.photo) return res.status(400).json({ error: 'Take the photo first, then end it' });

  const ids = memberIds(h.id);
  const attendees = attendeeIdSet(h, ids);
  try {
    const ended = await settleStakeAndMirror(h, attendees, { complete: true });
    return res.json({ hangout: hangoutView(ended, req.user.id) });
  } catch (error) {
    return sendCryptoError(res, error);
  }
}));

// NFC: the "show" phone fetches a short-lived token, encodes it over HCE.
app.get('/hangouts/:id/nfc-token', auth, (req, res) => {
  const h = db.prepare('SELECT * FROM hangouts WHERE id = ?').get(req.params.id);
  if (!h || !memberIds(h.id).includes(req.user.id))
    return res.status(404).json({ error: 'Hangout not found' });
  const token = crypto.randomBytes(6).toString('hex');
  db.prepare(`INSERT INTO nfc_tokens (hangout_id, user_id, token, expires_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(hangout_id, user_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at`)
    .run(h.id, req.user.id, token, Date.now() + 10 * 60 * 1000);
  res.json({ payload: `TY1|${h.id}|${req.user.username}|${token}` });
});

// The "scan" phone posts what it read.
app.post('/hangouts/:id/confirm', auth, asyncRoute(async (req, res) => {
  const h = db.prepare('SELECT * FROM hangouts WHERE id = ?').get(req.params.id);
  if (!h || !memberIds(h.id).includes(req.user.id))
    return res.status(404).json({ error: 'Hangout not found' });
  const { username, token } = req.body || {};
  const other = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!other || !memberIds(h.id).includes(other.id))
    return res.status(400).json({ error: 'That person is not in this hangout' });
  if (other.id === req.user.id) return res.status(400).json({ error: 'Cannot confirm with yourself' });
  const [u1, u2] = pair(req.user.id, other.id);
  const already = db.prepare('SELECT 1 FROM confirms WHERE hangout_id = ? AND u1 = ? AND u2 = ?').get(h.id, u1, u2);
  if (!already) {
    const t = db.prepare('SELECT * FROM nfc_tokens WHERE hangout_id = ? AND user_id = ?').get(h.id, other.id);
    if (!t || t.token !== token || t.expires_at < Date.now())
      return res.status(400).json({ error: 'Tap not valid, try again' });
  }
  let vibeGain = 0;
  let acornGain = 0;
  if (!already) {
    db.prepare('INSERT INTO confirms (hangout_id, u1, u2, confirmed_at) VALUES (?, ?, ?, ?)')
      .run(h.id, u1, u2, now());
    const f = friendship(u1, u2);
    if (f) {
      vibeGain = Math.round(VIBE_PER_CONFIRM * h.bonus_mult);
      const before = level(f.vibe);
      const after = level(f.vibe + vibeGain);
      db.prepare('UPDATE friendships SET vibe = vibe + ? WHERE id = ?').run(vibeGain, f.id);
      if (after > before) {
        acornGain = ACORNS_PER_LEVEL * (after - before);
        db.prepare('UPDATE users SET acorns = acorns + ? WHERE id IN (?, ?)').run(acornGain, u1, u2);
      }
    }
    maybeComplete(h.id);
  }
  // Retry attendance sync even when this confirmation already existed (for
  // example, because a previous crypto response was lost). A failed check-in
  // never erases local proof; settlement replays it as a hard safety boundary.
  if (h.crypto_event_id) {
    const checkins = [];
    for (const [uid, uname] of [[req.user.id, req.user.username], [other.id, other.username]]) {
      const staked = db.prepare('SELECT 1 FROM hangout_stakes WHERE hangout_id = ? AND user_id = ?').get(h.id, uid);
      if (staked) checkins.push(cryptoApi.checkin(h.crypto_event_id, uname));
    }
    try {
      await Promise.all(checkins);
    } catch (error) {
      return sendCryptoError(res, error);
    }
  }
  res.json({
    hangout: hangoutView(db.prepare('SELECT * FROM hangouts WHERE id = ?').get(h.id), req.user.id),
    vibeGain,
    acornGain,
    bonusReason: h.bonus_reason,
  });
}));

// ---------- memory book ----------
app.get('/memories', auth, (req, res) => {
  const rows = db.prepare(`SELECT h.* FROM hangouts h
    JOIN hangout_members m ON m.hangout_id = h.id
    WHERE m.user_id = ? AND h.completed_at IS NOT NULL
    ORDER BY h.date DESC`).all(req.user.id);
  res.json({ memories: rows.map((h) => hangoutView(h, req.user.id)) });
});

// ---------- leaderboard ----------
app.get('/leaderboard', auth, (req, res) => {
  const me = req.user.id;
  const fr = db.prepare(
    `SELECT * FROM friendships WHERE (a_id = ? OR b_id = ?) AND status = 'accepted'`).all(me, me);
  const ids = [me, ...fr.map((f) => (f.a_id === me ? f.b_id : f.a_id))];
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const rows = ids.map((id) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    const count = db.prepare(`SELECT COUNT(*) c FROM hangouts h
      JOIN hangout_members m ON m.hangout_id = h.id
      WHERE m.user_id = ? AND h.completed_at IS NOT NULL AND h.date >= ?`)
      .get(id, monthStart.toISOString()).c;
    return { ...publicUser(u), count, isMe: id === me };
  }).sort((x, y) => y.count - x.count);
  res.json({ leaderboard: rows, month: monthStart.toISOString().slice(0, 7) });
});

// ---------- wardrobe ----------
app.post('/shop/buy', auth, (req, res) => {
  const item = ITEMS.find((i) => i.id === req.body?.itemId);
  if (!item) return res.status(404).json({ error: 'No such item' });
  const owned = JSON.parse(req.user.owned);
  if (owned.includes(item.id)) return res.status(409).json({ error: 'Already owned' });
  if (req.user.acorns < item.price) return res.status(400).json({ error: 'Not enough acorns' });
  owned.push(item.id);
  db.prepare('UPDATE users SET acorns = acorns - ?, owned = ? WHERE id = ?')
    .run(item.price, JSON.stringify(owned), req.user.id);
  res.json({ me: meView(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

// Easter egg: tapping the Leaderboard title rains acorns. Sshh.
app.post('/secret/acorns', auth, (req, res) => {
  db.prepare('UPDATE users SET acorns = acorns + 10 WHERE id = ?').run(req.user.id);
  res.json({ me: meView(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

// ---------- wallet (USDC via Unifold treasury) ----------
app.get('/wallet', auth, asyncRoute(async (req, res) => {
  if (!(await cryptoApi.ready())) return res.json({ enabled: false });
  try {
    const w = await cryptoApi.getWallet(req.user.username);
    res.json({
      enabled: true,
      balanceUnits: w.balanceUnits,
      readyToCashOut: w.readyToCashOut,
      cashoutThresholdUnits: w.cashoutThresholdUnits,
      withdrawals: w.withdrawals,
    });
  } catch (e) {
    return sendCryptoError(res, e);
  }
}));

app.post('/wallet/add-funds', auth, asyncRoute(async (req, res) => {
  try {
    const r = await cryptoApi.addFunds(req.user.username);
    res.json(r);
  } catch (e) {
    return sendCryptoError(res, e);
  }
}));

app.post('/wallet/refresh', auth, asyncRoute(async (req, res) => {
  try {
    const r = await cryptoApi.refreshDeposits(req.user.username);
    res.json(r);
  } catch (e) {
    return sendCryptoError(res, e);
  }
}));

app.post('/wallet/withdraw', auth, asyncRoute(async (req, res) => {
  const { amountUnits, destination } = req.body || {};
  const keys = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index] && req.rawHeaders[index].toLowerCase() === 'idempotency-key') {
      keys.push(req.rawHeaders[index + 1] || '');
    }
  }
  if (keys.length !== 1 || !cryptoApi.validIdempotencyKey(keys[0])) {
    return res.status(400).json({
      error: 'invalid_idempotency_key',
      message: 'Exactly one valid Idempotency-Key header is required (8-128 characters).',
    });
  }
  try {
    const result = await cryptoApi.withdraw(req.user.username, amountUnits, destination, keys[0]);
    return res.status(result.status).json(result.data);
  } catch (e) {
    return sendCryptoError(res, e);
  }
}));

app.get('/health', (_req, res) => res.json({ ok: true, name: 'tomo-yard' }));

// ---------- walkable world (WebSocket) ----------
// A shared map at /ws. Clients send {type:'move',x,y}; the server broadcasts
// everyone's live position and persists each player's spot so their character
// stays where they left it after logout.
const WORLD_W = 2400;
const WORLD_H = 1800;
const AVATAR_R = 40; // keep spawns/positions inside the fence
const DEFAULT_WORLD_TICKET_TTL_MS = 45_000;
const worldTickets = new Map(); // random ticket -> { userId, expiresAt }
const attachedWorldServers = new WeakMap();

function worldTicketTtlMs(env = process.env) {
  // Production is deliberately fixed inside the required 30-60 second window.
  // Tests may shorten it to make expiry coverage deterministic and fast.
  if (env.NODE_ENV !== 'test') return DEFAULT_WORLD_TICKET_TTL_MS;
  const override = Number(env.WORLD_WS_TICKET_TTL_MS);
  return Number.isInteger(override) && override > 0 && override <= 60_000
    ? override
    : DEFAULT_WORLD_TICKET_TTL_MS;
}

function pruneWorldTickets(timestamp = Date.now()) {
  for (const [ticket, entry] of worldTickets) {
    if (!entry || entry.expiresAt <= timestamp) worldTickets.delete(ticket);
  }
}

app.post('/world/ws-ticket', auth, (req, res) => {
  pruneWorldTickets();
  // Keep at most one live ticket per identity. Issuing a replacement also
  // prevents an abandoned ticket from remaining useful until its expiry.
  for (const [existingTicket, entry] of worldTickets) {
    if (entry.userId === req.user.id) worldTickets.delete(existingTicket);
  }
  const ticket = crypto.randomBytes(32).toString('base64url');
  worldTickets.set(ticket, {
    userId: req.user.id,
    expiresAt: Date.now() + worldTicketTtlMs(),
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ticket });
});

function clampPos(v, max) {
  const number = Number(v);
  if (!Number.isFinite(number)) return null;
  return Math.max(AVATAR_R, Math.min(max - AVATAR_R, number));
}
function spawnPoint() {
  return {
    x: WORLD_W / 2 + (Math.random() * 2 - 1) * 300,
    y: WORLD_H / 2 + (Math.random() * 2 - 1) * 220,
  };
}

function worldPlayer(u, online) {
  return {
    username: u.username,
    name: u.name,
    color: u.color,
    species: u.species,
    equipped: safeJsonArray(u.equipped),
    x: u.pos_x,
    y: u.pos_y,
    online,
  };
}

function broadcastWorld(live, obj, exceptUsername) {
  const msg = JSON.stringify(obj);
  for (const [uname, c] of live) {
    if (uname === exceptUsername) continue;
    if (c.ws.readyState === 1) c.ws.send(msg);
  }
}

function rejectWorldUpgrade(socket) {
  // Keep the handshake response deliberately generic and never log the URL,
  // ticket, Authorization header, or any other credential-shaped input.
  if (socket.destroyed) return;
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  socket.destroy();
}

function consumeWorldTicket(ticket, timestamp = Date.now()) {
  if (typeof ticket !== 'string' || ticket.length === 0) return null;
  const entry = worldTickets.get(ticket);
  if (!entry) return null;
  // Delete before checking expiry or touching the database. Every recognized
  // ticket gets exactly one connection attempt, including an expired one.
  worldTickets.delete(ticket);
  if (entry.expiresAt <= timestamp) return null;
  return entry;
}

function attachWorldServer(server) {
  if (!server || typeof server.on !== 'function') {
    throw new TypeError('An HTTP server is required');
  }
  const alreadyAttached = attachedWorldServers.get(server);
  if (alreadyAttached) return alreadyAttached;

  const live = new Map(); // username -> { ws, x, y }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  attachedWorldServers.set(server, wss);

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || '', 'http://localhost');
    } catch {
      return rejectWorldUpgrade(socket);
    }
    if (url.pathname !== '/ws') return rejectWorldUpgrade(socket);
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 1 || keys[0] !== 'ticket' || url.searchParams.getAll('ticket').length !== 1) {
      return rejectWorldUpgrade(socket);
    }
    const entry = consumeWorldTicket(url.searchParams.get('ticket'));
    if (!entry) return rejectWorldUpgrade(socket);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(entry.userId);
    if (!user) return rejectWorldUpgrade(socket);

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, user);
    });
  });

  wss.on('connection', (ws, _req, user) => {
    ws.on('error', () => {});

    // Position is saved, or a fresh spawn is persisted immediately.
    let x = user.pos_x;
    let y = user.pos_y;
    if (x == null || y == null) {
      const spawn = spawnPoint();
      x = spawn.x;
      y = spawn.y;
      db.prepare('UPDATE users SET pos_x = ?, pos_y = ? WHERE id = ?').run(x, y, user.id);
      user.pos_x = x;
      user.pos_y = y;
    }
    const previous = live.get(user.username);
    live.set(user.username, { ws, x, y });
    if (previous && previous.ws !== ws && previous.ws.readyState < 2) {
      previous.ws.close(4002, 'replaced');
    }

    // Send initial state: every player who has ever entered the world.
    const all = db.prepare('SELECT * FROM users WHERE pos_x IS NOT NULL').all();
    ws.send(JSON.stringify({
      type: 'init',
      world: { w: WORLD_W, h: WORLD_H },
      me: user.username,
      players: all.map((candidate) => worldPlayer(candidate, live.has(candidate.username))),
    }));
    broadcastWorld(live, { type: 'join', player: worldPlayer(user, true) }, user.username);

    let lastPersist = 0;
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || msg.type !== 'move') return;
      const nx = clampPos(msg.x, WORLD_W);
      const ny = clampPos(msg.y, WORLD_H);
      if (nx == null || ny == null) return;
      const c = live.get(user.username);
      if (!c || c.ws !== ws) return;
      c.x = nx;
      c.y = ny;
      broadcastWorld(live, { type: 'pos', username: user.username, x: nx, y: ny }, user.username);
      const timestamp = Date.now();
      if (timestamp - lastPersist > 1500) {
        lastPersist = timestamp;
        db.prepare('UPDATE users SET pos_x = ?, pos_y = ? WHERE id = ?').run(nx, ny, user.id);
      }
    });

    ws.on('close', () => {
      const c = live.get(user.username);
      if (!c || c.ws !== ws) return;
      db.prepare('UPDATE users SET pos_x = ?, pos_y = ? WHERE id = ?').run(c.x, c.y, user.id);
      live.delete(user.username);
      broadcastWorld(live, { type: 'offline', username: user.username });
    });
  });

  return wss;
}

function createServer() {
  const server = http.createServer(app);
  attachWorldServer(server);
  return server;
}

// Auth0's verifier reports failures through Express errors. Keep the public
// response stable and non-sensitive while preserving its Bearer challenge.
app.use((error, _req, res, _next) => {
  if (error instanceof AuthConfigurationError ||
      error && error.name === 'AuthConfigurationError') {
    return res.status(503).json({
      error: error.code || 'AUTH0_CONFIGURATION_ERROR',
      message: 'Auth0 authentication is temporarily unavailable',
    });
  }

  const status = Number(error && (error.statusCode || error.status));
  if (status === 401 || status === 403) {
    if (error.headers && typeof error.headers === 'object') res.set(error.headers);
    else if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    return res.status(status).json({
      error: error.code || (status === 401 ? 'invalid_token' : 'forbidden'),
      message: status === 401 ? 'Authentication required' : 'Access forbidden',
    });
  }

  console.error(error);
  return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
});

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => console.log(`Tomo Yard server on :${PORT} (+ /ws world)`));
}

module.exports = {
  app,
  db,
  attachWorldServer,
  createServer,
  worldTicketTtlMs,
};
