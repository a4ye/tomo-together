'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  MigrationSafetyError,
  backfillAuth0Subjects,
  exportAuth0Users,
  parseImportPayload,
} = require('../scripts/auth0-legacy-migration');

function temporaryWorkspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tomoyard-auth0-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function createLegacyDatabase(databasePath, {
  includeAuth0Subject = false,
  duplicateUsername = false,
  invalidHashAt = null,
} = {}) {
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      name TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      salt TEXT NOT NULL
      ${includeAuth0Subject ? ', auth0_sub TEXT' : ''}
    )
  `);
  const columns = includeAuth0Subject
    ? '(id, username, name, pass_hash, salt, auth0_sub) VALUES (?, ?, ?, ?, ?, NULL)'
    : '(id, username, name, pass_hash, salt) VALUES (?, ?, ?, ?, ?)';
  const insert = db.prepare(`INSERT INTO users ${columns}`);
  for (let id = 1; id <= 5; id += 1) {
    const salt = String(id).padStart(16, '0');
    const passHash = invalidHashAt === id
      ? 'not-a-scrypt-hash'
      : crypto.scryptSync(`secret-${id}`, salt, 32).toString('hex');
    const username = duplicateUsername && id === 5 ? 'legacy_1' : `legacy_${id}`;
    insert.run(id, username, `Legacy User ${id}`, passHash, salt);
  }
  db.close();
}

function readColumns(databasePath) {
  const db = new Database(databasePath, { readonly: true });
  try {
    return db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
  } finally {
    db.close();
  }
}

function assertSafetyCode(error, code) {
  return error instanceof MigrationSafetyError && error.code === code;
}

test('export writes the exact Auth0 scrypt schema without fabricating email data', (t) => {
  const directory = temporaryWorkspace(t);
  const databasePath = path.join(directory, 'legacy.sqlite');
  const outputPath = path.join(directory, 'auth0-import.json');
  createLegacyDatabase(databasePath);

  const dryRun = exportAuth0Users({ dbPath: databasePath, outputPath, dryRun: true });
  assert.deepEqual(dryRun, { mode: 'dry-run', count: 5, output: outputPath });
  assert.equal(fs.existsSync(outputPath), false);

  const written = exportAuth0Users({ dbPath: databasePath, outputPath });
  assert.deepEqual(written, { mode: 'write', count: 5, output: outputPath });
  const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(payload.length, 5);
  assert.deepEqual(payload[0], {
    user_id: 'tomoyard-1',
    username: 'legacy_1',
    name: 'Legacy User 1',
    custom_password_hash: {
      algorithm: 'scrypt',
      hash: {
        value: crypto.scryptSync('secret-1', '0000000000000001', 32).toString('hex'),
        encoding: 'hex',
      },
      salt: { value: '0000000000000001', encoding: 'utf8' },
      password: { encoding: 'utf8' },
      keylen: 32,
      cost: 16384,
      blockSize: 8,
      parallelization: 1,
    },
  });
  assert.equal(payload.some((record) => Object.hasOwn(record, 'email')), false);

  assert.deepEqual(
    exportAuth0Users({ dbPath: databasePath, outputPath, verify: true }),
    { mode: 'verify', count: 5, output: outputPath },
  );
});

test('export refuses invalid legacy formats, identity collisions, and repository output paths', (t) => {
  const directory = temporaryWorkspace(t);
  const invalidDatabase = path.join(directory, 'invalid.sqlite');
  const invalidOutput = path.join(directory, 'invalid.json');
  createLegacyDatabase(invalidDatabase, { invalidHashAt: 3 });
  assert.throws(
    () => exportAuth0Users({ dbPath: invalidDatabase, outputPath: invalidOutput }),
    (error) => assertSafetyCode(error, 'LEGACY_HASH_INVALID'),
  );
  assert.equal(fs.existsSync(invalidOutput), false);

  const collisionDatabase = path.join(directory, 'collision.sqlite');
  const collisionOutput = path.join(directory, 'collision.json');
  createLegacyDatabase(collisionDatabase, { duplicateUsername: true });
  assert.throws(
    () => exportAuth0Users({ dbPath: collisionDatabase, outputPath: collisionOutput }),
    (error) => assertSafetyCode(error, 'IMPORT_USERNAME_COLLISION'),
  );
  assert.equal(fs.existsSync(collisionOutput), false);

  const validDatabase = path.join(directory, 'valid.sqlite');
  createLegacyDatabase(validDatabase);
  const insideRepository = path.resolve(__dirname, 'must-not-be-written.json');
  assert.throws(
    () => exportAuth0Users({ dbPath: validDatabase, outputPath: insideRepository }),
    (error) => assertSafetyCode(error, 'PATH_INSIDE_REPOSITORY'),
  );
  assert.equal(fs.existsSync(insideRepository), false);
});

test('the export CLI never prints usernames, salts, or hashes to stdout', (t) => {
  const directory = temporaryWorkspace(t);
  const databasePath = path.join(directory, 'legacy.sqlite');
  const outputPath = path.join(directory, 'auth0-import.json');
  createLegacyDatabase(databasePath);
  const result = spawnSync(
    process.execPath,
    [
      path.resolve(__dirname, '../scripts/export-auth0-users.js'),
      '--db',
      databasePath,
      '--output',
      outputPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /succeeded for 5 users/);
  assert.doesNotMatch(result.stdout, /legacy_1/);
  assert.doesNotMatch(result.stdout, /0000000000000001/);
  assert.doesNotMatch(result.stdout, /[0-9a-f]{64}/);
});

test('import-file verification refuses extra fields and altered password parameters', () => {
  const canonical = Array.from({ length: 5 }, (_, offset) => {
    const id = offset + 1;
    const salt = String(id).padStart(16, '0');
    return {
      user_id: `tomoyard-${id}`,
      username: `legacy_${id}`,
      name: `Legacy User ${id}`,
      custom_password_hash: {
        algorithm: 'scrypt',
        hash: {
          value: crypto.scryptSync(`secret-${id}`, salt, 32).toString('hex'),
          encoding: 'hex',
        },
        salt: { value: salt, encoding: 'utf8' },
        password: { encoding: 'utf8' },
        keylen: 32,
        cost: 16384,
        blockSize: 8,
        parallelization: 1,
      },
    };
  });

  const withEmail = structuredClone(canonical);
  withEmail[0].email = 'fabricated@example.test';
  assert.throws(
    () => parseImportPayload(JSON.stringify(withEmail)),
    (error) => assertSafetyCode(error, 'IMPORT_FIELDS_INVALID'),
  );

  const wrongCost = structuredClone(canonical);
  wrongCost[0].custom_password_hash.cost = 4096;
  assert.throws(
    () => parseImportPayload(JSON.stringify(wrongCost)),
    (error) => assertSafetyCode(error, 'IMPORT_FORMAT_INVALID'),
  );
});

test('backfill dry-run is read-only; apply backs up then atomically links exactly five users', async (t) => {
  const directory = temporaryWorkspace(t);
  const databasePath = path.join(directory, 'legacy.sqlite');
  const importPath = path.join(directory, 'auth0-import.json');
  const backupPath = path.join(directory, 'legacy-before-auth0.sqlite');
  createLegacyDatabase(databasePath);
  exportAuth0Users({ dbPath: databasePath, outputPath: importPath });

  assert.deepEqual(
    await backfillAuth0Subjects({ dbPath: databasePath, importPath, dryRun: true }),
    { mode: 'dry-run', count: 5 },
  );
  assert.equal(readColumns(databasePath).includes('auth0_sub'), false);
  assert.equal(fs.existsSync(backupPath), false);

  await assert.rejects(
    () => backfillAuth0Subjects({
      dbPath: databasePath,
      importPath,
      backupPath,
      importJobId: 'job_completed123',
      confirmedSuccessCount: 4,
      confirmImportCompleted: true,
    }),
    (error) => assertSafetyCode(error, 'IMPORT_SUCCESS_COUNT_MISMATCH'),
  );
  assert.equal(readColumns(databasePath).includes('auth0_sub'), false);
  assert.equal(fs.existsSync(backupPath), false);

  const result = await backfillAuth0Subjects({
    dbPath: databasePath,
    importPath,
    backupPath,
    importJobId: 'job_completed123',
    confirmedSuccessCount: 5,
    confirmImportCompleted: true,
  });
  assert.equal(result.mode, 'apply');
  assert.equal(result.count, 5);
  assert.equal(result.backup, backupPath);
  assert.equal(fs.existsSync(backupPath), true);

  const db = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(
      db.prepare('SELECT id, auth0_sub FROM users ORDER BY id').all(),
      Array.from({ length: 5 }, (_, offset) => ({
        id: offset + 1,
        auth0_sub: `auth0|tomoyard-${offset + 1}`,
      })),
    );
    const index = db.prepare('PRAGMA index_list(users)').all()
      .find((entry) => entry.name === 'users_auth0_sub_unique');
    assert.equal(index.unique, 1);
    assert.equal(index.partial, 1);
  } finally {
    db.close();
  }

  const backup = new Database(backupPath, { readonly: true });
  try {
    assert.equal(backup.pragma('quick_check', { simple: true }), 'ok');
    assert.equal(backup.prepare('PRAGMA table_info(users)').all().some((column) => column.name === 'auth0_sub'), false);
  } finally {
    backup.close();
  }

  assert.deepEqual(
    await backfillAuth0Subjects({ dbPath: databasePath, importPath, verify: true }),
    { mode: 'verify', count: 5 },
  );
});

test('backfill refuses a pre-linked target before creating a backup', async (t) => {
  const directory = temporaryWorkspace(t);
  const databasePath = path.join(directory, 'legacy.sqlite');
  const importPath = path.join(directory, 'auth0-import.json');
  const backupPath = path.join(directory, 'should-not-exist.sqlite');
  createLegacyDatabase(databasePath, { includeAuth0Subject: true });
  exportAuth0Users({ dbPath: databasePath, outputPath: importPath });
  const db = new Database(databasePath);
  db.prepare('UPDATE users SET auth0_sub = ? WHERE id = 1').run('auth0|some-other-subject');
  db.close();

  await assert.rejects(
    () => backfillAuth0Subjects({
      dbPath: databasePath,
      importPath,
      backupPath,
      importJobId: 'job_completed123',
      confirmedSuccessCount: 5,
      confirmImportCompleted: true,
    }),
    (error) => assertSafetyCode(error, 'BACKFILL_ALREADY_LINKED'),
  );
  assert.equal(fs.existsSync(backupPath), false);
});

test('backfill rolls back all row/schema changes when the named index is unsafe', async (t) => {
  const directory = temporaryWorkspace(t);
  const databasePath = path.join(directory, 'legacy.sqlite');
  const importPath = path.join(directory, 'auth0-import.json');
  const backupPath = path.join(directory, 'pre-attempt.sqlite');
  createLegacyDatabase(databasePath, { includeAuth0Subject: true });
  exportAuth0Users({ dbPath: databasePath, outputPath: importPath });
  const before = new Database(databasePath);
  before.exec('CREATE INDEX users_auth0_sub_unique ON users(auth0_sub)');
  before.close();

  await assert.rejects(
    () => backfillAuth0Subjects({
      dbPath: databasePath,
      importPath,
      backupPath,
      importJobId: 'job_completed123',
      confirmedSuccessCount: 5,
      confirmImportCompleted: true,
    }),
    (error) => assertSafetyCode(error, 'AUTH0_INDEX_INVALID'),
  );
  assert.equal(fs.existsSync(backupPath), true);

  const after = new Database(databasePath, { readonly: true });
  try {
    assert.equal(after.prepare('SELECT COUNT(*) AS count FROM users WHERE auth0_sub IS NOT NULL').get().count, 0);
    const index = after.prepare('PRAGMA index_list(users)').all()
      .find((entry) => entry.name === 'users_auth0_sub_unique');
    assert.equal(index.unique, 0);
    assert.equal(index.partial, 0);
  } finally {
    after.close();
  }
});
