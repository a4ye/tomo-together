-- D1 schema for the Tomo Together app database (was MongoDB `tomoyard`).
--
-- The Mongo collections were themselves a port of an earlier SQLite schema, so
-- the sub-documents that Mongo embedded inside `hangouts` (member_ids, confirms,
-- stakes, settlements, nfc_tokens) go back to child tables here. Every child row
-- carries an explicit `position` so the original array ORDER round-trips exactly
-- — `hangoutView()` renders members and confirmed pairs in array order, and the
-- settlement mirror is written as a whole ordered array.
--
-- Every index in ht6-atlas-export/manifest.json is reproduced. `_id` becomes the
-- integer primary key (ids are allocated from `counters`, never ObjectIds),
-- except for `weights` whose Mongo _id was an ObjectId with no application
-- meaning; it is preserved verbatim in `mongo_id` so the export round-trips.

PRAGMA foreign_keys = OFF;

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  seq  INTEGER NOT NULL
);

CREATE TABLE app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE users (
  id         INTEGER PRIMARY KEY,
  username   TEXT NOT NULL,
  name       TEXT NOT NULL,
  -- name.toLowerCase() maintained on insert. GET /users/search matched `name`
  -- with a Mongo case-insensitive regex; SQLite's LIKE/lower() only fold ASCII,
  -- so the Unicode-aware fold is done in JS at write time and matched literally.
  name_folded TEXT NOT NULL DEFAULT '',
  birthday   TEXT NOT NULL,
  pass_hash  TEXT NOT NULL,
  salt       TEXT NOT NULL,
  token      TEXT NOT NULL,
  auth0_sub  TEXT,
  acorns     INTEGER NOT NULL DEFAULT 50,
  color      TEXT NOT NULL DEFAULT '#A8D8C8',
  species    TEXT NOT NULL DEFAULT 'cat',
  owned      TEXT NOT NULL DEFAULT '[]',
  equipped   TEXT NOT NULL DEFAULT '[]',
  interests  TEXT NOT NULL DEFAULT '[]',
  pos_x      REAL,
  pos_y      REAL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX users_username_unique  ON users (username);
CREATE UNIQUE INDEX users_token_unique     ON users (token);
-- Mongo reports this index as unique+non-sparse, but six live rows hold NULL.
-- SQLite's UNIQUE ignores NULLs, which is the semantics the original SQLite
-- schema had and the only one consistent with the exported data.
CREATE UNIQUE INDEX users_auth0_sub_unique ON users (auth0_sub);

CREATE TABLE weights (
  user_id  INTEGER NOT NULL,
  activity TEXT    NOT NULL,
  weight   REAL    NOT NULL DEFAULT 50,
  mongo_id TEXT,
  PRIMARY KEY (user_id, activity)
);

CREATE TABLE friendships (
  id           INTEGER PRIMARY KEY,
  a_id         INTEGER NOT NULL,
  b_id         INTEGER NOT NULL,
  status       TEXT    NOT NULL,
  requested_by INTEGER NOT NULL,
  vibe         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL
);
CREATE UNIQUE INDEX friendships_pair_unique ON friendships (a_id, b_id);
CREATE INDEX friendships_b_id ON friendships (b_id);

CREATE TABLE hangouts (
  id              INTEGER PRIMARY KEY,
  creator_id      INTEGER NOT NULL,
  activity        TEXT    NOT NULL,
  activity_label  TEXT    NOT NULL,
  date            TEXT    NOT NULL,
  place           TEXT    NOT NULL,
  bonus_mult      REAL    NOT NULL DEFAULT 1,
  bonus_reason    TEXT,
  photo           TEXT,
  photo_by        INTEGER,
  completed_at    TEXT,
  created_at      TEXT    NOT NULL,
  stake_units     TEXT,
  crypto_event_id TEXT,
  settled_at      TEXT
);
CREATE INDEX hangouts_date ON hangouts (date DESC);

-- Replaces the `hangouts.member_ids` array (index `hangouts_member_ids`).
CREATE TABLE hangout_members (
  hangout_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  position   INTEGER NOT NULL,
  PRIMARY KEY (hangout_id, user_id)
);
CREATE INDEX hangout_members_user ON hangout_members (user_id);

CREATE TABLE confirms (
  hangout_id   INTEGER NOT NULL,
  u1           INTEGER NOT NULL,
  u2           INTEGER NOT NULL,
  confirmed_at TEXT    NOT NULL,
  position     INTEGER NOT NULL,
  PRIMARY KEY (hangout_id, u1, u2)
);

CREATE TABLE hangout_stakes (
  hangout_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  staked_at  TEXT    NOT NULL,
  position   INTEGER NOT NULL,
  PRIMARY KEY (hangout_id, user_id)
);

CREATE TABLE hangout_settlements (
  hangout_id   INTEGER NOT NULL,
  user_id      INTEGER NOT NULL,
  status       TEXT    NOT NULL,
  payout_units TEXT    NOT NULL,
  position     INTEGER NOT NULL,
  PRIMARY KEY (hangout_id, user_id)
);

CREATE TABLE nfc_tokens (
  hangout_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  token      TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  position   INTEGER NOT NULL,
  PRIMARY KEY (hangout_id, user_id)
);
