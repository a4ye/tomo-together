# Self-hosted authentication (removing Auth0)

**Date:** 2026-07-21
**Status:** Approved (approach 1)

## Problem

Web login broke after the domain moved from `ht6-app.icinoxis.net` to
`app.tomo-together.com`: the Auth0 SPA client only whitelists the old origin, so
Auth0 rejects the new redirect with "Callback URL mismatch". Rather than keep
chasing Auth0 tenant configuration, we remove Auth0 entirely and restore the
project's original self-hosted username/password authentication.

## Decision

Reuse the pre-Auth0 auth design and code that still exists in the tree, disabled
behind the `ALLOW_LEGACY_AUTH` flag. Delete the Auth0 layer.

**Auth model (identical to the original):**
- username + password, `scrypt(password, salt)` hashed (Node `crypto.scryptSync`,
  32-byte key), salt = 8 random bytes hex.
- a static, non-expiring opaque bearer token = 24 random bytes hex (48 chars),
  stored on the user row and sent as `Authorization: Bearer <token>`.

The scrypt function and token format are kept byte-identical so every account
already migrated from SQLite into MongoDB (which preserved `pass_hash`, `salt`,
`token`) authenticates with no data change.

## Server changes (`server/index.js`, `server/db.js`, `server/package.json`)

- `auth` middleware simplifies to: extract bearer token, `store.users.findOne({ token })`,
  attach `req.user`. Remove the JWT branch, the `auth0_sub: null` filter, and
  token classification.
- Ungate `POST /auth/register` and `POST /auth/login` (drop `requireLegacyAuthEnabled`).
- Delete Auth0 onboarding surface: `GET/PUT /auth/profile`, `auth0Identity`,
  `requireAuth0Profile`, `provisionAuth0Profile`, `createAuth0JwtMiddleware`
  bootstrap, and all `./auth0` imports. Keep a tiny local `getBearerToken` helper.
- **Claim-on-login:** in `/auth/login`, if the matched user's `pass_hash` starts
  with `auth0-disabled:` (an unclaimed Auth0-era profile), set `pass_hash`/`salt`
  from the submitted password, mint a real `token`, clear `auth0_sub`, persist,
  and return `{ token, me }`. Otherwise verify normally. Register keeps rejecting
  taken usernames, so claiming happens through Sign in.
- Delete `server/auth0.js`, `server/test-auth0/`, and the
  `express-oauth2-jwt-bearer` dependency; update the `test` script's file globs.
- Remove the `auth0_sub` unique index from `db.js` (the field stays on documents).

## Client changes (`src/`, `App.tsx`, `app.config.ts`, `package.json`)

- Delete `src/auth.tsx`; drop the `react-native-auth0` dependency and the
  `react-native-auth0` Expo plugin block in `app.config.ts`.
- Restore `src/state/session.tsx` to the token model: `{ token, me }` persisted in
  AsyncStorage (localStorage on web so sessions survive reload), `signIn(token, me)`,
  `signOut()`, `setMe`, `refreshMe`. Keep the current same-subject profile caching.
- Restore `OnboardingScreen.tsx` to the register/login toggle form, **keeping the
  newer interests picker and avatar/species UI** so those features do not regress.
- `App.tsx`: remove `AuthProvider`; keep only `SessionProvider`. `authenticated`
  becomes `Boolean(token)`.

## Data / migration

Nothing to move. The SQLite -> Mongo migration already carried `pass_hash`,
`salt`, and `token` for every user. Original password accounts work immediately;
Auth0-era rows (placeholder `auth0-disabled:` password + real `auth0_sub`) are
claimed on first self-hosted login. A small read-only script reports counts
(password accounts vs. unclaimed Auth0 rows) to verify state.

## Config / docs cleanup

Remove `EXPO_PUBLIC_AUTH0_*` from `.env.example`, `.github/workflows/deploy-web.yml`
(and the validation step), and any APK workflow use. Update `README.md` and
`docs/production-setup.md` to describe self-hosted auth. Remove the `AUTH0_*`
inputs/app-settings from `infra/main.tf` and `infra/terraform.tfvars.example`;
the Terraform apply that drops the live App Service settings is called out as a
separate manual step because it touches production.

## Testing

Server tests (in-memory Mongo, `node --test`):
- register -> login -> `GET /me` happy path.
- wrong password -> 401; duplicate username -> 409.
- claim-on-login: seed an `auth0-disabled:` row, log in to set the password,
  confirm the token authenticates and a second login verifies normally.
- an unauthenticated protected route -> 401.

Drop the Auth0 JWT / JWKS test suites. Exercise the real end-to-end flow (server
running against a local Mongo, register + login over HTTP) before completion.

## Accepted side-effects

- No social login (Google/etc.) — username/password only, as the original was.
- Web tokens live in `localStorage` (XSS-stealable); the original behavior and
  standard for this class of app.
