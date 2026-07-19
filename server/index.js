// Tomo Yard server: accounts, friends, hangouts, vibe, wardrobe, leaderboard.
const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

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

// --- crypto staking columns/tables (safe on existing DBs) ---
for (const stmt of [
  `ALTER TABLE hangouts ADD COLUMN stake_units TEXT`,        // USDC base units, null = no stake
  `ALTER TABLE hangouts ADD COLUMN crypto_event_id TEXT`,    // Unifold event id
  `ALTER TABLE hangouts ADD COLUMN settled_at TEXT`,
]) {
  try { db.exec(stmt); } catch { /* column exists */ }
}
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

const ACTIVITIES = [
  { id: 'ramen', label: 'Ramen' },
  { id: 'karaoke', label: 'Karaoke' },
  { id: 'hiking', label: 'Hiking' },
  { id: 'film', label: 'Movie Night' },
  { id: 'boardgames', label: 'Board Games' },
  { id: 'boba', label: 'Bubble Tea' },
  { id: 'climbing', label: 'Climbing' },
  { id: 'museum', label: 'Museum' },
  { id: 'picnic', label: 'Picnic' },
  { id: 'arcade', label: 'Arcade' },
  { id: 'beach', label: 'Beach Day' },
  { id: 'bookcafe', label: 'Book Cafe' },
];

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
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

function publicUser(u) {
  return {
    username: u.username,
    name: u.name,
    color: u.color,
    species: u.species,
    equipped: JSON.parse(u.equipped),
  };
}

function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  const u = db.prepare('SELECT * FROM users WHERE token = ?').get(t);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  req.user = u;
  next();
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

function hangoutView(h, meId) {
  const ids = memberIds(h.id);
  const members = ids.map((id) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return publicUser(u);
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
    stake,
  };
}

function maybeComplete(hangoutId) {
  const h = db.prepare('SELECT * FROM hangouts WHERE id = ?').get(hangoutId);
  if (!h || h.completed_at) return;
  const ids = memberIds(hangoutId);
  const need = (ids.length * (ids.length - 1)) / 2;
  const got = db.prepare('SELECT COUNT(*) c FROM confirms WHERE hangout_id = ?').get(hangoutId).c;
  if (h.photo && got >= need) {
    db.prepare('UPDATE hangouts SET completed_at = ? WHERE id = ?').run(now(), hangoutId);
  }
}

// ---------- auth ----------
app.post('/auth/register', (req, res) => {
  const { username, name, birthday, password, color, species } = req.body || {};
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
  db.prepare(`INSERT INTO users (username, name, birthday, pass_hash, salt, token, color, species, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(username, name, birthday, hash(password, salt), salt, token, color || '#A8D8C8',
      SPECIES.includes(species) ? species : 'cat', now());
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  cryptoApi.ensureUser(username).catch(() => {}); // best-effort wallet + monthly grant
  res.json({ token, me: meView(u) });
});

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!u || hash(password || '', u.salt) !== u.pass_hash)
    return res.status(401).json({ error: 'Wrong username or password' });
  cryptoApi.ensureUser(u.username).catch(() => {}); // top up monthly grant on sign-in
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
    owned: JSON.parse(u.owned),
    equipped: JSON.parse(u.equipped),
  };
}

app.get('/me', auth, (req, res) => res.json({ me: meView(req.user) }));

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

app.get('/activities/ranked', auth, (req, res) => {
  const usernames = String(req.query.with || '').split(',').filter(Boolean);
  const ids = [req.user.id];
  for (const un of usernames) {
    const u = db.prepare('SELECT id FROM users WHERE username = ?').get(un);
    if (u) ids.push(u.id);
  }
  const ranked = ACTIVITIES.map((a) => ({
    ...a,
    combined: ids.reduce((s, id) => s + weightOf(id, a.id), 0) / ids.length,
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
  const top = ACTIVITIES.map((a) => ({ ...a, combined: weightOf(me, a.id) + weightOf(u.id, a.id) }))
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
app.post('/hangouts', auth, async (req, res) => {
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

  // Optional crypto stake: create the event and stake the host up front, so a
  // failure (e.g. insufficient balance) aborts before any local hangout exists.
  let cryptoEventId = null;
  let stake = null;
  const wantStake = cryptoApi.enabled() && typeof stakeUnits === 'string' && /^[1-9]\d*$/.test(stakeUnits);
  if (wantStake) {
    try {
      await cryptoApi.ensureUser(req.user.username);
      for (const u of others) await cryptoApi.ensureUser(u.username).catch(() => {});
      const bps = Math.min(15000, Math.max(10000, Math.round(bonus.mult * 10000)));
      const ev = await cryptoApi.createEvent(req.user.username, act.label, stakeUnits, { multiplierBps: bps, startsAt: date });
      await cryptoApi.rsvp(ev.id, req.user.username); // host stakes now
      cryptoEventId = ev.id;
      stake = stakeUnits;
    } catch (e) {
      const msg = e instanceof cryptoApi.CryptoError ? e.message : 'Could not set up the stake';
      return res.status(e && e.status === 400 ? 400 : 502).json({ error: msg });
    }
  }

  const info = db.prepare(`INSERT INTO hangouts
    (creator_id, activity, activity_label, date, place, bonus_mult, bonus_reason, created_at, stake_units, crypto_event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, act.id, act.label, date, place || 'Somewhere', bonus.mult, bonus.reason, now(), stake, cryptoEventId);
  const hid = info.lastInsertRowid;
  const ins = db.prepare('INSERT INTO hangout_members (hangout_id, user_id) VALUES (?, ?)');
  for (const id of ids) ins.run(hid, id);
  if (cryptoEventId) {
    db.prepare('INSERT INTO hangout_stakes (hangout_id, user_id, staked_at) VALUES (?, ?, ?)')
      .run(hid, req.user.id, now()); // host already staked above
  }
  res.json({ hangout: hangoutView(db.prepare('SELECT * FROM hangouts WHERE id = ?').get(hid), req.user.id) });
});

// A member stakes into an existing staked hangout ("put your deposit in").
app.post('/hangouts/:id/stake', auth, async (req, res) => {
  const h = db.prepare('SELECT * FROM hangouts WHERE id = ?').get(req.params.id);
  if (!h || !memberIds(h.id).includes(req.user.id))
    return res.status(404).json({ error: 'Hangout not found' });
  if (!h.crypto_event_id) return res.status(400).json({ error: 'This hangout has no stake' });
  if (h.settled_at) return res.status(400).json({ error: 'Already settled' });
  const already = db.prepare('SELECT 1 FROM hangout_stakes WHERE hangout_id = ? AND user_id = ?').get(h.id, req.user.id);
  if (already) return res.status(400).json({ error: 'You already staked' });
  try {
    await cryptoApi.rsvp(h.crypto_event_id, req.user.username);
  } catch (e) {
    const msg = e instanceof cryptoApi.CryptoError ? e.message : 'Could not stake';
    return res.status(e && e.status === 400 ? 400 : 502).json({ error: msg });
  }
  db.prepare('INSERT INTO hangout_stakes (hangout_id, user_id, staked_at) VALUES (?, ?, ?)')
    .run(h.id, req.user.id, now());
  res.json({ hangout: hangoutView(db.prepare('SELECT * FROM hangouts WHERE id = ?').get(h.id), req.user.id) });
});

// Settle the pool: flakers (staked but never checked in) lose their deposit to
// the friends who actually showed. Allowed once the hangout has started.
app.post('/hangouts/:id/settle', auth, async (req, res) => {
  const h = db.prepare('SELECT * FROM hangouts WHERE id = ?').get(req.params.id);
  if (!h || !memberIds(h.id).includes(req.user.id))
    return res.status(404).json({ error: 'Hangout not found' });
  if (!h.crypto_event_id) return res.status(400).json({ error: 'This hangout has no stake' });
  if (h.settled_at) return res.status(400).json({ error: 'Already settled' });
  if (new Date(h.date).getTime() > Date.now())
    return res.status(400).json({ error: 'Cannot settle before the hangout starts' });
  let result;
  try {
    result = await cryptoApi.settle(h.crypto_event_id);
  } catch (e) {
    const msg = e instanceof cryptoApi.CryptoError ? e.message : 'Could not settle';
    return res.status(502).json({ error: msg });
  }
  // Mirror the outcome locally so views need no crypto call.
  const ins = db.prepare(`INSERT INTO hangout_settlements (hangout_id, user_id, status, payout_units)
    VALUES (?, ?, ?, ?) ON CONFLICT(hangout_id, user_id) DO UPDATE SET status = excluded.status, payout_units = excluded.payout_units`);
  for (const r of result.results || []) {
    const uname = String(r.userId).replace(/^ty_/, '');
    const u = db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
    if (u) ins.run(h.id, u.id, r.status, r.payoutUnits);
  }
  db.prepare('UPDATE hangouts SET settled_at = ? WHERE id = ?').run(now(), h.id);
  res.json({ hangout: hangoutView(db.prepare('SELECT * FROM hangouts WHERE id = ?').get(h.id), req.user.id) });
});

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
  db.prepare('UPDATE hangouts SET photo = ? WHERE id = ?').run(req.file.filename, h.id);
  maybeComplete(h.id);
  res.json({ hangout: hangoutView(db.prepare('SELECT * FROM hangouts WHERE id = ?').get(h.id), req.user.id) });
});

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
app.post('/hangouts/:id/confirm', auth, (req, res) => {
  const h = db.prepare('SELECT * FROM hangouts WHERE id = ?').get(req.params.id);
  if (!h || !memberIds(h.id).includes(req.user.id))
    return res.status(404).json({ error: 'Hangout not found' });
  const { username, token } = req.body || {};
  const other = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!other || !memberIds(h.id).includes(other.id))
    return res.status(400).json({ error: 'That person is not in this hangout' });
  if (other.id === req.user.id) return res.status(400).json({ error: 'Cannot confirm with yourself' });
  const t = db.prepare('SELECT * FROM nfc_tokens WHERE hangout_id = ? AND user_id = ?').get(h.id, other.id);
  if (!t || t.token !== token || t.expires_at < Date.now())
    return res.status(400).json({ error: 'Tap not valid, try again' });
  const [u1, u2] = pair(req.user.id, other.id);
  const already = db.prepare('SELECT 1 FROM confirms WHERE hangout_id = ? AND u1 = ? AND u2 = ?').get(h.id, u1, u2);
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
    // Proof of presence: check in each staker on the crypto event (best-effort).
    if (h.crypto_event_id) {
      for (const [uid, uname] of [[req.user.id, req.user.username], [other.id, other.username]]) {
        const staked = db.prepare('SELECT 1 FROM hangout_stakes WHERE hangout_id = ? AND user_id = ?').get(h.id, uid);
        if (staked) cryptoApi.checkin(h.crypto_event_id, uname).catch(() => {});
      }
    }
  }
  res.json({
    hangout: hangoutView(db.prepare('SELECT * FROM hangouts WHERE id = ?').get(h.id), req.user.id),
    vibeGain,
    acornGain,
    bonusReason: h.bonus_reason,
  });
});

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
app.get('/wallet', auth, async (req, res) => {
  if (!cryptoApi.enabled()) return res.json({ enabled: false });
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
    res.status(502).json({ enabled: true, error: e.message });
  }
});

app.post('/wallet/add-funds', auth, async (req, res) => {
  if (!cryptoApi.enabled()) return res.status(400).json({ error: 'Crypto is off' });
  try {
    const r = await cryptoApi.addFunds(req.user.username);
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/wallet/refresh', auth, async (req, res) => {
  if (!cryptoApi.enabled()) return res.status(400).json({ error: 'Crypto is off' });
  try {
    const r = await cryptoApi.refreshDeposits(req.user.username);
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/wallet/withdraw', auth, async (req, res) => {
  if (!cryptoApi.enabled()) return res.status(400).json({ error: 'Crypto is off' });
  const { amountUnits, destination } = req.body || {};
  try {
    const r = await cryptoApi.withdraw(req.user.username, amountUnits, destination);
    res.json(r);
  } catch (e) {
    const status = e instanceof cryptoApi.CryptoError && e.status === 400 ? 400 : 502;
    res.status(status).json({ error: e.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, name: 'tomo-yard' }));

app.listen(PORT, () => console.log(`Tomo Yard server on :${PORT}`));
