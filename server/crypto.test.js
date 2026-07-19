'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const modulePath = require.resolve('./crypto');
const originalFetch = global.fetch;
const originalEnv = {
  url: process.env.CRYPTO_API_URL,
  token: process.env.CRYPTO_SERVICE_TOKEN,
  nodeEnv: process.env.NODE_ENV,
};
const TOKEN = 'test-service-token-0123456789abcdef';
const DEFAULT_URL = Symbol('default-url');

function load(url = DEFAULT_URL, nodeEnv = 'production') {
  if (url === DEFAULT_URL) url = 'https://crypto.example.test';
  if (url === null) delete process.env.CRYPTO_API_URL;
  else process.env.CRYPTO_API_URL = url;
  process.env.CRYPTO_SERVICE_TOKEN = TOKEN;
  process.env.NODE_ENV = nodeEnv;
  delete require.cache[modulePath];
  return require('./crypto');
}

function response(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function restore() {
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries({
    CRYPTO_API_URL: originalEnv.url,
    CRYPTO_SERVICE_TOKEN: originalEnv.token,
    NODE_ENV: originalEnv.nodeEnv,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete require.cache[modulePath];
}

test('CRYPTO_API_URL accepts only a safe origin', (t) => {
  t.after(restore);
  const { loadBaseUrl } = load();
  assert.equal(loadBaseUrl({ NODE_ENV: 'production', CRYPTO_API_URL: 'https://crypto.example.test/' }),
    'https://crypto.example.test');
  assert.equal(loadBaseUrl({ NODE_ENV: 'development', CRYPTO_API_URL: 'http://127.0.0.8:8787/' }),
    'http://127.0.0.8:8787');
  assert.equal(loadBaseUrl({ NODE_ENV: 'development', CRYPTO_API_URL: 'http://[::1]:8787/' }),
    'http://[::1]:8787');

  for (const url of [
    'http://crypto.example.test',
    'http://localhost:8787/path',
    'https://user:password@crypto.example.test',
    'https://crypto.example.test/api',
    'https://crypto.example.test?next=https://evil.test',
    'https://crypto.example.test#fragment',
    'file:///tmp/socket',
    'not a url',
  ]) {
    assert.equal(loadBaseUrl({ NODE_ENV: 'production', CRYPTO_API_URL: url }), null, url);
  }
});

test('invalid or incomplete configuration never receives the service token', async (t) => {
  t.after(restore);
  let fetches = 0;
  global.fetch = async () => {
    fetches += 1;
    return response(200, { ok: true });
  };
  for (const url of [null, 'http://crypto.example.test', 'https://crypto.example.test/path']) {
    const crypto = load(url);
    assert.equal(await crypto.ready(), false);
    await assert.rejects(crypto.addFunds('alice'), crypto.CryptoUnavailableError);
  }
  assert.equal(fetches, 0);
});

test('readiness uses public /ready and business calls use the bearer token', async (t) => {
  t.after(restore);
  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const path = new URL(url).pathname;
    if (path === '/ready') return response(200, { ok: true, state: 'ready', backend: 'mongodb' });
    if (path === '/users/register') return response(200, { ok: true, externalUserId: 'ty_alice' });
    if (path === '/users/ty_alice') return response(200, { balanceUnits: '100' });
    return response(404, { error: 'not found' });
  };

  const crypto = load();
  assert.equal(crypto.enabled(), false, 'unknown readiness fails closed');
  assert.equal(await crypto.ready(), true);
  await crypto.getWallet('alice');

  const readyRequest = requests.find(({ url }) => url.endsWith('/ready'));
  assert.equal(readyRequest.options.headers, undefined);
  for (const request of requests.filter(({ url }) => !url.endsWith('/ready'))) {
    assert.equal(request.options.headers.Authorization, `Bearer ${TOKEN}`);
  }
});

test('ensureUser registers without implicitly granting real funds', async (t) => {
  t.after(restore);
  const paths = [];
  global.fetch = async (url) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === '/ready') return response(200, { ok: true });
    return response(200, { ok: true });
  };

  const crypto = load();
  await crypto.ensureUser('alice');
  assert.deepEqual(paths, ['/ready', '/users/register']);
  await crypto.grantUser('alice');
  assert.equal(paths.at(-1), '/grant');
});

test('withdraw forwards the exact idempotency key and preserves 202', async (t) => {
  t.after(restore);
  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const path = new URL(url).pathname;
    if (path === '/ready') return response(200, { ok: true });
    if (path === '/withdraw') {
      return response(202, {
        ok: false,
        pending: true,
        withdrawalId: 'withdrawal-1',
        error: 'withdrawal is pending reconciliation; retry with the same Idempotency-Key',
      });
    }
    return response(200, { ok: true });
  };

  const crypto = load();
  const key = 'withdraw:alice:stable-key-1';
  const result = await crypto.withdraw('alice', '20000000', {
    chain_type: 'ethereum',
    chain_id: '8453',
    token_address: '0x0000000000000000000000000000000000000001',
    recipient_address: '0x1111111111111111111111111111111111111111',
  }, key);
  assert.equal(result.status, 202);
  assert.equal(result.data.pending, true);
  const request = requests.find(({ url }) => url.endsWith('/withdraw'));
  assert.equal(request.options.headers['Idempotency-Key'], key);
});

test('withdraw rejects invalid keys before any mutation', async (t) => {
  t.after(restore);
  let withdrawCalls = 0;
  global.fetch = async (url) => {
    if (new URL(url).pathname === '/ready') return response(200, { ok: true });
    if (new URL(url).pathname === '/withdraw') withdrawCalls += 1;
    return response(200, { ok: true });
  };
  const crypto = load();
  await assert.rejects(
    crypto.withdraw('alice', '20000000', {}, 'bad key'),
    { status: 400, code: 'invalid_idempotency_key' },
  );
  assert.equal(withdrawCalls, 0);
});

test('business conflicts are preserved while upstream failures stay generic', async (t) => {
  t.after(restore);
  let mode = 'conflict';
  global.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/ready') return response(200, { ok: true });
    if (path === '/users/register') return response(200, { ok: true });
    if (mode === 'conflict') return response(409, { error: 'key belongs to a different withdrawal' });
    return response(500, { error: 'mongodb password and internal details' });
  };

  const crypto = load();
  await assert.rejects(
    crypto.withdraw('alice', '20000000', {}, 'withdraw-key-123'),
    { status: 409, message: 'key belongs to a different withdrawal' },
  );
  mode = 'failure';
  await assert.rejects(
    crypto.getEvent('event-1'),
    (error) => {
      assert.equal(error.status, 500);
      assert.equal(error.message, 'Crypto service request failed. Please try again.');
      assert.equal(error.message.includes('mongodb'), false);
      return true;
    },
  );
});

test('a policy 403 does not poison readiness for ordinary wallet use', async (t) => {
  t.after(restore);
  global.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/ready') return response(200, { ok: true });
    if (path === '/grant') return response(403, { error: 'recurring real-USDC grants are disabled' });
    return response(200, { ok: true, balanceUnits: '0' });
  };
  const crypto = load();
  await assert.rejects(crypto.grantUser('alice'), { status: 403, code: 'crypto_policy_denied' });
  assert.equal(crypto.enabled(), true);
  await crypto.getWallet('alice');
});
