'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { after, before, test } = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomoyard-auth0-'));
process.env.DATA_DIR = dataDir;
process.env.SQLITE_JOURNAL = 'delete';
process.env.ALLOW_LEGACY_AUTH = 'true';
process.env.AUTH0_ISSUER_BASE_URL = 'https://test.us.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://api.test.tomoyard.invalid';
delete process.env.CRYPTO_API_URL;
delete process.env.CRYPTO_SERVICE_TOKEN;

const JWT_ONE = 'signed.jwt.one';
const JWT_CLAIM_IMPOSTOR = 'signed.jwt.claim-impostor';
const JWT_CONFIG_ERROR = 'signed.jwt.config-error';
const verifiedTokens = [];

// Exercise index.js as an HTTP application while replacing only the external
// signature/JWKS boundary. auth0.js's real parsing, classification and immutable
// subject binding still run as they do in production.
const auth0Path = require.resolve('../auth0');
const realAuth0 = require(auth0Path);
require.cache[auth0Path].exports = {
  ...realAuth0,
  createAuth0JwtMiddleware: () => (req, _res, next) => {
    const token = realAuth0.getBearerToken(req);
    verifiedTokens.push(token);
    if (token === JWT_CONFIG_ERROR) {
      return next(new realAuth0.AuthConfigurationError('test configuration failure'));
    }

    const payloads = {
      [JWT_ONE]: {
        sub: 'auth0|subject-1',
        email: 'legacy@example.invalid',
        username: 'legacy_user',
      },
      [JWT_CLAIM_IMPOSTOR]: {
        sub: 'auth0|claim-impostor',
        email: 'legacy@example.invalid',
        username: 'legacy_user',
      },
    };
    if (payloads[token]) {
      req.auth = { payload: payloads[token] };
      return next();
    }

    const error = new Error('signature verification failed');
    error.status = 401;
    error.code = 'invalid_token';
    error.headers = { 'WWW-Authenticate': 'Bearer error="invalid_token"' };
    return next(error);
  },
};

const { app, db } = require('../index');
let server;
let baseUrl;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function request(route, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: response.headers,
    json: await response.json(),
  };
}

test('startup migrates nullable auth0_sub with a unique partial index', () => {
  const column = db.prepare('PRAGMA table_info(users)').all()
    .find((entry) => entry.name === 'auth0_sub');
  assert.ok(column);
  assert.equal(column.notnull, 0);

  const index = db.prepare('PRAGMA index_list(users)').all()
    .find((entry) => entry.name === 'users_auth0_sub_unique');
  assert.ok(index);
  assert.equal(index.unique, 1);
  assert.equal(index.partial, 1);
  assert.deepEqual(
    db.prepare('PRAGMA index_info(users_auth0_sub_unique)').all().map((entry) => entry.name),
    ['auth0_sub'],
  );
});

test('legacy registration/login tokens remain compatible only behind the explicit flag', async () => {
  const registered = await request('/auth/register', {
    method: 'POST',
    body: {
      username: 'legacy_user',
      name: 'Legacy User',
      birthday: '2000-01-02',
      password: 'correct horse',
      color: '#A8D8C8',
      species: 'cat',
    },
  });
  assert.equal(registered.status, 200);
  assert.match(registered.json.token, /^[a-f0-9]{48}$/);

  const allowed = await request('/me', { token: registered.json.token });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.json.me.username, 'legacy_user');

  // Some pre-interests databases can surface a serialized null-like value.
  // Treat it as an empty list instead of leaking it or failing the profile read.
  db.prepare("UPDATE users SET interests = 'null' WHERE username = ?").run('legacy_user');
  const legacyNullInterests = await request('/me', { token: registered.json.token });
  assert.equal(legacyNullInterests.status, 200);
  assert.deepEqual(legacyNullInterests.json.me.interests, []);

  const jwtOnly = await request('/auth/profile', { token: registered.json.token });
  assert.equal(jwtOnly.status, 401);

  process.env.ALLOW_LEGACY_AUTH = 'false';
  const blocked = await request('/me', { token: registered.json.token });
  assert.equal(blocked.status, 401);
  const blockedLogin = await request('/auth/login', {
    method: 'POST',
    body: { username: 'legacy_user', password: 'correct horse' },
  });
  assert.equal(blockedLogin.status, 403);
  const blockedRegistration = await request('/auth/register', {
    method: 'POST',
    body: {
      username: 'blocked_user',
      name: 'Blocked User',
      birthday: '2000-01-02',
      password: 'correct horse',
      color: '#A8D8C8',
      species: 'cat',
    },
  });
  assert.equal(blockedRegistration.status, 403);
  process.env.ALLOW_LEGACY_AUTH = 'true';

  const loggedIn = await request('/auth/login', {
    method: 'POST',
    body: { username: 'legacy_user', password: 'correct horse' },
  });
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.json.token, registered.json.token);
});

test('JWT-looking credentials always use verification and never database fallback', async () => {
  db.prepare(`INSERT INTO users
    (username, name, birthday, pass_hash, salt, token, color, species, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('jwt_trap', 'JWT Trap', '2000-01-01', 'unused', 'unused',
      'stored.jwt.token', '#A8D8C8', 'cat', new Date().toISOString());

  const response = await request('/me', { token: 'stored.jwt.token' });
  assert.equal(response.status, 401);
  assert.equal(response.json.error, 'invalid_token');
  assert.ok(verifiedTokens.includes('stored.jwt.token'));
  assert.match(response.headers.get('www-authenticate'), /invalid_token/);
});

test('mutable token claims never attach an Auth0 identity to a legacy profile', async () => {
  const profile = await request('/auth/profile', { token: JWT_CLAIM_IMPOSTOR });
  assert.equal(profile.status, 200);
  assert.deepEqual(profile.json, { me: null });

  const protectedRoute = await request('/me', { token: JWT_CLAIM_IMPOSTOR });
  assert.equal(protectedRoute.status, 409);
  assert.deepEqual(protectedRoute.json, { error: 'PROFILE_REQUIRED' });

  const claimedUsername = await request('/auth/profile', {
    method: 'PUT',
    token: JWT_CLAIM_IMPOSTOR,
    body: {
      username: 'legacy_user',
      name: 'Claimed Legacy User',
      birthday: '2000-01-02',
      color: '#A8D8C8',
      species: 'cat',
    },
  });
  assert.equal(claimedUsername.status, 409);
  assert.deepEqual(claimedUsername.json, { error: 'Username is taken' });
  assert.equal(
    db.prepare('SELECT auth0_sub FROM users WHERE username = ?').get('legacy_user').auth0_sub,
    null,
  );
});

test('Auth0 profile onboarding is secure, idempotent, and unlocks existing routes', async () => {
  const missing = await request('/auth/profile', { token: JWT_ONE });
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.json, { me: null });

  const required = await request('/me', { token: JWT_ONE });
  assert.equal(required.status, 409);
  assert.deepEqual(required.json, { error: 'PROFILE_REQUIRED' });

  const submittedInterests = [
    'ramen',
    'not-a-real-activity',
    'ramen',
    'boba',
    'boardgames',
    'karaoke',
    'hiking',
    'yoga',
    'swimming',
    'beach',
    'cycling',
    'photography',
    'film',
    'museum',
    'sushi',
  ];
  const sanitizedInterests = [
    'ramen',
    'boba',
    'boardgames',
    'karaoke',
    'hiking',
    'yoga',
    'swimming',
    'beach',
    'cycling',
    'photography',
    'film',
    'museum',
  ];
  const body = {
    username: 'auth0_user',
    name: 'Auth0 User',
    birthday: '2001-02-03',
    color: '#123ABC',
    species: 'frog',
    interests: submittedInterests,
  };
  const created = await request('/auth/profile', { method: 'PUT', token: JWT_ONE, body });
  assert.equal(created.status, 201);
  assert.equal(created.json.me.username, body.username);
  assert.equal(created.json.me.name, body.name);
  assert.equal(created.json.me.birthday, body.birthday);
  assert.equal(created.json.me.color, body.color);
  assert.equal(created.json.me.species, body.species);
  assert.deepEqual(created.json.me.interests, sanitizedInterests);

  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(body.username);
  assert.equal(row.auth0_sub, 'auth0|subject-1');
  assert.deepEqual(JSON.parse(row.interests), sanitizedInterests);
  assert.equal(realAuth0.classifyBearerToken(row.token), 'invalid');
  assert.match(row.token, /^auth0-disabled:/);
  assert.match(row.pass_hash, /^auth0-disabled:/);

  const unusablePlaceholder = await request('/me', { token: row.token });
  assert.equal(unusablePlaceholder.status, 401);
  const noPasswordLogin = await request('/auth/login', {
    method: 'POST',
    body: { username: body.username, password: 'anything at all' },
  });
  assert.equal(noPasswordLogin.status, 401);

  const retried = await request('/auth/profile', {
    method: 'PUT',
    token: JWT_ONE,
    body: { ...body, username: 'changed_user', name: 'Changed Name' },
  });
  assert.equal(retried.status, 200);
  assert.deepEqual(retried.json.me, created.json.me);

  const protectedRoute = await request('/me', { token: JWT_ONE });
  assert.equal(protectedRoute.status, 200);
  assert.deepEqual(protectedRoute.json.me, created.json.me);

  const legacyFriend = db.prepare('SELECT * FROM users WHERE username = ?').get('legacy_user');
  const [aId, bId] = [legacyFriend.id, row.id].sort((a, b) => a - b);
  db.prepare(`INSERT INTO friendships (a_id, b_id, status, requested_by, created_at)
    VALUES (?, ?, 'accepted', ?, ?)`).run(
    aId,
    bId,
    legacyFriend.id,
    new Date().toISOString(),
  );
  const friendProfile = await request(`/friends/${body.username}`, { token: legacyFriend.token });
  assert.equal(friendProfile.status, 200);
  assert.deepEqual(friendProfile.json.friend.interests, [
    'Ramen',
    'Bubble Tea',
    'Board Games',
    'Karaoke',
    'Hiking',
    'Yoga',
    'Swimming',
    'Beach Day',
    'Cycling',
    'Photography',
    'Movie Night',
    'Museum',
  ]);

  assert.throws(
    () => db.prepare('UPDATE users SET auth0_sub = ? WHERE username = ?')
      .run('auth0|subject-1', 'legacy_user'),
    /UNIQUE constraint failed/,
  );
});

test('Auth0 verification and configuration errors have stable safe responses', async () => {
  const invalid = await request('/auth/profile', { token: 'bad.jwt.signature' });
  assert.equal(invalid.status, 401);
  assert.deepEqual(invalid.json, {
    error: 'invalid_token',
    message: 'Authentication required',
  });

  const unavailable = await request('/auth/profile', { token: JWT_CONFIG_ERROR });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.json, {
    error: 'AUTH0_CONFIGURATION_ERROR',
    message: 'Auth0 authentication is temporarily unavailable',
  });
});
