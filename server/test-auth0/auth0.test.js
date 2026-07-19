'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  Auth0SubjectError,
  AuthConfigurationError,
  bindAuth0Subject,
  classifyBearerToken,
  createAuth0JwtMiddleware,
  extractAuth0Subject,
  getBearerToken,
  isLegacyAuthEnabled,
  isLegacyTokenAllowed,
  loadAuth0Config,
} = require('../auth0');

const configuredEnv = {
  AUTH0_ISSUER_BASE_URL: 'https://example.us.auth0.com',
  AUTH0_AUDIENCE: 'https://api.tomoyard.example',
};

test('loadAuth0Config returns frozen, normalized RS256 configuration', () => {
  const config = loadAuth0Config(configuredEnv);

  assert.deepEqual(config, {
    issuerBaseURL: 'https://example.us.auth0.com/',
    audience: 'https://api.tomoyard.example',
    tokenSigningAlg: 'RS256',
  });
  assert.equal(Object.isFrozen(config), true);
});

test('loadAuth0Config fails closed when either required variable is missing', () => {
  for (const env of [
    {},
    { AUTH0_ISSUER_BASE_URL: configuredEnv.AUTH0_ISSUER_BASE_URL },
    { AUTH0_AUDIENCE: configuredEnv.AUTH0_AUDIENCE },
  ]) {
    assert.throws(
      () => loadAuth0Config(env),
      (error) =>
        error instanceof AuthConfigurationError &&
        error.code === 'AUTH0_CONFIGURATION_MISSING' &&
        error.status === 503,
    );
  }
});

test('loadAuth0Config rejects unsafe or malformed issuer URLs', () => {
  for (const issuer of [
    'not-a-url',
    'http://example.us.auth0.com',
    'https://user:password@example.us.auth0.com',
    'https://example.us.auth0.com?tenant=other',
    'https://example.us.auth0.com#other',
  ]) {
    assert.throws(
      () => loadAuth0Config({ ...configuredEnv, AUTH0_ISSUER_BASE_URL: issuer }),
      (error) =>
        error instanceof AuthConfigurationError &&
        error.code === 'AUTH0_ISSUER_INVALID',
    );
  }
});

test('createAuth0JwtMiddleware constructs the official verifier and requires config', () => {
  assert.equal(typeof createAuth0JwtMiddleware({ env: configuredEnv }), 'function');
  assert.throws(
    () => createAuth0JwtMiddleware({ env: {} }),
    (error) => error instanceof AuthConfigurationError,
  );
  assert.throws(
    () =>
      createAuth0JwtMiddleware({
        config: {
          issuerBaseURL: configuredEnv.AUTH0_ISSUER_BASE_URL,
          audience: configuredEnv.AUTH0_AUDIENCE,
          tokenSigningAlg: 'HS256',
        },
      }),
    (error) => error.code === 'AUTH0_CONFIGURATION_INVALID',
  );
});

test('classifyBearerToken permits only exact legacy tokens on the legacy path', () => {
  const legacy = '0123456789abcdef'.repeat(3);

  assert.equal(classifyBearerToken(legacy), 'legacy');
  assert.equal(classifyBearerToken(legacy.toUpperCase()), 'legacy');
  assert.equal(classifyBearerToken(`${legacy}0`), 'invalid');
  assert.equal(classifyBearerToken(legacy.slice(1)), 'invalid');
  assert.equal(classifyBearerToken('opaque-token'), 'invalid');
  assert.equal(classifyBearerToken(''), 'missing');
  assert.equal(classifyBearerToken(null), 'missing');
});

test('JWT-looking tokens never become legacy candidates, even when malformed', () => {
  const jwtLike = [
    'eyJhbGciOiJSUzI1NiJ9.e30.signature',
    'not-base64.not-json.not-a-signature',
    '0123456789abcdef0123456789abcdef0123456789abcdef.',
    '..',
  ];

  for (const token of jwtLike) {
    assert.equal(classifyBearerToken(token), 'jwt');
    assert.equal(isLegacyTokenAllowed(token, { ALLOW_LEGACY_AUTH: 'true' }), false);
  }
});

test('legacy mode requires the explicit true flag and the exact token shape', () => {
  const legacy = 'a'.repeat(48);

  assert.equal(isLegacyAuthEnabled({ ALLOW_LEGACY_AUTH: 'true' }), true);
  assert.equal(isLegacyAuthEnabled({ ALLOW_LEGACY_AUTH: ' TRUE ' }), true);
  for (const value of [undefined, '', 'false', '1', 'yes', 'enabled']) {
    assert.equal(isLegacyAuthEnabled({ ALLOW_LEGACY_AUTH: value }), false);
  }
  assert.equal(isLegacyTokenAllowed(legacy, { ALLOW_LEGACY_AUTH: 'true' }), true);
  assert.equal(isLegacyTokenAllowed(legacy, { ALLOW_LEGACY_AUTH: 'false' }), false);
});

test('getBearerToken strictly parses one case-insensitive Bearer credential', () => {
  assert.equal(
    getBearerToken({ headers: { authorization: 'Bearer abc.def.ghi' } }),
    'abc.def.ghi',
  );
  assert.equal(getBearerToken({ headers: { authorization: 'bearer\tlegacy' } }), 'legacy');
  assert.equal(getBearerToken({ headers: { authorization: 'Basic legacy' } }), null);
  assert.equal(getBearerToken({ headers: { authorization: 'Bearer first, Bearer second' } }), null);
  assert.equal(getBearerToken({ headers: { authorization: 'Bearer has spaces' } }), null);
  assert.equal(getBearerToken({ headers: {} }), null);
});

test('extractAuth0Subject uses only a valid immutable subject claim', () => {
  const req = {
    auth: {
      payload: {
        sub: 'auth0|immutable-user-id',
        email: 'mutable@example.com',
      },
    },
  };

  assert.equal(extractAuth0Subject(req), 'auth0|immutable-user-id');
  for (const sub of [undefined, '', ' surrounded ', 'line\nbreak', 'x'.repeat(256)]) {
    assert.throws(
      () => extractAuth0Subject({ auth: { payload: { sub } } }),
      (error) => error instanceof Auth0SubjectError && error.status === 401,
    );
  }
});

test('bindAuth0Subject defines a non-writable request identity', () => {
  const req = { auth: { payload: { sub: 'google-oauth2|123' } } };
  let receivedError;

  bindAuth0Subject(req, {}, (error) => {
    receivedError = error;
  });

  assert.equal(receivedError, undefined);
  assert.equal(req.auth0Sub, 'google-oauth2|123');
  assert.throws(() => {
    req.auth0Sub = 'attacker-controlled';
  }, TypeError);
  assert.equal(req.auth0Sub, 'google-oauth2|123');
  assert.deepEqual(Object.getOwnPropertyDescriptor(req, 'auth0Sub'), {
    value: 'google-oauth2|123',
    enumerable: true,
    writable: false,
    configurable: false,
  });
});

test('bindAuth0Subject forwards invalid-subject errors to Express', () => {
  let receivedError;

  bindAuth0Subject({ auth: { payload: {} } }, {}, (error) => {
    receivedError = error;
  });

  assert.equal(receivedError instanceof Auth0SubjectError, true);
  assert.equal(receivedError.code, 'invalid_token');
});
