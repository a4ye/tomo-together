'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const EXPECTED_LEGACY_USER_COUNT = 5;
const AUTH0_SUBJECT_PREFIX = 'auth0|tomoyard-';
const IMPORT_USER_ID_PREFIX = 'tomoyard-';
const INDEX_NAME = 'users_auth0_sub_unique';
const REPOSITORY_ROOT = fs.realpathSync(path.resolve(__dirname, '..', '..'));

class MigrationSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MigrationSafetyError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new MigrationSafetyError(code, message);
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveAbsoluteFilePath(input, label, { mustExist = false, outsideRepository = false } = {}) {
  if (typeof input !== 'string' || input.length === 0 || !path.isAbsolute(input)) {
    fail('PATH_NOT_ABSOLUTE', `${label} must be an explicit absolute path`);
  }

  const resolved = path.resolve(input);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    fail('PATH_PARENT_MISSING', `${label} parent directory must already exist`);
  }

  const realParent = fs.realpathSync(parent);
  const realCandidate = fs.existsSync(resolved)
    ? fs.realpathSync(resolved)
    : path.join(realParent, path.basename(resolved));

  if (outsideRepository && isPathInside(REPOSITORY_ROOT, realCandidate)) {
    fail('PATH_INSIDE_REPOSITORY', `${label} must be outside the repository`);
  }
  if (mustExist && (!fs.existsSync(realCandidate) || !fs.statSync(realCandidate).isFile())) {
    fail('PATH_MISSING', `${label} must identify an existing file`);
  }
  return realCandidate;
}

function resolveDatabasePath(input) {
  const resolved = resolveAbsoluteFilePath(input, 'Database path', { mustExist: true });
  if (!fs.statSync(resolved).isFile()) {
    fail('DATABASE_NOT_FILE', 'Database path must identify a file');
  }
  return resolved;
}

function tableColumns(db) {
  const columns = db.prepare('PRAGMA table_info(users)').all();
  if (columns.length === 0) fail('USERS_TABLE_MISSING', 'Database does not contain a users table');
  return new Set(columns.map((column) => column.name));
}

function requireLegacyColumns(columns) {
  for (const name of ['id', 'username', 'name', 'pass_hash', 'salt']) {
    if (!columns.has(name)) fail('USERS_SCHEMA_INVALID', `Users table is missing required column ${name}`);
  }
}

function validateLegacyRow(row, rowNumber) {
  if (!Number.isSafeInteger(row.id) || row.id <= 0) {
    fail('LEGACY_ID_INVALID', `Legacy row ${rowNumber} has an invalid numeric ID`);
  }
  if (typeof row.username !== 'string' || !/^[a-z0-9_]{3,20}$/.test(row.username)) {
    fail('LEGACY_USERNAME_INVALID', `Legacy row ${rowNumber} has an invalid username format`);
  }
  if (
    typeof row.name !== 'string' ||
    row.name.length < 1 ||
    row.name.length > 40 ||
    row.name.trim() !== row.name ||
    /[\u0000-\u001f\u007f]/.test(row.name)
  ) {
    fail('LEGACY_NAME_INVALID', `Legacy row ${rowNumber} has an invalid display-name format`);
  }
  if (typeof row.pass_hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.pass_hash)) {
    fail('LEGACY_HASH_INVALID', `Legacy row ${rowNumber} does not contain a 32-byte lowercase hex scrypt hash`);
  }
  // The legacy server generates an eight-byte salt and stores its hex text.
  // Auth0 must interpret that text as UTF-8, not decode it as hex bytes.
  if (typeof row.salt !== 'string' || !/^[0-9a-f]{16}$/.test(row.salt)) {
    fail('LEGACY_SALT_INVALID', `Legacy row ${rowNumber} does not contain the expected UTF-8 salt text`);
  }
}

function importRecordForRow(row) {
  return {
    user_id: `${IMPORT_USER_ID_PREFIX}${row.id}`,
    username: row.username,
    name: row.name,
    custom_password_hash: {
      algorithm: 'scrypt',
      hash: {
        value: row.pass_hash,
        encoding: 'hex',
      },
      salt: {
        value: row.salt,
        encoding: 'utf8',
      },
      password: {
        encoding: 'utf8',
      },
      keylen: 32,
      cost: 16384,
      blockSize: 8,
      parallelization: 1,
    },
  };
}

function assertNoCollisions(records) {
  const userIds = new Set();
  const usernames = new Set();
  for (const record of records) {
    if (userIds.has(record.user_id)) fail('IMPORT_USER_ID_COLLISION', 'Deterministic Auth0 user IDs collide');
    if (usernames.has(record.username)) fail('IMPORT_USERNAME_COLLISION', 'Legacy usernames collide');
    userIds.add(record.user_id);
    usernames.add(record.username);
  }
}

function buildImportRecords(db) {
  const columns = tableColumns(db);
  requireLegacyColumns(columns);
  const auth0Expression = columns.has('auth0_sub') ? 'auth0_sub' : 'NULL AS auth0_sub';
  const rows = db.prepare(
    `SELECT id, username, name, pass_hash, salt, ${auth0Expression} FROM users ORDER BY id`,
  ).all();
  const legacyRows = rows.filter((row) => row.auth0_sub === null);

  if (legacyRows.length !== EXPECTED_LEGACY_USER_COUNT) {
    fail(
      'LEGACY_COUNT_MISMATCH',
      `Refusing migration: expected exactly ${EXPECTED_LEGACY_USER_COUNT} unlinked legacy users`,
    );
  }

  legacyRows.forEach(validateLegacyRow);
  const records = legacyRows.map(importRecordForRow);
  assertNoCollisions(records);

  if (columns.has('auth0_sub')) {
    const existingSubjects = new Set(
      rows.filter((row) => row.auth0_sub !== null).map((row) => row.auth0_sub),
    );
    for (const row of legacyRows) {
      if (existingSubjects.has(`${AUTH0_SUBJECT_PREFIX}${row.id}`)) {
        fail('AUTH0_SUBJECT_COLLISION', 'A deterministic Auth0 subject is already assigned to another user');
      }
    }
  }
  return records;
}

function validateImportRecord(record, index) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    fail('IMPORT_FORMAT_INVALID', `Import entry ${index} is not an object`);
  }
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['custom_password_hash', 'name', 'user_id', 'username'])) {
    fail('IMPORT_FIELDS_INVALID', `Import entry ${index} contains missing or unexpected fields`);
  }
  const idMatch = /^tomoyard-([1-9]\d*)$/.exec(record.user_id);
  if (!idMatch || !Number.isSafeInteger(Number(idMatch[1]))) {
    fail('IMPORT_USER_ID_INVALID', `Import entry ${index} has an invalid deterministic user ID`);
  }
  const pseudoRow = {
    id: Number(idMatch[1]),
    username: record.username,
    name: record.name,
    pass_hash: record.custom_password_hash?.hash?.value,
    salt: record.custom_password_hash?.salt?.value,
  };
  validateLegacyRow(pseudoRow, index);
  const canonical = importRecordForRow(pseudoRow);
  if (JSON.stringify(record) !== JSON.stringify(canonical)) {
    fail('IMPORT_FORMAT_INVALID', `Import entry ${index} does not match the required Auth0 scrypt format`);
  }
  return pseudoRow.id;
}

function parseImportPayload(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    fail('IMPORT_JSON_INVALID', 'Auth0 import file is not valid JSON');
  }
  if (!Array.isArray(payload) || payload.length !== EXPECTED_LEGACY_USER_COUNT) {
    fail(
      'IMPORT_COUNT_MISMATCH',
      `Auth0 import file must contain exactly ${EXPECTED_LEGACY_USER_COUNT} entries`,
    );
  }
  payload.forEach(validateImportRecord);
  assertNoCollisions(payload);
  return payload;
}

function readImportFile(importPath) {
  const resolved = resolveAbsoluteFilePath(importPath, 'Auth0 import file', {
    mustExist: true,
    outsideRepository: true,
  });
  return {
    path: resolved,
    records: parseImportPayload(fs.readFileSync(resolved, 'utf8')),
  };
}

function openDatabase(dbPath, readonly) {
  return new Database(resolveDatabasePath(dbPath), {
    readonly,
    fileMustExist: true,
  });
}

function renderImportPayload(records) {
  const text = `${JSON.stringify(records, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > 500 * 1024) {
    fail('IMPORT_FILE_TOO_LARGE', 'Auth0 import file would exceed the 500KB bulk-import limit');
  }
  return text;
}

function writePrivateFileAtomic(destination, contents) {
  if (fs.existsSync(destination)) fail('OUTPUT_EXISTS', 'Output path already exists; refusing to overwrite it');
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
}

function planExport({ dbPath, outputPath }) {
  const output = resolveAbsoluteFilePath(outputPath, 'Auth0 import output', {
    outsideRepository: true,
  });
  const db = openDatabase(dbPath, true);
  try {
    return { output, records: buildImportRecords(db) };
  } finally {
    db.close();
  }
}

function exportAuth0Users({ dbPath, outputPath, dryRun = false, verify = false }) {
  if (dryRun && verify) fail('MODE_CONFLICT', 'Dry-run and verification modes are mutually exclusive');
  const plan = planExport({ dbPath, outputPath });
  const expected = renderImportPayload(plan.records);

  if (verify) {
    if (!fs.existsSync(plan.output) || !fs.statSync(plan.output).isFile()) {
      fail('OUTPUT_MISSING', 'Auth0 import output does not exist for verification');
    }
    const actualRecords = parseImportPayload(fs.readFileSync(plan.output, 'utf8'));
    if (JSON.stringify(actualRecords) !== JSON.stringify(plan.records)) {
      fail('OUTPUT_VERIFICATION_FAILED', 'Auth0 import output does not exactly match the database');
    }
    return { mode: 'verify', count: plan.records.length, output: plan.output };
  }

  if (!dryRun) writePrivateFileAtomic(plan.output, expected);
  return { mode: dryRun ? 'dry-run' : 'write', count: plan.records.length, output: plan.output };
}

function targetRowsForImport(db, records, { requireUnlinked }) {
  const columns = tableColumns(db);
  requireLegacyColumns(columns);
  const hasAuth0Subject = columns.has('auth0_sub');
  const selectSubject = hasAuth0Subject ? ', auth0_sub' : '';
  const select = db.prepare(
    `SELECT id, username, name, pass_hash, salt${selectSubject} FROM users WHERE id = ?`,
  );
  const rows = [];

  records.forEach((record, index) => {
    const id = validateImportRecord(record, index);
    const row = select.get(id);
    if (!row) fail('BACKFILL_USER_MISSING', `Imported legacy user ${index} is missing from SQLite`);
    validateLegacyRow(row, index);
    if (JSON.stringify(importRecordForRow(row)) !== JSON.stringify(record)) {
      fail('BACKFILL_SOURCE_MISMATCH', `Imported legacy user ${index} no longer matches SQLite`);
    }
    if (requireUnlinked && hasAuth0Subject && row.auth0_sub !== null) {
      fail('BACKFILL_ALREADY_LINKED', `Imported legacy user ${index} already has an Auth0 subject`);
    }
    rows.push(row);
  });

  const ids = new Set(rows.map((row) => row.id));
  const usernames = new Set(rows.map((row) => row.username));
  if (ids.size !== EXPECTED_LEGACY_USER_COUNT || usernames.size !== EXPECTED_LEGACY_USER_COUNT) {
    fail('BACKFILL_COLLISION', 'Imported legacy users contain an ID or username collision');
  }

  if (hasAuth0Subject) {
    const duplicate = db.prepare(
      `SELECT auth0_sub FROM users
       WHERE auth0_sub IS NOT NULL
       GROUP BY auth0_sub HAVING COUNT(*) > 1 LIMIT 1`,
    ).get();
    if (duplicate) fail('AUTH0_SUBJECT_COLLISION', 'SQLite already contains duplicate Auth0 subjects');

    const desired = new Set(rows.map((row) => `${AUTH0_SUBJECT_PREFIX}${row.id}`));
    const existing = db.prepare('SELECT id, auth0_sub FROM users WHERE auth0_sub IS NOT NULL').all();
    if (existing.some((row) => desired.has(row.auth0_sub) && !ids.has(row.id))) {
      fail('AUTH0_SUBJECT_COLLISION', 'A deterministic Auth0 subject is assigned to another SQLite user');
    }
  }
  return rows;
}

function inspectAuth0Index(db) {
  const entry = db.prepare('PRAGMA index_list(users)').all().find((index) => index.name === INDEX_NAME);
  if (!entry) return { exists: false, valid: false };
  const columns = db.prepare(`PRAGMA index_info(${INDEX_NAME})`).all().map((column) => column.name);
  const schema = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
  ).get(INDEX_NAME);
  const normalizedSql = String(schema?.sql || '').replace(/\s+/g, ' ').toLowerCase();
  const valid =
    entry.unique === 1 &&
    entry.partial === 1 &&
    columns.length === 1 &&
    columns[0] === 'auth0_sub' &&
    /where\s+auth0_sub\s+is\s+not\s+null/.test(normalizedSql);
  return { exists: true, valid };
}

function ensureAuth0Index(db) {
  const before = inspectAuth0Index(db);
  if (before.exists && !before.valid) {
    fail('AUTH0_INDEX_INVALID', `Existing ${INDEX_NAME} index does not have the required definition`);
  }
  if (!before.exists) {
    db.exec(
      `CREATE UNIQUE INDEX ${INDEX_NAME} ON users(auth0_sub) WHERE auth0_sub IS NOT NULL`,
    );
  }
  if (!inspectAuth0Index(db).valid) fail('AUTH0_INDEX_INVALID', 'Failed to create the Auth0 unique partial index');
}

function verifyBackfillInDatabase(db, records) {
  const columns = tableColumns(db);
  if (!columns.has('auth0_sub')) fail('BACKFILL_NOT_APPLIED', 'Users table has no auth0_sub column');
  if (!inspectAuth0Index(db).valid) fail('AUTH0_INDEX_INVALID', 'Auth0 unique partial index is missing or invalid');

  const desiredIds = records.map((record, index) => validateImportRecord(record, index));
  const lookup = db.prepare('SELECT auth0_sub FROM users WHERE id = ?');
  for (const id of desiredIds) {
    const row = lookup.get(id);
    if (!row || row.auth0_sub !== `${AUTH0_SUBJECT_PREFIX}${id}`) {
      fail('BACKFILL_VERIFICATION_FAILED', 'A migrated SQLite row has the wrong Auth0 subject');
    }
  }
  const duplicate = db.prepare(
    `SELECT auth0_sub FROM users WHERE auth0_sub IS NOT NULL
     GROUP BY auth0_sub HAVING COUNT(*) > 1 LIMIT 1`,
  ).get();
  if (duplicate) fail('AUTH0_SUBJECT_COLLISION', 'SQLite contains duplicate Auth0 subjects');
  return desiredIds.length;
}

function validateImportConfirmation({ importJobId, confirmedSuccessCount, confirmImportCompleted }) {
  if (confirmImportCompleted !== true) {
    fail('IMPORT_NOT_CONFIRMED', 'Apply mode requires --confirm-import-completed');
  }
  if (typeof importJobId !== 'string' || !/^job_[A-Za-z0-9_-]{3,200}$/.test(importJobId)) {
    fail('IMPORT_JOB_ID_INVALID', 'Apply mode requires a valid Auth0 import job ID');
  }
  if (confirmedSuccessCount !== EXPECTED_LEGACY_USER_COUNT) {
    fail(
      'IMPORT_SUCCESS_COUNT_MISMATCH',
      `Confirmed Auth0 import success count must be exactly ${EXPECTED_LEGACY_USER_COUNT}`,
    );
  }
}

async function createOnlineBackup(db, backupPath) {
  if (fs.existsSync(backupPath)) fail('BACKUP_EXISTS', 'Backup path already exists; refusing to overwrite it');
  await db.backup(backupPath);
  fs.chmodSync(backupPath, 0o600);

  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const check = backup.pragma('quick_check', { simple: true });
    if (check !== 'ok') fail('BACKUP_VERIFICATION_FAILED', 'SQLite online backup failed integrity verification');
  } finally {
    backup.close();
  }
}

function dryRunBackfill(dbPath, records) {
  const db = openDatabase(dbPath, true);
  try {
    const rows = targetRowsForImport(db, records, { requireUnlinked: true });
    const columns = tableColumns(db);
    if (columns.has('auth0_sub')) {
      const index = inspectAuth0Index(db);
      if (index.exists && !index.valid) {
        fail('AUTH0_INDEX_INVALID', `Existing ${INDEX_NAME} index does not have the required definition`);
      }
    }
    return rows.length;
  } finally {
    db.close();
  }
}

function verifyBackfill(dbPath, records) {
  const db = openDatabase(dbPath, true);
  try {
    return verifyBackfillInDatabase(db, records);
  } finally {
    db.close();
  }
}

async function applyBackfill({
  dbPath,
  records,
  backupPath,
  importJobId,
  confirmedSuccessCount,
  confirmImportCompleted,
}) {
  validateImportConfirmation({ importJobId, confirmedSuccessCount, confirmImportCompleted });
  const resolvedDatabase = resolveDatabasePath(dbPath);
  const resolvedBackup = resolveAbsoluteFilePath(backupPath, 'SQLite backup', {
    outsideRepository: true,
  });
  if (resolvedBackup === resolvedDatabase) fail('BACKUP_PATH_INVALID', 'Backup path must differ from the database');

  const db = new Database(resolvedDatabase, { fileMustExist: true });
  let began = false;
  try {
    // Validate once before making the online backup, then repeat under the
    // IMMEDIATE write lock so a concurrent change cannot alter the target set.
    targetRowsForImport(db, records, { requireUnlinked: true });
    await createOnlineBackup(db, resolvedBackup);

    db.exec('BEGIN IMMEDIATE');
    began = true;
    let columns = tableColumns(db);
    if (!columns.has('auth0_sub')) {
      db.exec('ALTER TABLE users ADD COLUMN auth0_sub TEXT');
      columns = tableColumns(db);
    }
    if (!columns.has('auth0_sub')) fail('USERS_SCHEMA_INVALID', 'Could not add auth0_sub to users');

    const rows = targetRowsForImport(db, records, { requireUnlinked: true });
    ensureAuth0Index(db);
    const update = db.prepare('UPDATE users SET auth0_sub = ? WHERE id = ? AND auth0_sub IS NULL');
    let updated = 0;
    for (const row of rows) {
      const result = update.run(`${AUTH0_SUBJECT_PREFIX}${row.id}`, row.id);
      if (result.changes !== 1) fail('BACKFILL_UPDATE_FAILED', 'A migrated SQLite row was not updated exactly once');
      updated += result.changes;
    }
    if (updated !== EXPECTED_LEGACY_USER_COUNT) {
      fail('BACKFILL_COUNT_MISMATCH', 'SQLite backfill updated an unexpected number of rows');
    }
    verifyBackfillInDatabase(db, records);
    db.exec('COMMIT');
    began = false;
    return { count: updated, backup: resolvedBackup, importJobId };
  } catch (error) {
    if (began) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the original migration error.
      }
    }
    throw error;
  } finally {
    db.close();
  }
}

async function backfillAuth0Subjects({
  dbPath,
  importPath,
  backupPath,
  importJobId,
  confirmedSuccessCount,
  confirmImportCompleted = false,
  dryRun = false,
  verify = false,
}) {
  if (dryRun && verify) fail('MODE_CONFLICT', 'Dry-run and verification modes are mutually exclusive');
  const { records } = readImportFile(importPath);
  if (verify) {
    return { mode: 'verify', count: verifyBackfill(dbPath, records) };
  }
  if (dryRun) {
    return { mode: 'dry-run', count: dryRunBackfill(dbPath, records) };
  }
  const applied = await applyBackfill({
    dbPath,
    records,
    backupPath,
    importJobId,
    confirmedSuccessCount,
    confirmImportCompleted,
  });
  return { mode: 'apply', ...applied };
}

module.exports = {
  AUTH0_SUBJECT_PREFIX,
  EXPECTED_LEGACY_USER_COUNT,
  MigrationSafetyError,
  backfillAuth0Subjects,
  buildImportRecords,
  exportAuth0Users,
  parseImportPayload,
  validateImportConfirmation,
};
