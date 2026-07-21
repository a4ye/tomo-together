// Stamps the Android release version before prebuild, preserving the existing
// contract: versionCode is the commit count and version.json (published beside
// the APK for the in-app updater) is written from the same values.
//
// Requires full git history (actions/checkout fetch-depth: 0).
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const versionCode = Number.parseInt(
  execSync('git rev-list --count HEAD', { encoding: 'utf8' }).trim(),
  10,
);
if (!Number.isInteger(versionCode) || versionCode < 1) {
  throw new Error(`Could not compute versionCode from git history: got ${versionCode}`);
}

const app = JSON.parse(readFileSync('app.json', 'utf8'));
app.expo.android = { ...app.expo.android, versionCode };
writeFileSync('app.json', `${JSON.stringify(app, null, 2)}\n`);

writeFileSync('version.json', JSON.stringify({
  versionCode,
  versionName: app.expo.version,
}));

console.log(`versionCode=${versionCode} versionName=${app.expo.version}`);
