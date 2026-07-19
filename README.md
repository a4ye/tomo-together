# Tomo Yard

A hand-drawn (Neko Atsume style) friends app: real accounts, real hangouts, real proof
you showed up. React Native (Expo) Android app + a small self-hosted server.

## How it works

- **Profiles**: first launch asks for username, name, birthday, password, and your blob avatar color.
- **Friends by username**: search, send a request, they accept. Your friends wander your grass field wearing whatever their avatar has equipped.
- **Hangouts**: pick who is coming, then a Beli-style duel ("Which sounds better?") narrows down the activity from everyone's learned tastes. Every pick tunes your preference weights on the server.
- **Proof**: after the hangout, someone takes the photo, and every pair of attendees taps phones (NFC). One phone shows a tap code over HCE, the other scans it. When the photo is in and all pairs have tapped, the hangout is complete.
- **Memory Book**: completed hangouts become pinned polaroids.
- **Vibe**: each confirmed pair gains vibe for that friendship. Holidays and attendee birthdays pay x2. Leveling up a friendship pays both people acorns.
- **Acorns + Wardrobe**: buy hats, glasses, scarves for your avatar with acorns.
- **Leaderboard**: most completed hangouts this month among you and your friends.
- **Deposit (preview only)**: deposit crypto and set a monthly hangout quota, reclaim the deposit by meeting it. UI exists; no real money is moved yet.

## Run the server

```bash
cd server
npm install
node index.js        # listens on :4000, SQLite in server/data/
```

The app talks to the server over HTTP. The default server address in the app is
`http://100.66.193.176:4000` (this machine's Tailscale IP), editable on the sign-in screen.
Anyone who should use the app together must point at the same server.

## Build the app

```bash
export PATH=$HOME/.nvm/versions/node/v22.12.0/bin:$PATH   # system npm 12 breaks expo tooling
export ANDROID_HOME=$HOME/android-toolchain/sdk

npm install
npx expo run:android            # dev build
cd android && ./gradlew assembleRelease   # standalone APK
```

Ready-to-install APK: `tomo-yard.apk` at the repo root.

Note: `android/` contains hand-edits (NFC HCE service, manifest permissions,
cleartext HTTP). Do not run `npx expo prebuild --clean`, it would wipe them.

## NFC notes

- Scan side uses react-native-nfc-manager (IsoDep, custom AID `F0544F4D4F31`).
- Show side is a custom HostApduService (`android/app/src/main/java/.../HceService.kt`).
- Phones without NFC see a clear message; taps can only be confirmed on NFC hardware.
- The emulator has no NFC. The server API path was verified directly; the radio exchange needs two real phones.
