'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { once } = require('node:events');
const { after, before, test } = require('node:test');
const express = require('express');

const API_AUDIENCE = 'https://api.tomoyard.test';
const AUTH0_CLIENT_ID = 'test-native-client-id';
const KEY_ID = 'local-auth0-test-key';

let apiServer;
let apiUrl;
let discoveryRequests = 0;
let issuer;
let issuerServer;
let primaryPrivateKey;
let secondaryPrivateKey;

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createJwt(
  claims = {},
  { privateKey = primaryPrivateKey, header = {} } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const protectedHeader = {
    alg: 'RS256',
    typ: 'JWT',
    kid: KEY_ID,
    ...header,
  };
  const payload = {
    iss: issuer,
    aud: API_AUDIENCE,
    sub: 'auth0|real-jwks-test-user',
    iat: now,
    exp: now + 300,
    ...claims,
  };
  const signingInput = `${base64urlJson(protectedHeader)}.${base64urlJson(payload)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

function createUnsecuredJwt(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlJson({ alg: 'none', typ: 'JWT', kid: KEY_ID });
  const payload = base64urlJson({
    iss: issuer,
    aud: API_AUDIENCE,
    sub: 'auth0|none-alg-test-user',
    iat: now,
    exp: now + 300,
    ...claims,
  });
  return `${header}.${payload}.`;
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function requestWithToken(token) {
  const response = await fetch(`${apiUrl}/protected`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

before(async () => {
  const primaryKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  primaryPrivateKey = primaryKeyPair.privateKey;
  secondaryPrivateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

  const publicJwk = primaryKeyPair.publicKey.export({ format: 'jwk' });
  Object.assign(publicJwk, {
    alg: 'RS256',
    kid: KEY_ID,
    use: 'sig',
  });

  issuerServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/.well-known/openid-configuration') {
      discoveryRequests += 1;
      res.end(JSON.stringify({
        issuer,
        jwks_uri: `http://127.0.0.1:${issuerServer.address().port}/.well-known/jwks.json`,
        id_token_signing_alg_values_supported: ['RS256'],
      }));
      return;
    }
    if (req.url === '/.well-known/jwks.json') {
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  const issuerPort = await listen(issuerServer);

  // Production issuers must remain HTTPS. For this hermetic integration test,
  // only discovery transport is redirected to the local HTTP fixture before
  // the SDK captures https.get; token issuer validation stays HTTPS-exact.
  issuer = `https://127.0.0.1:${issuerPort}/`;
  const originalHttpsGet = https.get;
  https.get = function getLocalDiscovery(input, options, callback) {
    const localUrl = new URL(input);
    localUrl.protocol = 'http:';
    return http.get(localUrl, options, callback);
  };

  let createAuth0JwtMiddleware;
  try {
    ({ createAuth0JwtMiddleware } = require('../auth0'));
  } finally {
    https.get = originalHttpsGet;
  }

  const app = express();
  app.get(
    '/protected',
    createAuth0JwtMiddleware({
      config: {
        issuerBaseURL: issuer,
        audience: API_AUDIENCE,
        tokenSigningAlg: 'RS256',
      },
    }),
    (req, res) => res.json({ sub: req.auth.payload.sub }),
  );
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || error.status || 500).json({
      error: error.code || 'server_error',
    });
  });

  apiServer = http.createServer(app);
  const apiPort = await listen(apiServer);
  apiUrl = `http://127.0.0.1:${apiPort}`;
});

after(async () => {
  await Promise.all([
    apiServer && new Promise((resolve) => apiServer.close(resolve)),
    issuerServer && new Promise((resolve) => issuerServer.close(resolve)),
  ]);
});

test('real Auth0 middleware accepts an RS256 API access token from local JWKS', async () => {
  const response = await requestWithToken(createJwt());

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { sub: 'auth0|real-jwks-test-user' });
  assert.equal(discoveryRequests, 1);
});

test('real Auth0 middleware rejects tokens with an invalid signature', async () => {
  const response = await requestWithToken(createJwt({}, { privateKey: secondaryPrivateKey }));

  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'invalid_token');
});

test('real Auth0 middleware rejects tokens from the wrong issuer', async () => {
  const response = await requestWithToken(createJwt({ iss: 'https://attacker.invalid/' }));

  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'invalid_token');
});

test('real Auth0 middleware rejects tokens for the wrong API audience', async () => {
  const response = await requestWithToken(createJwt({ aud: 'https://other-api.invalid' }));

  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'invalid_token');
});

test('real Auth0 middleware rejects expired access tokens', async () => {
  const now = Math.floor(Date.now() / 1000);
  const response = await requestWithToken(createJwt({ iat: now - 600, exp: now - 60 }));

  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'invalid_token');
});

test('real Auth0 middleware rejects alg none and malformed tokens', async (t) => {
  for (const [name, token] of [
    ['alg none', createUnsecuredJwt()],
    ['malformed compact JWT', 'not-a-jwt'],
  ]) {
    await t.test(name, async () => {
      const response = await requestWithToken(token);
      assert.equal(response.status, 401);
      assert.equal(response.body.error, 'invalid_token');
    });
  }
});

test('real Auth0 middleware rejects an ID token with the client audience', async () => {
  const response = await requestWithToken(createJwt({
    aud: AUTH0_CLIENT_ID,
    nonce: 'test-login-nonce',
  }));

  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'invalid_token');
});
