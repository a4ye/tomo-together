#!/usr/bin/env node
'use strict';

const { exportAuth0Users, MigrationSafetyError } = require('./auth0-legacy-migration');

function usage() {
  return `Usage:
  node server/scripts/export-auth0-users.js --db <absolute-sqlite-path> --output <absolute-path-outside-repo> [--dry-run | --verify]

Modes:
  default    Validate five legacy users and write a private Auth0 import JSON file.
  --dry-run  Validate the database and destination without writing the file.
  --verify   Verify an existing output file exactly matches the current database.
`;
}

function parseArguments(argv) {
  const options = { dryRun: false, verify: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (argument === '--dry-run' || argument === '--verify') {
      if (seen.has(argument)) throw new Error(`Duplicate option: ${argument}`);
      seen.add(argument);
      options[argument === '--dry-run' ? 'dryRun' : 'verify'] = true;
      continue;
    }
    if (argument !== '--db' && argument !== '--output') throw new Error(`Unknown option: ${argument}`);
    if (seen.has(argument)) throw new Error(`Duplicate option: ${argument}`);
    seen.add(argument);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    options[argument === '--db' ? 'dbPath' : 'outputPath'] = value;
    index += 1;
  }
  if (!options.dbPath || !options.outputPath) throw new Error('Both --db and --output are required');
  return options;
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    const result = exportAuth0Users(options);
    process.stdout.write(
      `Auth0 legacy export ${result.mode} succeeded for ${result.count} users. Sensitive row data was not printed.\n`,
    );
  } catch (error) {
    const code = error instanceof MigrationSafetyError ? ` [${error.code}]` : '';
    process.stderr.write(`Auth0 legacy export refused${code}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { main, parseArguments };
