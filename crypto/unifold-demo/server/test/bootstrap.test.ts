import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import request from 'supertest';
import { app, startServer } from '../src/index.js';
import {
  closeStore,
  getStoreReadiness,
  initializeStore,
} from '../src/runtimeStore.js';

test('liveness stays available while readiness follows store initialization', async () => {
  const health = await request(app).get('/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true });

  const before = await request(app).get('/ready');
  assert.equal(before.status, 503);
  assert.equal(before.body.ok, false);
  assert.equal(before.body.state, 'uninitialized');

  await initializeStore();

  const afterInitialization = await request(app).get('/readyz');
  assert.equal(afterInitialization.status, 200);
  assert.deepEqual(afterInitialization.body, {
    ok: true,
    state: 'ready',
    backend: 'json',
  });
  assert.equal(getStoreReadiness().state, 'ready');
});

test('failed datastore initialization never invokes listen', async () => {
  let listenCalls = 0;
  let closeCalls = 0;

  await assert.rejects(
    startServer({
      installSignalHandlers: false,
      lifecycle: {
        async initializeStore() {
          throw new Error('MongoDB unreachable');
        },
        async closeStore() {
          closeCalls += 1;
        },
      },
      listen() {
        listenCalls += 1;
        throw new Error('listen must not run');
      },
    }),
    /MongoDB unreachable/,
  );

  assert.equal(listenCalls, 0);
  // There is no initialized resource to close when initialization itself fails.
  assert.equal(closeCalls, 0);
});

test('a listen failure closes the already initialized datastore', async () => {
  let closeCalls = 0;

  await assert.rejects(
    startServer({
      installSignalHandlers: false,
      lifecycle: {
        async initializeStore() {},
        async closeStore() {
          closeCalls += 1;
        },
      },
      listen() {
        throw new Error('port unavailable');
      },
    }),
    /port unavailable/,
  );

  assert.equal(closeCalls, 1);
});

test('server shutdown drains HTTP and closes its datastore exactly once', async () => {
  let initializeCalls = 0;
  let closeCalls = 0;
  const running = await startServer({
    port: 0,
    installSignalHandlers: false,
    lifecycle: {
      async initializeStore() {
        initializeCalls += 1;
      },
      async closeStore() {
        closeCalls += 1;
      },
    },
  });

  assert.equal(running.server.listening, true);
  assert.equal(initializeCalls, 1);

  const first = running.shutdown();
  const second = running.shutdown('SIGTERM');
  assert.strictEqual(second, first);
  await Promise.all([first, second, running.shutdown()]);

  assert.equal(running.server.listening, false);
  assert.equal(closeCalls, 1);
});

after(async () => {
  await closeStore();
});
