// End-to-end staking exercise: app -> custody -> custody D1 and back.
//
//   CRYPTO_SERVICE_TOKEN=… node migration/smoke-stake.mjs
//
// This is the path the contract suites cannot touch, and it is the one that
// moves money. It runs entirely against the MIGRATED copies (both D1 databases
// and the R2 bucket); Azure, Atlas and Unifold are never contacted — the balances
// are seeded through custody's own /adjust route, which only writes the internal
// ledger. Every row it creates is prefixed `ctest_` and removed afterwards by
// migration/smoke-clean.sql.
//
// The scenario: two friends stake 2 USDC each on a hangout, one shows up and one
// flakes, and the flaker's stake is redistributed on settlement.
const APP = process.env.APP_URL ?? 'https://tomo-together-api.cloudflare-disjoin783.workers.dev';
const CUSTODY = process.env.CUSTODY_URL ?? 'https://tomo-together-custody.cloudflare-disjoin783.workers.dev';
const TOKEN = process.env.CRYPTO_SERVICE_TOKEN;
if (!TOKEN) throw new Error('CRYPTO_SERVICE_TOKEN is required');

const suffix = process.env.SMOKE_SUFFIX ?? `s${String(Date.now()).slice(-6)}`;
const A = `ctest_${suffix}a`;
const B = `ctest_${suffix}b`;
const SEED = '5000000'; // 5 USDC each
const STAKE = '2000000'; // 2 USDC

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
};

async function app(method, path, { token, body } = {}) {
  const init = { method, headers: {} };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(APP + path, init);
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text };
  }
}

async function custody(method, path, body) {
  const init = { method, headers: { Authorization: `Bearer ${TOKEN}` } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(CUSTODY + path, init);
  return { status: res.status, json: await res.json().catch(() => null) };
}

console.log(`accounts: ${A}, ${B}`);

const regA = await app('POST', '/auth/register', {
  body: { username: A, name: 'Stake A', birthday: '2000-01-01', password: 'hunter22' },
});
const regB = await app('POST', '/auth/register', {
  body: { username: B, name: 'Stake B', birthday: '2000-01-02', password: 'hunter22' },
});
check('registered both players', regA.status === 200 && regB.status === 200, [regA.json, regB.json]);
const tokenA = regA.json.token;
const tokenB = regB.json.token;

await app('POST', '/friends/request', { token: tokenA, body: { username: B } });
check('friends', (await app('POST', '/friends/accept', { token: tokenB, body: { username: A } })).status === 200);

// Registration provisions the custody ledger rows via cryptoApi.ensureUser().
for (const name of [A, B]) {
  const registered = await custody('POST', '/users/register', { externalUserId: `ty_${name}` });
  check(`custody user ty_${name} exists`, registered.status === 200, registered.json);
  const credited = await custody('POST', '/adjust', {
    externalUserId: `ty_${name}`,
    deltaUnits: SEED,
    reference: `ctest:seed:${suffix}:${name}`,
  });
  check(`seeded ty_${name} with ${SEED}`,
    credited.status === 200 && credited.json.balanceUnits === SEED, credited.json);
  const replay = await custody('POST', '/adjust', {
    externalUserId: `ty_${name}`,
    deltaUnits: SEED,
    reference: `ctest:seed:${suffix}:${name}`,
  });
  check(`the seed reference is idempotent for ty_${name}`,
    replay.json?.alreadyApplied === true && replay.json.balanceUnits === SEED, replay.json);
}

check('a reserved reference prefix is refused',
  (await custody('POST', '/adjust', {
    externalUserId: `ty_${A}`, deltaUnits: '1', reference: `settle:evt_x:ty_${A}`,
  })).json?.error === 'reference uses a reserved prefix');

// --------------------------------------------------------------- the stake --
const past = new Date(Date.now() - 3600_000).toISOString();
const created = await app('POST', '/hangouts', {
  token: tokenA,
  body: { activity: 'ramen', date: past, place: 'ctest', friendUsernames: [B], stakeUnits: STAKE },
});
check('POST /hangouts with a stake creates the crypto event',
  created.status === 200 && created.json.hangout.stake?.stakeUnits === STAKE, created.json);
const hid = created.json?.hangout?.id;
check('nobody is staked yet', created.json?.hangout?.stake?.poolUnits === '0', created.json?.hangout?.stake);

check('an invalid stake amount is refused',
  (await app('POST', '/hangouts', {
    token: tokenA,
    body: { activity: 'ramen', date: past, place: 'x', friendUsernames: [B], stakeUnits: '0' },
  })).json?.error === 'invalid_stake');

const stakeA = await app('POST', `/hangouts/${hid}/stake`, { token: tokenA });
check('A stakes', stakeA.status === 200 && stakeA.json.hangout.stake.iStaked === true, stakeA.json);
const stakeB = await app('POST', `/hangouts/${hid}/stake`, { token: tokenB });
check('B stakes', stakeB.status === 200 && stakeB.json.hangout.stake.poolUnits === '4000000', stakeB.json?.hangout?.stake);
check('staking twice is a no-op',
  (await app('POST', `/hangouts/${hid}/stake`, { token: tokenA })).json?.hangout?.stake?.poolUnits === '4000000');

for (const [name, expected] of [[A, '3000000'], [B, '3000000']]) {
  const user = await custody('GET', `/users/ty_${name}`);
  check(`ty_${name} was debited to ${expected}`, user.json?.balanceUnits === expected, user.json);
}

// A takes the photo, so A attended; B never taps, so B flakes.
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const form = new FormData();
form.append('photo', new File([png], 'proof.png', { type: 'image/png' }));
const photo = await fetch(`${APP}/hangouts/${hid}/photo`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${tokenA}` },
  body: form,
});
check('the photo uploads and does NOT auto-complete a staked hangout',
  photo.status === 200 && (await photo.clone().json()).hangout.completedAt === null);

const ended = await app('POST', `/hangouts/${hid}/end`, { token: tokenA });
check('POST /hangouts/:id/end settles', ended.status === 200 && ended.json.hangout.stake.settled === true, ended.json);
const members = ended.json?.hangout?.stake?.members ?? [];
const rowA = members.find((m) => m.username === A);
const rowB = members.find((m) => m.username === B);
check('the attendee is paid the whole pool',
  rowA?.settleStatus === 'attended' && rowA?.payoutUnits === '4000000', rowA);
check('the flaker forfeits their stake',
  rowB?.settleStatus === 'flaked' && rowB?.payoutUnits === '0', rowB);
check('the hangout is completed', typeof ended.json?.hangout?.completedAt === 'string');

for (const [name, expected] of [[A, '7000000'], [B, '3000000']]) {
  const user = await custody('GET', `/users/ty_${name}`);
  check(`ty_${name} final balance is ${expected}`, user.json?.balanceUnits === expected, user.json);
}
check('no money was created or destroyed',
  (await custody('GET', `/users/ty_${A}`)).json.balanceUnits === '7000000' &&
  (await custody('GET', `/users/ty_${B}`)).json.balanceUnits === '3000000');

// Settlement is idempotent: a replay must not credit anyone twice.
const replayEnd = await app('POST', `/hangouts/${hid}/end`, { token: tokenA });
check('ending twice is idempotent', replayEnd.status === 200);
check('balances are unchanged after the replay',
  (await custody('GET', `/users/ty_${A}`)).json.balanceUnits === '7000000');

const eventId = (await custody('GET', `/users/ty_${A}/events`)).json?.events?.[0];
check('the settled event is visible on the custody side',
  eventId?.status === 'settled' && eventId?.rsvps?.length === 2, eventId);
const settleReplay = await custody('POST', `/events/${eventId?.id}/settle`);
check('custody settle is idempotent too',
  settleReplay.json?.status === 'settled' && settleReplay.json?.forfeitPoolUnits === STAKE, settleReplay.json);

// The 403 policy gates that live production keeps closed.
check('/grant stays disabled',
  (await custody('POST', '/grant', { externalUserId: `ty_${A}` })).status === 403);
check('a treasury-funded multiplier stays disabled',
  (await custody('POST', '/events', {
    host: `ty_${A}`, title: 'x', stakeUnits: '1000000', multiplierBps: 12000,
  })).status === 403);

console.log(failures === 0 ? '\nall staking checks passed' : `\n${failures} staking check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
