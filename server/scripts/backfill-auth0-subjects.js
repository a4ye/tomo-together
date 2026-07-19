#!/usr/bin/env node
'use strict';

const { backfillAuth0Subjects, MigrationSafetyError } = require('./auth0-legacy-migration');

function usage() {
  return `Usage:
  node server/scripts/backfill-auth0-subjects.js --db <absolute-sqlite-path> --import-file <absolute-import-json-outside-repo> --dry-run

  node server/scripts/backfill-auth0-subjects.js --db <absolute-sqlite-path> --import-file <absolute-import-json-outside-repo> --backup <absolute-backup-path-outside-repo> --import-job-id <job_id> --confirmed-success-count 5 --confirm-import-completed

  node server/scripts/backfill-auth0-subjects.js --db <absolute-sqlite-path> --import-file <absolute-import-json-outside-repo> --verify

Apply mode creates and integrity-checks an online SQLite backup, begins an IMMEDIATE
transaction, adds auth0_sub/the unique partial index when needed, and links exactly
the five imported IDs. It refuses to run without an explicitly confirmed completed
Auth0 import job and exact success count.
`;
}

function parsePositiveInteger(value, option) {
  if (!/^[1-9]\d*$/.test(value || '')) throw new Error(`${option} must be a positive integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${option} is outside the safe integer range`);
  return number;
}

function parseArguments(argv) {
  const options = { dryRun: false, verify: false, confirmImportCompleted: false };
  const booleanOptions = new Map([
    ['--dry-run', 'dryRun'],
    ['--verify', 'verify'],
    ['--confirm-import-completed', 'confirmImportCompleted'],
  ]);
  const valueOptions = new Map([
    ['--db', 'dbPath'],
    ['--import-file', 'importPath'],
    ['--backup', 'backupPath'],
    ['--import-job-id', 'importJobId'],
    ['--confirmed-success-count', 'confirmedSuccessCount'],
  ]);
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (seen.has(argument)) throw new Error(`Duplicate option: ${argument}`);
    seen.add(argument);
    if (booleanOptions.has(argument)) {
      options[booleanOptions.get(argument)] = true;
      continue;
    }
    if (!valueOptions.has(argument)) throw new Error(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    options[valueOptions.get(argument)] = argument === '--confirmed-success-count'
      ? parsePositiveInteger(value, argument)
      : value;
    index += 1;
  }

  if (!options.dbPath || !options.importPath) throw new Error('--db and --import-file are required');
  if (!options.dryRun && !options.verify) {
    for (const [property, option] of [
      ['backupPath', '--backup'],
      ['importJobId', '--import-job-id'],
      ['confirmedSuccessCount', '--confirmed-success-count'],
    ]) {
      if (options[property] === undefined) throw new Error(`${option} is required in apply mode`);
    }
    if (!options.confirmImportCompleted) {
      throw new Error('--confirm-import-completed is required in apply mode');
    }
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    const result = await backfillAuth0Subjects(options);
    process.stdout.write(
      `Auth0 subject backfill ${result.mode} succeeded for ${result.count} users. Sensitive row data was not printed.\n`,
    );
  } catch (error) {
    const code = error instanceof MigrationSafetyError ? ` [${error.code}]` : '';
    process.stderr.write(`Auth0 subject backfill refused${code}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = { main, parseArguments };
