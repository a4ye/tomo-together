// Reads the two D1 databases back over the REST API, rebuilds the original
// MongoDB documents from the relational rows, and deep-compares them against the
// EJSON export. Anything that does not round-trip is printed and the process
// exits non-zero.
//
//   CLOUDFLARE_API_TOKEN=… node migration/verify.mjs
//
// This is stricter than a row count: it proves the *content* of all 124
// documents survived, including array order inside hangouts and events.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { readCollection, MongoDate, ObjectId } from './ejson.mjs';

const ACCOUNT = 'b0e98c15b1f905a394ecd6a849e8e99f';
const APP_DB = 'db51fbf5-da82-42f1-b100-f10ec18182aa';
const CUSTODY_DB = '2a4334e3-9030-4d41-8349-2d1d33b1afd1';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is required');

const HERE = fileURLToPath(new URL('.', import.meta.url));
const EXPORT_DIR = join(HERE, '..', '..', 'azure-to-cf-migration', 'ht6-atlas-export');

async function query(db, sql) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${db}/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
    },
  );
  const body = await res.json();
  if (!body.success) throw new Error(`D1 query failed: ${JSON.stringify(body.errors)}`);
  return body.result[0].results;
}

/** Structural comparison. Arrays are order-sensitive; object key order is not. */
function diff(actual, expected, path = '') {
  if (expected instanceof MongoDate) {
    return actual === expected.ms ? null : `${path}: ${actual} !== Date(${expected.ms})`;
  }
  if (expected instanceof ObjectId) {
    return actual === expected.hex ? null : `${path}: ${actual} !== ObjectId(${expected.hex})`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: expected array, got ${inspect(actual)}`;
    if (actual.length !== expected.length) {
      return `${path}: array length ${actual.length} !== ${expected.length}`;
    }
    for (let i = 0; i < expected.length; i += 1) {
      const d = diff(actual[i], expected[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') {
      return `${path}: expected object, got ${inspect(actual)}`;
    }
    const ek = Object.keys(expected).sort();
    const ak = Object.keys(actual).sort();
    if (ek.join(',') !== ak.join(',')) return `${path}: keys ${ak.join(',')} !== ${ek.join(',')}`;
    for (const k of ek) {
      const d = diff(actual[k], expected[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return Object.is(actual, expected) ? null : `${path}: ${inspect(actual)} !== ${inspect(expected)}`;
}

const problems = [];
function check(label, rebuilt, expected) {
  const byId = new Map(rebuilt.map((d) => [JSON.stringify(d._id), d]));
  if (rebuilt.length !== expected.length) {
    problems.push(`${label}: rebuilt ${rebuilt.length} documents, export has ${expected.length}`);
  }
  for (const doc of expected) {
    const key = JSON.stringify(doc._id instanceof ObjectId ? doc._id.hex : doc._id);
    const got = byId.get(key);
    if (!got) {
      problems.push(`${label}: missing document ${key}`);
      continue;
    }
    const d = diff(got, doc, `${label}(${key})`);
    if (d) problems.push(d);
  }
  console.log(
    `${label.padEnd(20)} export=${String(expected.length).padStart(3)} d1=${String(rebuilt.length).padStart(3)} ${
      problems.length === 0 ? 'ok' : ''
    }`,
  );
}

const num = (v) => (v === null ? null : Number(v));
const parseJson = (v) => JSON.parse(v);

// ------------------------------------------------------------------ app db --

{
  const rows = await query(APP_DB, 'SELECT key, value FROM app_meta');
  check('app_meta', rows.map((r) => ({ _id: r.key, value: r.value })),
    readCollection(join(EXPORT_DIR, 'tomoyard__app_meta.jsonl')));
}
{
  const rows = await query(APP_DB, 'SELECT name, seq FROM counters');
  check('counters', rows.map((r) => ({ _id: r.name, seq: num(r.seq) })),
    readCollection(join(EXPORT_DIR, 'tomoyard__counters.jsonl')));
}
{
  const rows = await query(APP_DB, 'SELECT * FROM users');
  check(
    'users',
    rows.map((r) => ({
      _id: num(r.id),
      username: r.username,
      name: r.name,
      birthday: r.birthday,
      pass_hash: r.pass_hash,
      salt: r.salt,
      token: r.token,
      auth0_sub: r.auth0_sub,
      acorns: num(r.acorns),
      color: r.color,
      species: r.species,
      owned: parseJson(r.owned),
      equipped: parseJson(r.equipped),
      interests: parseJson(r.interests),
      pos_x: num(r.pos_x),
      pos_y: num(r.pos_y),
      created_at: r.created_at,
    })),
    readCollection(join(EXPORT_DIR, 'tomoyard__users.jsonl')),
  );
}
{
  const rows = await query(APP_DB, 'SELECT * FROM weights');
  check(
    'weights',
    rows.map((r) => ({
      _id: r.mongo_id,
      user_id: num(r.user_id),
      activity: r.activity,
      weight: num(r.weight),
    })),
    readCollection(join(EXPORT_DIR, 'tomoyard__weights.jsonl')),
  );
}
{
  const rows = await query(APP_DB, 'SELECT * FROM friendships');
  check(
    'friendships',
    rows.map((r) => ({
      _id: num(r.id),
      a_id: num(r.a_id),
      b_id: num(r.b_id),
      status: r.status,
      requested_by: num(r.requested_by),
      vibe: num(r.vibe),
      created_at: r.created_at,
    })),
    readCollection(join(EXPORT_DIR, 'tomoyard__friendships.jsonl')),
  );
}
{
  const [hangouts, members, confirms, stakes, settlements, nfc] = await Promise.all([
    query(APP_DB, 'SELECT * FROM hangouts'),
    query(APP_DB, 'SELECT * FROM hangout_members ORDER BY hangout_id, position'),
    query(APP_DB, 'SELECT * FROM confirms ORDER BY hangout_id, position'),
    query(APP_DB, 'SELECT * FROM hangout_stakes ORDER BY hangout_id, position'),
    query(APP_DB, 'SELECT * FROM hangout_settlements ORDER BY hangout_id, position'),
    query(APP_DB, 'SELECT * FROM nfc_tokens ORDER BY hangout_id, position'),
  ]);
  const group = (rows, map) => {
    const out = new Map();
    for (const r of rows) {
      const id = num(r.hangout_id);
      if (!out.has(id)) out.set(id, []);
      out.get(id).push(map(r));
    }
    return out;
  };
  const byMember = group(members, (r) => num(r.user_id));
  const byConfirm = group(confirms, (r) => ({ u1: num(r.u1), u2: num(r.u2), confirmed_at: r.confirmed_at }));
  const byStake = group(stakes, (r) => ({ user_id: num(r.user_id), staked_at: r.staked_at }));
  const bySettle = group(settlements, (r) => ({ user_id: num(r.user_id), status: r.status, payout_units: r.payout_units }));
  const byNfc = group(nfc, (r) => ({ user_id: num(r.user_id), token: r.token, expires_at: num(r.expires_at) }));

  check(
    'hangouts',
    hangouts.map((r) => {
      const id = num(r.id);
      return {
        _id: id,
        creator_id: num(r.creator_id),
        activity: r.activity,
        activity_label: r.activity_label,
        date: r.date,
        place: r.place,
        bonus_mult: num(r.bonus_mult),
        bonus_reason: r.bonus_reason,
        photo: r.photo,
        photo_by: num(r.photo_by),
        completed_at: r.completed_at,
        created_at: r.created_at,
        stake_units: r.stake_units,
        crypto_event_id: r.crypto_event_id,
        settled_at: r.settled_at,
        member_ids: byMember.get(id) ?? [],
        confirms: byConfirm.get(id) ?? [],
        stakes: byStake.get(id) ?? [],
        settlements: bySettle.get(id) ?? [],
        nfc_tokens: byNfc.get(id) ?? [],
      };
    }),
    readCollection(join(EXPORT_DIR, 'tomoyard__hangouts.jsonl')),
  );
}

// -------------------------------------------------------------- custody db --

{
  const rows = await query(CUSTODY_DB, 'SELECT * FROM crypto_users');
  check(
    'crypto_users',
    rows.map((r) => ({
      _id: r.external_user_id,
      externalUserId: r.external_user_id,
      balanceUnits: r.balance_units,
      lastGrantPeriod: r.last_grant_period,
      createdAt: num(r.created_at),
      updatedAt: num(r.updated_at),
    })),
    readCollection(join(EXPORT_DIR, 'ht6_crypto__crypto_users.jsonl')),
  );
}
{
  const [events, rsvps] = await Promise.all([
    query(CUSTODY_DB, 'SELECT * FROM crypto_events'),
    query(CUSTODY_DB, 'SELECT * FROM crypto_event_rsvps ORDER BY event_id, position'),
  ]);
  const byEvent = new Map();
  for (const r of rsvps) {
    if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, []);
    byEvent.get(r.event_id).push({
      userId: r.user_id,
      stakedUnits: r.staked_units,
      status: r.status,
      payoutUnits: r.payout_units,
    });
  }
  check(
    'crypto_events',
    events.map((r) => ({
      _id: r.id,
      id: r.id,
      host: r.host,
      title: r.title,
      startsAt: r.starts_at,
      stakeUnits: r.stake_units,
      multiplierBps: num(r.multiplier_bps),
      status: r.status,
      rsvps: byEvent.get(r.id) ?? [],
      createdAt: r.created_at,
      revision: num(r.revision),
      updatedAt: num(r.updated_at),
    })),
    readCollection(join(EXPORT_DIR, 'ht6_crypto__crypto_events.jsonl')),
  );
}
{
  const rows = await query(CUSTODY_DB, 'SELECT * FROM crypto_withdrawals');
  check(
    'crypto_withdrawals',
    rows.map((r) => ({
      _id: r.id,
      id: r.id,
      externalUserId: r.external_user_id,
      transferId: r.transfer_id,
      amountUnits: r.amount_units,
      destination: {
        chain_type: r.dest_chain_type,
        chain_id: r.dest_chain_id,
        token_address: r.dest_token_address,
        recipient_address: r.dest_recipient_address,
      },
      status: r.status,
      refunded: !!r.refunded,
      createdAt: r.created_at,
      updatedAt: num(r.updated_at),
    })),
    readCollection(join(EXPORT_DIR, 'ht6_crypto__crypto_withdrawals.jsonl')),
  );
}
{
  const rows = await query(CUSTODY_DB, 'SELECT * FROM crypto_idempotency');
  check(
    'crypto_idempotency',
    rows.map((r) => ({
      _id: r.id,
      externalUserId: r.external_user_id,
      referenceHash: r.reference_hash,
      reference: r.reference,
      operation: r.operation,
      requestedDeltaUnits: r.requested_delta_units,
      createdAt: num(r.created_at),
    })),
    readCollection(join(EXPORT_DIR, 'ht6_crypto__crypto_idempotency.jsonl')),
  );
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems.slice(0, 40)) console.error('  ' + p);
  process.exit(1);
}
console.log('\nAll 124 documents round-trip through D1 unchanged.');
