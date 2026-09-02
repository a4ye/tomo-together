-- D1 schema for the treasury-custody database (was MongoDB `ht6_crypto`).
--
-- Money is held as canonical integer STRINGS, exactly as the Mongo store did at
-- its API boundary. MongoDB kept them as strings too and only cast to Decimal128
-- inside update pipelines; SQLite has no 34-digit numeric type, so all ledger
-- arithmetic happens in JS BigInt and every balance write is a compare-and-swap
-- against the exact previous string (see worker/src/store/d1Store.ts). That
-- keeps the "atomic, no precision loss" property the pipeline provided.
--
-- Every index in ht6-atlas-export/manifest-custody.json is reproduced, including
-- the partial unique index on transferId.

PRAGMA foreign_keys = OFF;

CREATE TABLE crypto_users (
  external_user_id  TEXT PRIMARY KEY,
  balance_units     TEXT NOT NULL,
  last_grant_period TEXT,
  created_at        INTEGER NOT NULL, -- epoch ms (Mongo Date)
  updated_at        INTEGER NOT NULL  -- epoch ms (Mongo Date)
);
-- Mongo's `uniq_external_user_id`; _id and externalUserId are always equal.
CREATE UNIQUE INDEX uniq_external_user_id ON crypto_users (external_user_id);

CREATE TABLE crypto_withdrawals (
  id                     TEXT PRIMARY KEY,
  external_user_id       TEXT NOT NULL,
  -- NULL while the durable debit reservation has no provider transfer yet. The
  -- public shape maps NULL to ''.
  transfer_id            TEXT,
  amount_units           TEXT NOT NULL,
  dest_chain_type        TEXT NOT NULL,
  dest_chain_id          TEXT NOT NULL,
  dest_token_address     TEXT NOT NULL,
  dest_recipient_address TEXT NOT NULL,
  status                 TEXT NOT NULL,
  refunded               INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL, -- ISO string, as stored in Mongo
  updated_at             INTEGER NOT NULL
);
-- Mongo: unique on transferId with partialFilterExpression {$type:'string',$gt:''}
CREATE UNIQUE INDEX uniq_transfer_id ON crypto_withdrawals (transfer_id)
  WHERE transfer_id IS NOT NULL AND transfer_id <> '';
CREATE INDEX withdrawals_by_user ON crypto_withdrawals (external_user_id, created_at DESC);

CREATE TABLE crypto_events (
  id             TEXT PRIMARY KEY,
  host           TEXT NOT NULL,
  title          TEXT NOT NULL,
  starts_at      TEXT,
  stake_units    TEXT NOT NULL,
  multiplier_bps INTEGER NOT NULL,
  status         TEXT NOT NULL,
  created_at     TEXT NOT NULL, -- ISO string
  revision       INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX events_by_host ON crypto_events (host, created_at DESC);

-- Replaces the embedded `rsvps` array. `position` preserves array order, which
-- settlement depends on: the forfeit-pool remainder is handed to the first
-- `remainder` attendees in array order.
CREATE TABLE crypto_event_rsvps (
  event_id     TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  position     INTEGER NOT NULL,
  staked_units TEXT    NOT NULL,
  status       TEXT    NOT NULL,
  payout_units TEXT    NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX events_by_rsvp_user ON crypto_event_rsvps (user_id);

CREATE TABLE crypto_idempotency (
  id                    TEXT PRIMARY KEY, -- "ref_<sha256 hex>"
  external_user_id      TEXT NOT NULL,
  reference_hash        TEXT NOT NULL,
  reference             TEXT NOT NULL,
  operation             TEXT,
  requested_delta_units TEXT,
  created_at            INTEGER NOT NULL
);
CREATE UNIQUE INDEX uniq_user_reference_hash ON crypto_idempotency (external_user_id, reference_hash);
CREATE INDEX idempotency_created_at ON crypto_idempotency (created_at);

-- Transaction guard. D1 has no interactive transactions: a batch() is one
-- transaction, but a statement cannot branch on an earlier statement's result.
-- Writing a row here whose only legal value is 0 turns a failed precondition
-- into a constraint violation, which rolls the whole batch back. Every compound
-- money mutation starts with one of these (see worker/src/store/d1Store.ts).
CREATE TABLE _txn_guard (id INTEGER PRIMARY KEY CHECK (id = 0));
