# Production setup: Auth0, MongoDB Atlas, and crypto

This is the operator runbook for the hackathon deployment. It deliberately never
contains secret values. Replace every `<PLACEHOLDER>` locally or in the relevant
dashboard; do not paste secrets into chat, commit them, or put them in an
`EXPO_PUBLIC_*` variable.

The safest rollout order is:

1. authorize the setup tools;
2. configure Auth0 and Atlas;
3. provision and verify the crypto service while the public feature gate is off;
4. configure Auth0 on the API and in a newly built client;
5. enable `CRYPTO_API_URL` on the main API last;
6. run the acceptance checks, then remove temporary access.

Removing `CRYPTO_API_URL` is the immediate crypto kill switch. Keep it unset until
the crypto service, Atlas persistence, and server-to-server authentication pass.

### Provisioned-state snapshot (19 July 2026)

The following public configuration has already been created. This is an inventory,
not evidence that every feature has passed its production smoke test:

- Auth0 tenant `dev-pl0mpi58gl7p2wxu.us.auth0.com`, Native application
  `Tomo Yard Mobile`, SPA `TomoYard`, and API `Tomo Yard API` exist.
- Atlas project `Tomo Yard Hackathon` (`6a5c8b960ecad0390bf7a9a7`) contains the
  M0 cluster `tomo-yard`. Database user `tomo-yard-crypto` has only `readWrite` on
  `ht6_crypto`.
- Azure Key Vault `ht6tomoyardkv4831` exists with the four required secret names.
  Secret values are intentionally not recorded here.
- The four public Auth0 GitHub Actions variables are configured for
  `a4ye/ht6-app`. `AZURE_CRYPTO_WEBAPP_PUBLISH_PROFILE` is also set and was last
  verified at `2026-07-19T09:00:43Z`; its value was never written to the repo.
- Phase-one Terraform applied three creates and one in-place update with no
  destroys and `crypto_enabled = false`. The running, HTTPS-only
  `ht6-tomoyard-crypto` App Service has a system-assigned identity, `/ready` health
  path, and the Key Vault Secrets User role. All four Key Vault references report
  `Resolved`.
- The main API has the exact Auth0 issuer/audience and
  `ALLOW_LEGACY_AUTH=true`, but no `CRYPTO_API_URL`.
- Atlas contains all 25 exact possible-outbound IPv4 `/32` entries for the crypto
  App Service, plus one pre-existing temporary workstation entry. No broad entry
  was added. HTTPS `/ready` currently times out because no crypto artifact has been
  deployed yet (HTTP redirects to HTTPS). Deploy and pass `/ready` before setting
  `crypto_enabled = true`.

## What the user needs to do

The lowest-hassle handoff uses browser/device login. It does not require sharing an
Azure, Auth0, or Atlas password.

### 1. Azure: approve one CLI login

Install the [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-windows),
then run this in the shared terminal:

```powershell
$env:AZURE_CONFIG_DIR = Join-Path $env:TEMP 'ht6-azure-cli'
az login --use-device-code
az account set --subscription '<AZURE_SUBSCRIPTION_ID>'
az account show --query '{subscription:name, tenant:tenantId}' -o table
```

The account needs resource-group-scoped access to create the crypto service and
permission to change settings on the existing `ht6-tomoyard` App Service. Avoid
subscription-wide Owner access. Interactive Azure login supports MFA and is the
[recommended CLI flow](https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli-interactively).

### 2. Auth0: approve CLI access

The tenant is already created. Install the
[official Auth0 CLI](https://auth0.github.io/auth0-cli/) and run:

```powershell
auth0 login
auth0 tenants list
auth0 tenants use 'dev-pl0mpi58gl7p2wxu.us.auth0.com'
```

Choose **As a user** and confirm that the code shown in the browser matches the
terminal. Full one-off setup requires tenant Admin. Do not share the Auth0 account
password. A temporary tenant member or a least-privilege Management API M2M client
is the safer alternative when human Admin access is too broad; remove it afterward.
[Auth0 documents dashboard-member roles here](https://auth0.com/docs/get-started/manage-dashboard-access/feature-access-by-role).

`Auth0.txt` is a local-only setup scratch file and is ignored in all practical case
variants. Do not commit or quote its contents; move any needed public identifiers to
the appropriate `.env.local`/Terraform input, then keep the scratch file local.

### 3. Atlas: approve project-only access

The dedicated project already exists. For the quickest one-off setup, install the
[Atlas CLI](https://www.mongodb.com/docs/atlas/cli/current/install-atlas-cli/)
and approve its browser login:

```powershell
atlas auth login
atlas auth whoami
```

For tighter access, create an eight-hour project Service Account with only
**Project Owner**, use it for provisioning, then revoke it. Project Owner is broad
inside that one project but does not grant organization-wide access. Atlas
[recommends Service Accounts instead of legacy API keys](https://www.mongodb.com/docs/atlas/configure-api-access/).

### 4. Confirm the local Unifold source file exists

`somevariables.txt` must remain local and ignored. Do not paste its contents into a
ticket, PR, chat, or terminal output. Its three labels map exactly as follows:

| Label in `somevariables.txt` | Production variable | Key Vault secret |
| --- | --- | --- |
| `publishable` | `UNIFOLD_PUBLISHABLE_KEY` | `unifold-publishable-key` |
| `Secret` | `UNIFOLD_SECRET_KEY` | `unifold-secret-key` |
| `ethereum treasury id` | `TREASURY_ACCOUNT_ID` | `treasury-account-id` |

The Atlas SRV URI is the fourth Key Vault secret, `mongodb-uri`. Verify names only:

```powershell
az keyvault secret list --vault-name 'ht6tomoyardkv4831' --query '[].name' -o tsv
```

All three should be present in production even though the current crypto server
does not read the publishable key. Never place the secret key or treasury
credential in the Expo app. Keep live treasury funds and transfer limits small for
the demo.

### 5. Approve GitHub deployment access

The new crypto service deploys through GitHub Actions. Approve the official GitHub
CLI browser flow; do not send a personal access token in chat:

```powershell
gh auth login --hostname github.com --git-protocol https --web --clipboard --skip-ssh-key
gh auth status --hostname github.com
```

The account needs repository write access to set the production secret. Add the
crypto App Service publish profile through the hidden prompt:

```powershell
gh secret set AZURE_CRYPTO_WEBAPP_PUBLISH_PROFILE --repo 'a4ye/ht6-app'
gh variable set EXPO_PUBLIC_AUTH0_DOMAIN --body 'dev-pl0mpi58gl7p2wxu.us.auth0.com' --repo 'a4ye/ht6-app'
gh variable set EXPO_PUBLIC_AUTH0_CLIENT_ID --body '2L56i2yM9IQeyVbAa9IrvvCFPqRDEDwy' --repo 'a4ye/ht6-app'
gh variable set EXPO_PUBLIC_AUTH0_WEB_CLIENT_ID --body 'BPyKeYjxBEeYPUALcdhUoGaSRcKylpkX' --repo 'a4ye/ht6-app'
gh variable set EXPO_PUBLIC_AUTH0_AUDIENCE --body 'https://ht6.icinoxis.net/api' --repo 'a4ye/ht6-app'
```

GitHub documents the [browser login](https://cli.github.com/manual/gh_auth_login)
and [encrypted Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).
The publish profile is a credential even though it is XML; never commit it. The four
Auth0 entries are public build configuration and belong in Actions variables, not
secrets. The APK and web workflows must pass those variables into their Expo build
steps; merely defining them in GitHub does not inject them automatically.

After these five actions, the coordinator can complete the remaining provisioning.

## Configuration matrix

`EXPO_PUBLIC_*` values are embedded in the app bundle and are **not secrets**.
Everything else below is server-side configuration. Values shown as "same" must be
byte-for-byte identical across the two services.

| Runtime | Variable | Required | Meaning / source |
| --- | --- | --- | --- |
| Expo app | `EXPO_PUBLIC_AUTH0_DOMAIN` | yes | `dev-pl0mpi58gl7p2wxu.us.auth0.com` |
| Expo app | `EXPO_PUBLIC_AUTH0_CLIENT_ID` | yes | Native public client ID `2L56i2yM9IQeyVbAa9IrvvCFPqRDEDwy` |
| Expo web | `EXPO_PUBLIC_AUTH0_WEB_CLIENT_ID` | for web | SPA public client ID `BPyKeYjxBEeYPUALcdhUoGaSRcKylpkX` |
| Expo app | `EXPO_PUBLIC_AUTH0_AUDIENCE` | yes | `https://ht6.icinoxis.net/api` |
| Main API | `AUTH0_ISSUER_BASE_URL` | yes | `https://dev-pl0mpi58gl7p2wxu.us.auth0.com/` |
| Main API | `AUTH0_AUDIENCE` | yes | Same API Identifier used by the client |
| Main API | `ALLOW_LEGACY_AUTH` | migration only | Set exactly `true` while old opaque tokens must still work; set `false` after migration |
| Main API | `CRYPTO_API_URL` | enable switch | HTTPS origin of the crypto service, with no trailing path |
| Main API | `CRYPTO_SERVICE_TOKEN` | with crypto | Terraform-generated 32+ byte random value; identical on both services |
| Crypto service | `CRYPTO_SERVICE_TOKEN` | yes | Same Terraform-generated value; rejects unauthenticated money requests |
| Crypto service | `MONGODB_URI` | yes | Atlas SRV connection string for the application database user |
| Crypto service | `MONGODB_DB_NAME` | yes | Dedicated database name; Terraform defaults to `ht6_crypto` |
| Crypto service | `CRYPTO_STORE_BACKEND` | yes | Must be `mongodb` in production; Terraform sets it explicitly |
| Crypto service | `UNIFOLD_SECRET_KEY` | yes | `Secret` from `somevariables.txt` |
| Crypto service | `UNIFOLD_PUBLISHABLE_KEY` | requested | `publishable` from `somevariables.txt`; currently retained as deployment configuration only |
| Crypto service | `TREASURY_ACCOUNT_ID` | yes | `ethereum treasury id` from `somevariables.txt` |
| Crypto service | `TREASURY_SOURCE_CHAIN_ID` | yes | `8453` for Base mainnet |
| Crypto service | `UNIFOLD_WEBHOOK_SECRET` | when webhooks are enabled | Signing secret returned during webhook registration |
| Crypto service | `CREDIT_LIMIT_UNITS` | optional | Defaults to `0`; do not allow debt for the demo |
| Crypto service | `CASHOUT_THRESHOLD_UNITS` | optional | Defaults to `20000000` USDC base units |
| Crypto service | `ENABLE_RECURRING_REAL_USDC_GRANTS` | dangerous opt-in | Omit in production; only exact `true` enables automatic real-USDC grants |
| Crypto service | `ENABLE_RAW_BALANCE_ADJUSTMENTS` | dangerous opt-in | Omit in production; only exact `true` exposes the general adjustment route |
| Crypto service | `ENABLE_TREASURY_FUNDED_EVENT_BONUSES` | dangerous opt-in | Omit in production; only exact `true` permits treasury-funded bonus payouts |
| Crypto service | `DATA_DIR` | fallback only | Local fallback storage path; Atlas is the production source of truth |

Azure injects `PORT`; do not treat it as a credential. The four external
credentials are not Terraform variables: they already live in Key Vault and App
Service receives Key Vault references. Never commit `terraform.tfvars`, state,
`Auth0.txt`, or `somevariables.txt`. App Service setting changes restart the app,
while
[Key Vault references](https://learn.microsoft.com/en-us/azure/app-service/app-service-key-vault-references)
keep credential values out of App Service and Terraform configuration.

The current non-secret Terraform inputs map as follows:

| Terraform input | Runtime destination | Default |
| --- | --- | --- |
| `crypto_key_vault_name` | Vault used by four Crypto Key Vault references | `ht6tomoyardkv4831` |
| `mongodb_db_name` | Crypto `MONGODB_DB_NAME` | `ht6_crypto` |
| `auth0_issuer_base_url` | Main `AUTH0_ISSUER_BASE_URL` | none |
| `auth0_audience` | Main `AUTH0_AUDIENCE` | none |
| `allow_legacy_auth` | Main `ALLOW_LEGACY_AUTH` | `false` |
| `crypto_enabled` | Controls whether Main receives `CRYPTO_API_URL` | `false` |

`CRYPTO_SERVICE_TOKEN` is generated by Terraform and injected into both services;
it is intentionally not an operator input. That generated server-to-server token
is sensitive and remains in Terraform state, so protect the state file.

The exact production request boundaries are:

| Public/main API | Internal crypto API | Authentication |
| --- | --- | --- |
| `GET /wallet` | `POST /users/register`, then `GET /users/:externalUserId` | Auth0/temporary legacy bearer to Main; service bearer to Crypto |
| `POST /wallet/add-funds` | `POST /add-funds` | Same two-hop boundary |
| `POST /wallet/refresh` | `POST /deposits/refresh` | Same two-hop boundary |
| `POST /wallet/withdraw` | `POST /withdraw` | Same two-hop boundary plus exactly one `Idempotency-Key` header |
| none | `GET /withdrawals/:withdrawalId` | Service bearer; reconciliation/status endpoint |
| none | `GET /health`, `GET /ready`, `GET /readyz` | Public probes; no business data |
| none | `POST /webhooks/unifold` | Unifold HMAC signature, not the service bearer |

All other crypto business routes sit behind `CRYPTO_SERVICE_TOKEN`. The main API
never receives the MongoDB URI, Unifold key, publishable key, or treasury ID.

## Configure Auth0

The app uses the Auth0 provider SDK, not a home-grown password exchange. Follow the
[Auth0 React Native + Expo quickstart](https://auth0.com/docs/quickstart/native/react-native-expo).

### 1. Verify the API

In **Applications -> APIs**, verify the provisioned `Tomo Yard API`:

- Identifier: `https://ht6.icinoxis.net/api`.
- Signing algorithm: `RS256`.
- Allow Offline Access: on; the client requests `offline_access`.

The identifier is a logical audience and does not need to resolve as a URL. The API
validates access tokens using Auth0's JWKS, issuer, audience, expiry, and RS256.
Never send an ID token to the API. Auth0's
[Node/Express quickstart](https://auth0.com/docs/quickstart/backend/nodejs) and
[token validation guide](https://auth0.com/docs/secure/tokens/access-tokens/validate-access-tokens)
describe this boundary.

### 2. Verify the Native application

`Tomo Yard Mobile` is type **Native**, with public client ID
`2L56i2yM9IQeyVbAa9IrvvCFPqRDEDwy`. Authorization Code and Refresh Token grants
and refresh-token rotation are enabled. Do not copy a Native client secret into the
app; native clients are public clients and use PKCE.

Use these exact templates in both **Allowed Callback URLs** and **Allowed Logout
URLs**, substituting the real Auth0 domain without `https://`:

```text
tomoyard://dev-pl0mpi58gl7p2wxu.us.auth0.com/ios/com.anonymous.friendsthing/callback
tomoyard://dev-pl0mpi58gl7p2wxu.us.auth0.com/android/com.anonymous.friendsthing/callback
```

Do not add a trailing slash or wildcard. The callback scheme (`tomoyard`), Android
package, iOS bundle identifier, app config, and SDK calls must agree exactly.

### 3. Verify the web application

`TomoYard` is a **Single Page Application** with public client ID
`BPyKeYjxBEeYPUALcdhUoGaSRcKylpkX`. Its current settings are:

```text
Allowed Callback URLs:  https://ht6-app.icinoxis.net
Allowed Logout URLs:    https://ht6-app.icinoxis.net
Allowed Web Origins:    https://ht6-app.icinoxis.net
```

`http://localhost:8081` is also present in the first three lists for local
development. No wildcard production origin is allowed. `Allowed Origins (CORS)` is
currently empty; add the exact production origin only if a browser flow begins
calling an Auth0 endpoint that requires that CORS list.

### 4. Turn on judge-visible features

Each item must be enabled and tested before it is claimed in a demo:

- **Social login:** enable a Google connection for both Tomo Yard applications.
  If the tenant shows **Auth0 development keys**, treat Google as a development
  smoke test only: callbacks, consent branding, token quotas, SSO behavior, and
  logout are not a production configuration. Use project-owned Google OAuth
  credentials before making a production claim. See Auth0's
  [social connection guide](https://auth0.com/docs/authenticate/identity-providers/social-identity-providers)
  and [development-key limitations](https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/devkeys).
- **MFA:** enable OTP and recovery codes. Policy **Always** gives the most
  deterministic judge demo. Email alone is not an independent MFA factor. See
  [Enable MFA](https://auth0.com/docs/secure/multi-factor-authentication/enable-mfa).
- **Passwordless:** enable Email OTP and attach it to the applications. Prefer OTP;
  magic links require Classic Login. Auth0's built-in mail service is testing-only,
  so configure a real email provider for production. See
  [email OTP](https://auth0.com/docs/authenticate/passwordless/authentication-methods/email-otp)
  and [email providers](https://auth0.com/docs/customize/email).

### 5. Put the values in the correct runtimes

Set the four public client variables at build time, then build a new APK/web bundle.
Set `AUTH0_ISSUER_BASE_URL`, `AUTH0_AUDIENCE`, and the migration flag on the main
API. A server restart is not enough to change `EXPO_PUBLIC_*`: Expo replaces these
values in the JavaScript bundle at build/export time.

Auth0's native module and the `tomoyard` scheme require a development or standalone
build. OAuth callbacks cannot be tested reliably in Expo Go because Expo Go cannot
take the app's custom scheme. Scheme or native-plugin changes require rebuilding the
native client. This follows the exact Expo SDK 57
[AuthSession documentation](https://docs.expo.dev/versions/v57.0.0/sdk/auth-session/),
[Linking documentation](https://docs.expo.dev/versions/v57.0.0/sdk/linking/), and
[app config reference](https://docs.expo.dev/versions/v57.0.0/config/app/).

During the first native upgrade, a valid existing `ty:session:v1` credential is
moved once from AsyncStorage into Expo SecureStore and checked against `/me`. This
preserves an already signed-in legacy session while `ALLOW_LEGACY_AUTH=true`; it
does not convert or link that account to an Auth0 subject. Logout deletes the legacy
credential, after which Auth0 is required. SecureStore is native functionality, so
this migration must be tested in the rebuilt APK rather than Expo Go. See the exact
Expo SDK 57 [SecureStore documentation](https://docs.expo.dev/versions/v57.0.0/sdk/securestore/).

### 6. Migrate the five legacy users deliberately

Production currently has five legacy SQLite users. `ALLOW_LEGACY_AUTH=true` keeps
their existing 48-hex-character bearer sessions and password login working during
the transition, but it does not link them to Auth0. Use this small, auditable bulk
import/backfill plan instead of matching identities by mutable email or display
name:

1. Back up `/home/data/tomoyard.sqlite`, stop account creation briefly, and export
   exactly the five rows needed for migration (`id`, `username`, legacy scrypt
   hash, and salt). Never put that export in this repository or logs.
2. Enable username identifiers on the Auth0 database connection; the five rows do
   not have email addresses, so do not fabricate them. Do not combine trickle
   migration with this bulk import.
3. Build an ephemeral Auth0 import file with deterministic `user_id` values of
   `tomoyard-<sqlite-id>`. The current server uses
   `crypto.scryptSync(password, textualSalt, 32)`, so each
   `custom_password_hash` must specify `algorithm: "scrypt"`, hex hash, UTF-8 salt
   and password encodings, `keylen: 32`, `cost: 16384`, `blockSize: 8`, and
   `parallelization: 1`. Submit once with `upsert=false`; require exactly five
   inserts and zero failures. If an exact import cannot be proven, use Auth0
   password-reset tickets instead of collecting plaintext passwords.
4. Auth0 prefixes imported database IDs with `auth0|`. In one `BEGIN IMMEDIATE`
   SQLite transaction, add the nullable `auth0_sub` column if needed, create its
   unique partial index, and backfill row `<id>` with
   `auth0|tomoyard-<id>`. Abort on any count other than five, duplicate subject,
   duplicate username, missing row, or non-null pre-existing subject. Do not use
   an email or username-only runtime auto-link.
5. Verify all five users can sign in through Universal Login and retain their
   existing friends, hangouts, wardrobe, and wallet mapping. Keep the backup and a
   reversible subject-to-row manifest outside the repo for the migration window.
6. Publish the Auth0 build, wait through the announced transition window, confirm
   no required legacy sessions remain, then set `allow_legacy_auth = false` and
   apply. The old register/login endpoints and old opaque tokens then fail closed.

Auth0 documents [bulk user imports](https://auth0.com/docs/manage-users/user-migration/bulk-user-imports)
and the [user import schema](https://auth0.com/docs/manage-users/user-migration/bulk-user-import-schema).

## Configure MongoDB Atlas

Atlas is the durable store for the crypto ledger and event/idempotency data. The
main Tomo Yard social data still uses SQLite; do not claim that the entire app was
migrated to Atlas.

### 1. Verify the cluster

The `Tomo Yard Hackathon` project (`6a5c8b960ecad0390bf7a9a7`) contains the M0
cluster `tomo-yard`. It is the lowest-hassle hackathon tier. Verify that its Azure
region is acceptable for the crypto App Service in West Europe. Follow Atlas's
[free cluster guide](https://www.mongodb.com/docs/atlas/tutorial/deploy-free-tier-cluster/).

M0 has no managed backups or private endpoints. Use Flex if automatic daily
snapshots are worth the added cost. Atlas documents the
[free-tier limitations](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/)
and [Flex backup behavior](https://www.mongodb.com/docs/atlas/backup/cloud-backup/flex-cluster-backup/).

### 2. Verify the application database user

The dedicated database user is `tomo-yard-crypto`, not an Atlas dashboard user. It
has only `readWrite` on `ht6_crypto`. Its password exists only inside the Key Vault
`mongodb-uri` connection string. Atlas documents the distinction and roles in
[Configure Database Users](https://www.mongodb.com/docs/atlas/security-add-mongodb-users/).

Copy the Node.js `mongodb+srv://` driver URI. Add the database name or keep it in
`MONGODB_DB_NAME`. Percent-encode reserved characters in the username/password.
Never log the URI.

### 3. Allow only the crypto service's outbound addresses

After Azure has provisioned `ht6-tomoyard-crypto`, collect every possible outbound
address from the Terraform output:

```powershell
terraform -chdir=infra output -json crypto_possible_outbound_ip_addresses
```

The direct Azure query is a useful cross-check; use the **possible** list, not only
the addresses observed on the current worker:

```powershell
az webapp show `
  --resource-group 'ht6-tomoyard-rg' `
  --name 'ht6-tomoyard-crypto' `
  --query possibleOutboundIpAddresses -o tsv
```

Add each address to the Atlas project IP access list as an exact `/32`. Azure may
choose any listed address, so adding only the currently observed one is not enough.
Re-check after changing the App Service plan or tier. Do not leave `0.0.0.0/0`; a
temporary local developer address can have a short expiry. See
[Atlas IP access lists](https://www.mongodb.com/docs/atlas/security/ip-access-list/)
and [Azure App Service outbound IP behavior](https://learn.microsoft.com/en-us/azure/app-service/overview-inbound-outbound-ips).

The current allowlist has all 25 App Service `/32` entries plus one temporary
workstation `/32`. Remove the workstation entry after bootstrap. Do not remove any
possible-outbound address while the App Service can still select it.

### 4. Verify persistence without moving money

Start the crypto service and confirm that Atlas contains these collections:

```text
crypto_users
crypto_idempotency
crypto_withdrawals
crypto_events
```

The startup path creates unique indexes for external user IDs, idempotency
references, Unifold transfer IDs, and event IDs, plus query indexes. Check the
indexes in Atlas Data Explorer. Restart the crypto App Service and confirm the same
non-monetary test record is still present. Do not use a deposit, withdrawal, or
webhook-registration command as a connectivity test.

The service must fail closed if `CRYPTO_STORE_BACKEND=mongodb`, `MONGODB_URI`, or
`MONGODB_DB_NAME` is missing. `/health` proves process liveness; `/ready` (and its
alias `/readyz`) returns `200` only after Atlas connects and the indexes exist. Use
readiness plus a persistence read after restart as the acceptance check.

## Deploy and enable crypto on Azure

Production uses a separate `ht6-tomoyard-crypto` service. Unifold and Atlas secrets
belong there, not on the main `ht6-tomoyard` service.

### 1. Provision without enabling the public feature

Keep `CRYPTO_API_URL` absent from the main API before provisioning. From `infra/`,
copy `terraform.tfvars.example` to the ignored `terraform.tfvars`, fill it locally,
then initialize and review the Terraform plan before applying it:

The existing published APK uses legacy opaque tokens. For the in-place production
rollout, set `allow_legacy_auth = true` before deploying the Auth0-aware server,
publish the new Auth0 APK, and keep legacy access only for the agreed migration
window. Follow the five-user import/backfill plan above before switching the flag to
`false`.

For phase one, explicitly put these public/non-secret values in the ignored file:

```hcl
crypto_key_vault_name = "ht6tomoyardkv4831"
mongodb_db_name       = "ht6_crypto"
auth0_issuer_base_url = "https://dev-pl0mpi58gl7p2wxu.us.auth0.com/"
auth0_audience        = "https://ht6.icinoxis.net/api"
allow_legacy_auth     = true
crypto_enabled        = false
```

```powershell
$env:ARM_SUBSCRIPTION_ID = '<AZURE_SUBSCRIPTION_ID>'
$cloudflareToken = Read-Host 'Cloudflare API token' -AsSecureString
$env:CLOUDFLARE_API_TOKEN = [System.Net.NetworkCredential]::new('', $cloudflareToken).Password
Remove-Variable cloudflareToken

terraform init
terraform fmt -check
terraform validate
terraform plan
terraform apply
```

This first apply provisions the crypto App Service and generates the shared service
token, but deliberately leaves `CRYPTO_API_URL` absent from the main API. The four
external credentials are resolved at runtime from these exact Key Vault references:

| App setting | Key Vault `ht6tomoyardkv4831` secret |
| --- | --- |
| `MONGODB_URI` | `mongodb-uri` |
| `UNIFOLD_SECRET_KEY` | `unifold-secret-key` |
| `TREASURY_ACCOUNT_ID` | `treasury-account-id` |
| `UNIFOLD_PUBLISHABLE_KEY` | `unifold-publishable-key` |

The crypto App Service's system-assigned managed identity must have only **Key Vault
Secrets User** on that vault. Terraform creates this role assignment; no role is
granted to the main API. RBAC and App Service Key Vault reference resolution can
take a few minutes to converge. Inspect reference status, but never print resolved
values.

The Cloudflare token is required because the existing Terraform configuration also
manages the two production DNS names. Use a narrowly scoped zone token. Clear
`CLOUDFLARE_API_TOKEN` from the session after the apply. The current state backend is
local and contains the generated `CRYPTO_SERVICE_TOKEN`; keep it only on the trusted
workstation with restrictive file permissions. The MongoDB and Unifold values stay
in Key Vault and are not Terraform inputs. Move state to an access-controlled,
encrypted remote backend after the hackathon.

### 2. Configure the two service boundaries

Terraform sets the Auth0, datastore, Key Vault reference, and server-to-server
settings. In phase one, the main service has only:

```text
CRYPTO_SERVICE_TOKEN=<Terraform-generated server-to-server value>
```

After the first apply:

1. Add **every** `crypto_possible_outbound_ip_addresses` value to the Atlas project
   as an exact `/32` and wait until each entry is active.
2. Download the new crypto App Service publish profile locally and set it through
   the hidden `gh secret set AZURE_CRYPTO_WEBAPP_PUBLISH_PROFILE --repo 'a4ye/ht6-app'`
   prompt. The XML is a credential: never save it in the repo or print it.
3. Trigger the `Deploy crypto service` workflow. It installs, tests, type-checks,
   builds, deploys, then requires `GET /ready` to succeed.
4. Run the non-monetary phase-one acceptance checks below. Do not perform a real
   deposit, grant, stake, withdrawal, or webhook-registration smoke test by default.
5. Change only `crypto_enabled = true`, review the second Terraform plan, and
   apply. Terraform then adds
   `CRYPTO_API_URL=https://ht6-tomoyard-crypto.azurewebsites.net` to the main API.

Azure App Service setting changes restart the app automatically; an explicit
restart is harmless:

```powershell
az webapp restart -g 'ht6-tomoyard-rg' -n 'ht6-tomoyard-crypto'
az webapp restart -g 'ht6-tomoyard-rg' -n 'ht6-tomoyard'
```

List setting **names**, never values, during review:

```powershell
az webapp config appsettings list `
  -g 'ht6-tomoyard-rg' -n 'ht6-tomoyard-crypto' `
  --query '[].name' -o tsv
```

Microsoft documents App Service
[application settings](https://learn.microsoft.com/en-us/azure/app-service/configure-common)
and [log streaming](https://learn.microsoft.com/en-us/azure/app-service/troubleshoot-diagnostic-logs).

The publish-profile secret is required only by the crypto deployment workflow.
Changes under `crypto/unifold-demo/server/**` also trigger it. Repository variables
are not a safe substitute for this credential.

### 3. Acceptance checks

Run these in order:

1. `GET https://ht6-tomoyard-crypto.azurewebsites.net/health` returns 2xx and no
   configuration or secret material.
2. `GET https://ht6-tomoyard-crypto.azurewebsites.net/ready` returns 2xx with the
   MongoDB backend ready; a missing/unreachable Atlas configuration returns 503 or
   prevents the service from binding.
3. A protected crypto route called directly without the service token returns
   `401` or `403`.
4. Crypto service startup logs show successful Atlas initialization and never print
   the MongoDB URI, bearer token, or Unifold secret.
5. Restart the crypto service and confirm Atlas-backed state survives.
6. Main API `/health` returns 2xx.
7. An unauthenticated protected main-API route returns `401`; a token with the wrong
   issuer or audience also returns `401`; a valid Auth0 access token succeeds.
8. In a newly built APK, signup/login, process restart, token refresh, and logout all
   work. Upgrade one controlled legacy session: it remains signed in after the
   one-time SecureStore migration, `/me` validates it, and logout removes it. Test
   database login plus only the social/MFA/passwordless methods actually enabled in
   the tenant.
9. With `CRYPTO_API_URL` finally set, an authenticated `/wallet` response reports
   `enabled: true`; the wallet card and stake selector appear in the deployed APK.
10. Stop here for the default production smoke. A real-money deposit, grant, stake,
    cash-out, or webhook registration is **not** a routine health check. If the team
    explicitly approves a capped demo transfer, verify the Atlas record and Unifold
    result before any retry.

Cash-out has one product minimum: `CASHOUT_THRESHOLD_UNITS=20000000`, or 20 USDC at
six decimals. The client creates an 8-128-character `Idempotency-Key`, persists the
entire withdrawal intent locally before sending, and reuses the exact same key and
payload while reconciling an uncertain response. The main API forwards that header;
the crypto service durably reserves/debits once in Atlas and passes the same key to
Unifold. Reusing a key with different user, amount, or destination returns a
conflict. Never "fix" a timeout by generating a new key: retry the original intent
until its terminal state is known.

Leave all three dangerous opt-ins unset. If recurring real-USDC grants are deliberately
enabled for a controlled demo, do not create throwaway production accounts: each
eligible account can consume treasury funds. Reuse one controlled demo account and
keep the treasury balance capped. The same opt-in rule applies to raw balance
adjustments and treasury-funded event bonuses.

## Background music behavior

`Tomo Yard.mp3` is bundled into native and web builds through `expo-audio` at low
volume and loops while the app is active. The visible **Music on/off** switch is
available throughout the app and its preference is persisted in AsyncStorage.

On Android/iOS, music is foreground-only: it pauses when the app becomes inactive,
does not opt into lock-screen/background playback, respects silent mode, and mixes
with other audio. On `https://ht6-app.icinoxis.net`, browser autoplay policy means
the default unmuted preference cannot begin playback until the first pointer, touch,
or keyboard gesture. The toggle itself also unlocks playback. This is expected
browser behavior, not a deployment failure. Test initial gesture unlock, mute
persistence after reload, loop playback, and pause/resume across app lifecycle. See
the exact Expo SDK 57 [`expo-audio` documentation](https://docs.expo.dev/versions/v57.0.0/sdk/audio/).

## Rollback and rotation

### Immediate crypto rollback

Delete the main API's URL setting. This disables the wallet/staking UI without
changing the APK:

```powershell
az webapp config appsettings delete `
  -g 'ht6-tomoyard-rg' -n 'ht6-tomoyard' `
  --setting-names CRYPTO_API_URL
```

Then investigate the crypto service while the main application remains available.
Also set `crypto_enabled = false` in `infra/terraform.tfvars`, review, and apply so
Terraform does not restore the URL on its next run. Do not delete Atlas data or
rotate credentials as the first response.

### Auth rollback

Keep `ALLOW_LEGACY_AUTH=true` only during a controlled migration so valid
pre-upgrade credentials in SecureStore can still authenticate. This fallback accepts
only the old token shape and never turns a failed JWT into a legacy lookup. If the
new Auth0 path fails, roll back the server and APK artifacts together; do not weaken
issuer/audience verification. Set the flag to `false` once legacy accounts have a
deliberate disposition and the rollback window closes.

### Atlas backup and rollback

M0 has no managed backup. Before schema/data changes, use `mongodump` and store the
encrypted archive outside the repository, then test `mongorestore` into a scratch
database. MongoDB warns that passwords in command arguments may be visible to other
processes; prefer an interactive prompt or protected config. See
[mongodump](https://www.mongodb.com/docs/database-tools/mongodump/) and
[mongorestore](https://www.mongodb.com/docs/database-tools/mongorestore/).

Use additive migrations. Roll back the application first; restore data only when a
change is incompatible and the restore has been rehearsed.

### Rotate credentials

- **MongoDB:** create a second least-privilege database user, update the Key Vault
  secret `mongodb-uri`, force a Key Vault reference refresh or restart, verify
  `/ready`, then delete the old user.
- **Crypto service token:** there is no dual-token overlap today. Remove
  `CRYPTO_API_URL`, replace the Terraform-managed `random_password` value so both
  services update together, verify internally, then restore the URL through
  `crypto_enabled = true`.
- **Unifold secret:** create/rotate it in Unifold, update only Key Vault
  `unifold-secret-key`, refresh/restart and run a read-only preflight, then revoke
  the old key. `treasury-account-id` is an identifier, but changes still require
  careful reconciliation. Keep `unifold-publishable-key` aligned with the same
  Unifold environment.
- **Auth0:** the Native/SPA apps need no client secret. Revoke temporary Management
  API access and rotate any Google, email-provider, or Action secrets separately.

## Honest hackathon demo narrative

Use claims that match what judges can see and what the deployed system actually
does:

- **Auth0:** "Tomo Yard uses Auth0 Universal Login. The native app uses Authorization
  Code with PKCE, the API verifies RS256 access tokens with exact issuer and
  audience, and users are keyed by Auth0 `sub`, not by a mutable email address."
- Add "Google login", "email OTP", or "MFA" only after that exact flow has passed on
  the demo build and tenant.
- **MongoDB Atlas:** "Atlas is the durable store for the real-USDC ledger, withdrawal
  state, hangout staking events, and idempotency records. Unique indexes prevent
  duplicate grants, transfers, and event processing, and the state survives an app
  restart."
- Be explicit that the main profiles/friends database remains SQLite and that the
  hackathon cluster is M0 without managed backups.
- **Crypto safety:** "The money service is separately deployed, authenticated
  server-to-server, and gated by `CRYPTO_API_URL`. We can disable the entire money
  surface immediately without shipping a new APK. Automatic real-USDC grants and
  the raw balance-adjustment endpoint are disabled by default in production."
- Never claim that the unused publishable key is a shipped client integration, that
  every route was migrated to Atlas, or that a feature is production-grade merely
  because its dashboard switch is on.

## Remove temporary access

After deployment and verification:

```powershell
auth0 logout 'dev-pl0mpi58gl7p2wxu.us.auth0.com'
atlas auth logout --force
gh auth logout --hostname github.com
az logout
az account clear
Remove-Item Env:\CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:\ARM_SUBSCRIPTION_ID -ErrorAction SilentlyContinue
```

Delete the temporary Atlas Service Account or Auth0 member/M2M client, remove any
temporary Azure role assignment, and revoke the corresponding device/OAuth grants
where appropriate. Securely remove the isolated `AZURE_CONFIG_DIR` after confirming
it points to the intended temporary directory.
