#!/usr/bin/env bash
# Versioned Android release build executed on the persistent Azure builder.
#
# The workflow sends values as NUL-delimited stdin fields in the order below.
# This keeps credentials and Expo public configuration out of the remote
# command line and avoids evaluating any value as shell code.
set -euo pipefail

configure_android_metro_cache_reset() {
  node <<'NODE'
const fs = require('fs');

const gradlePath = 'android/app/build.gradle';
const gradle = fs.readFileSync(gradlePath, 'utf8');
if (!/^\s*react\s*\{/m.test(gradle)) {
  throw new Error(`React Native Gradle extension not found in ${gradlePath}`);
}
fs.appendFileSync(gradlePath, `
// CI_METRO_RESET_CACHE: build-time EXPO_PUBLIC_* values must not be stale.
react {
    extraPackagerArgs = ["--reset-cache"]
}
`);
NODE
  grep -Fq 'extraPackagerArgs = ["--reset-cache"]' android/app/build.gradle
}

# A narrow validation entry point lets CI/tests apply this post-Prebuild step
# to a generated project without supplying or exposing deployment credentials.
if [[ "${1:-}" == "--configure-metro-cache-only" ]]; then
  configure_android_metro_cache_reset
  exit 0
fi

read_required() {
  local name="$1"
  local value

  if ! IFS= read -r -d '' value; then
    printf 'Missing build input: %s\n' "$name" >&2
    exit 1
  fi
  if [[ -z "$value" ]]; then
    printf 'Empty build input: %s\n' "$name" >&2
    exit 1
  fi

  printf -v "$name" '%s' "$value"
}

for name in \
  SHA \
  GH_TOKEN \
  KUDU_USER \
  KUDU_PASS \
  KEYSTORE_B64 \
  KEYSTORE_PASS \
  EXPO_PUBLIC_AUTH0_DOMAIN \
  EXPO_PUBLIC_AUTH0_CLIENT_ID \
  EXPO_PUBLIC_AUTH0_WEB_CLIENT_ID \
  EXPO_PUBLIC_AUTH0_AUDIENCE
do
  read_required "$name"
done

# Expo CLI reads the domain while resolving app.config.ts during Prebuild, and
# Metro reads all four values later when Gradle creates the release JS bundle.
export EXPO_PUBLIC_AUTH0_DOMAIN EXPO_PUBLIC_AUTH0_CLIENT_ID
export EXPO_PUBLIC_AUTH0_WEB_CLIENT_ID EXPO_PUBLIC_AUTH0_AUDIENCE

export ANDROID_HOME=/opt/android-sdk
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export PATH="$JAVA_HOME/bin:$PATH"

repo=/opt/build/repo
repo_url=https://github.com/a4ye/ht6-app.git
git_auth_header="Authorization: Basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
git_authenticated() {
  GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=http.extraHeader \
    GIT_CONFIG_VALUE_0="$git_auth_header" \
    git "$@"
}

if [[ ! -d "$repo/.git" ]]; then
  git_authenticated clone "$repo_url" "$repo"
fi

cd "$repo"
git remote set-url origin "$repo_url"
git_authenticated fetch --force origin "$SHA"
git checkout -f "$SHA"
npm install --prefer-offline --no-audit --no-fund

# Keep the existing release version contract: versionCode is the commit count,
# and version.json is published only after its matching APK is available.
version_code=$(git rev-list --count HEAD)
VERSION_CODE="$version_code" node <<'NODE'
const fs = require('fs');

const app = JSON.parse(fs.readFileSync('app.json', 'utf8'));
app.expo.android.versionCode = Number.parseInt(process.env.VERSION_CODE, 10);
fs.writeFileSync('app.json', `${JSON.stringify(app, null, 2)}\n`);
fs.writeFileSync('version.json', JSON.stringify({
  versionCode: app.expo.android.versionCode,
  versionName: app.expo.version,
}));
NODE
cat version.json

# Auth0's config plugin reads EXPO_PUBLIC_AUTH0_DOMAIN during Prebuild. Metro
# then reads all four exported EXPO_PUBLIC_* values while Gradle bundles JS.
# A clean generation prevents the persistent checkout from retaining native
# configuration produced by an earlier build.
EXPO_NO_GIT_STATUS=1 npx expo prebuild --clean --platform android --no-install

# Prebuild configures release bundling through `expo export:embed`. Configure
# the generated React Native Gradle extension itself so that the bundle task
# clears Metro's transform cache after build-time environment values change.
# This is deliberately applied after every clean generation because android/
# is ephemeral in this CNG workflow.
configure_android_metro_cache_reset

printf '%s' "$KEYSTORE_B64" | base64 -d > android/app/upload.keystore
printf '\norg.gradle.parallel=true\norg.gradle.caching=true\norg.gradle.jvmargs=-Xmx6g -XX:MaxMetaspaceSize=1g\n' >> android/gradle.properties

cd android
export TOMO_UPLOAD_STORE_FILE=upload.keystore
export TOMO_UPLOAD_STORE_PASSWORD="$KEYSTORE_PASS"
export TOMO_UPLOAD_KEY_ALIAS=tomo
export TOMO_UPLOAD_KEY_PASSWORD="$KEYSTORE_PASS"
./gradlew assembleRelease

cd "$repo"
apk=android/app/build/outputs/apk/release/app-release.apk
curl -sf -X PUT -u "$KUDU_USER:$KUDU_PASS" -H 'If-Match: *' \
  'https://ht6-tomoyard.scm.azurewebsites.net/api/vfs/data/apk/' || true
curl -sf -X PUT --data-binary @"$apk" -u "$KUDU_USER:$KUDU_PASS" -H 'If-Match: *' \
  'https://ht6-tomoyard.scm.azurewebsites.net/api/vfs/data/apk/tomo-yard.apk'
curl -sf -X PUT -u "$KUDU_USER:$KUDU_PASS" -H 'If-Match: *' \
  --data-binary @version.json \
  'https://ht6-tomoyard.scm.azurewebsites.net/api/vfs/data/apk/version.json'
cp "$apk" /opt/build/last.apk
echo BUILD_OK
