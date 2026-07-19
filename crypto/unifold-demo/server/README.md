# Crypto money service

This private Express service owns the Unifold treasury-backed USDC ledger. MongoDB Atlas is the durable production store; the JSON store exists only for explicit local and test use.

## Storage safety contract

- `CRYPTO_STORE_BACKEND=mongodb` selects MongoDB Atlas.
- `CRYPTO_STORE_BACKEND=json` is an explicit local/test fallback. Production rejects it.
- There is no implicit fallback from MongoDB to JSON. With `NODE_ENV=production`, a missing backend selection, missing MongoDB configuration, unreachable cluster, or failed index initialization stops the process before it listens.
- `/health` is an unauthenticated liveness probe. It returns `200 {"ok":true}` while the HTTP process is alive.
- `/ready` (also `/readyz`) is an unauthenticated datastore readiness probe. It actively pings MongoDB with a bounded timeout. A healthy initialized store returns `200` with `{"ok":true,"state":"ready","backend":"mongodb"}` (or backend `"json"` locally); startup or runtime datastore failure returns `503` with the current state and backend.
- `SIGTERM` and `SIGINT` stop the HTTP listener and close the datastore connection. Containers should use the image's normal stop signal instead of killing the process.

The JSON store writes ledger files under `DATA_DIR` (default `./data`). It is not suitable for production, multiple replicas, or ephemeral container storage.

## Main-API contract

The mobile app must not call this service directly. The main API calls every business endpoint with:

```http
Authorization: Bearer <CRYPTO_SERVICE_TOKEN>
```

The token must be the same secret (at least 32 characters) on both services. `/health`, `/ready`, `/readyz`, and the HMAC-authenticated `/webhooks/unifold` endpoint are the only routes that do not use that bearer token.

`POST /withdraw` additionally requires exactly one `Idempotency-Key` header. The key must be 8–128 characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, and `-`; the service persists it as the withdrawal ID and forwards the exact value to Unifold. A retry must reuse the same key and identical user, amount, and destination. Reusing a key with another payload returns `409`. An ambiguous provider response returns `202` and keeps the ledger debit reserved; retry the same request and key until it reconciles. Only an authoritative failed transfer is refunded.

All monetary values are canonical integer strings in 6-decimal USDC base units. The configured default cash-out minimum is `20000000` (20 USDC), and `CASHOUT_THRESHOLD_UNITS` changes both the wallet-ready threshold and the enforced withdrawal minimum.

## Real-money production opt-ins

Three high-impact money-creation paths stay off in production unless their setting is the exact lowercase string `true`:

- `ENABLE_RECURRING_REAL_USDC_GRANTS=true` enables the on-demand 4-USDC monthly grant endpoint. Each user can claim at most once per period, and each credit creates a real claim against the treasury reserve.
- `ENABLE_RAW_BALANCE_ADJUSTMENTS=true` enables the raw `/adjust` credit/debit route. It remains protected by the service bearer token, and callers cannot use the reserved `deposit:` or `settle:` reference namespaces.
- `ENABLE_TREASURY_FUNDED_EVENT_BONUSES=true` permits event multipliers above 1x. Without this explicit opt-in, production events can redistribute stakes but cannot mint bonus liabilities against the treasury.

Leave both settings omitted (the default) unless the production demo intentionally needs them and the treasury/operator controls are ready. Values such as `TRUE`, `1`, or `yes` do not enable either feature.

The raw adjustment route rejects the internal `deposit:` and `settle:` idempotency namespaces. Referenced adjustments bind the reference to the original delta and reject a later payload change.

## One-time MongoDB Atlas setup

1. Create an Atlas project and a [Free cluster](https://www.mongodb.com/docs/atlas/tutorial/deploy-free-tier-cluster/).
2. Under **Database Access**, create a dedicated application user with read/write access to the service database. Generate a unique password.
3. Under **Network Access**, add the crypto service's exact Azure outbound IP addresses to the project [IP access list](https://www.mongodb.com/docs/atlas/security/ip-access-list/). For local setup, add only your current public IPv4 address as a `/32` entry and remove it afterward. Do not use `0.0.0.0/0`.
4. In the cluster's **Connect > Drivers** screen, copy the [Node.js connection string](https://www.mongodb.com/docs/drivers/node/current/get-started/) and replace its username and password placeholders. URL-encode special characters in either value.
5. Set `MONGODB_DB_NAME=ht6_crypto`. Atlas creates the database and collections on first use; the service creates its required indexes during startup.

`MONGODB_URI` contains credentials. Store it as a deployment secret/app setting, never in source control or a client-visible Expo variable.

## Local setup with Atlas

Requires Node.js 22.13 or later.

```sh
cp .env.example .env
npm ci
npm run typecheck
npm test
npm run build
npm start
```

Edit the ignored `.env` before starting:

```dotenv
CRYPTO_STORE_BACKEND=mongodb
MONGODB_URI=mongodb+srv://YOUR_USER:YOUR_URL_ENCODED_PASSWORD@YOUR_CLUSTER.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB_NAME=ht6_crypto
UNIFOLD_SECRET_KEY=YOUR_SERVER_KEY
TREASURY_ACCOUNT_ID=YOUR_TREASURY_ACCOUNT_ID
CRYPTO_SERVICE_TOKEN=AT_LEAST_32_RANDOM_CHARACTERS
```

Generate the service-to-service token with a password manager or `openssl rand -hex 32`. The same value must be configured only on this service and the main API; it must never be embedded in the mobile app.

To run the ledger-only JSON implementation locally, explicitly use:

```dotenv
NODE_ENV=development
CRYPTO_STORE_BACKEND=json
DATA_DIR=./data
```

Automated tests set the JSON backend explicitly and use `.data-test`; they do not require Atlas or real credentials.

## Container and production deployment

The image builds TypeScript once, installs production dependencies with `npm ci`, runs as the unprivileged `node` user, and probes `/ready`.

```sh
docker build -t ht6-crypto-service .
docker run --rm -p 8787:8787 --env-file .env \
  -e NODE_ENV=production \
  -e CRYPTO_STORE_BACKEND=mongodb \
  ht6-crypto-service
```

For a local production-shaped run, `docker compose up --build` applies those two production settings and reads the remaining values from the ignored `.env` file.

Configure these server-side settings on the production crypto service:

| Setting | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV=production` | yes | Enables production safety checks. |
| `CRYPTO_STORE_BACKEND=mongodb` | yes | Selects the only production-supported store. |
| `MONGODB_URI` | yes | Atlas driver URI, including the database user's secret. |
| `MONGODB_DB_NAME=ht6_crypto` | yes | Stable database name. |
| `UNIFOLD_SECRET_KEY` | yes | Server-only Unifold key. |
| `TREASURY_ACCOUNT_ID` | yes | Treasury used by the service. |
| `CRYPTO_SERVICE_TOKEN` | yes | Shared main-API-to-crypto-service token, at least 32 characters. |
| `PORT` | platform-specific | Defaults to `8787`; use the port injected by the host when required. |
| `UNIFOLD_WEBHOOK_SECRET` | recommended | Verifies Unifold webhook signatures. |
| `TREASURY_SOURCE_CHAIN_ID` | optional | Defaults to Base mainnet (`8453`). |
| `CREDIT_LIMIT_UNITS` | optional | Ledger floor in 6-decimal USDC units; defaults to `0` (no debt). |
| `CASHOUT_THRESHOLD_UNITS` | optional | Wallet-ready threshold and minimum withdrawal; defaults to `20000000` (20 USDC). |
| `ENABLE_RECURRING_REAL_USDC_GRANTS=true` | opt-in | Enables on-demand monthly real-USDC ledger grants; omitted/off by default. |
| `ENABLE_RAW_BALANCE_ADJUSTMENTS=true` | opt-in | Enables service-authenticated arbitrary ledger adjustments; omitted/off by default. |
| `ENABLE_TREASURY_FUNDED_EVENT_BONUSES=true` | opt-in | Enables event multipliers above 1x that create treasury-funded liabilities; omitted/off by default. |

After deploying, verify both probes from a network location that can reach the service:

```sh
curl -fsS https://YOUR_CRYPTO_HOST/health
curl -fsS https://YOUR_CRYPTO_HOST/ready
```

Only after `/ready` succeeds should the main API receive the crypto service URL and the matching `CRYPTO_SERVICE_TOKEN`. A failed readiness probe means traffic must not be sent to the instance; do not work around it by enabling JSON storage.

Webhook deposit credits are accepted only when the verified event mode matches the Unifold key and the event belongs to the configured treasury, Base (`8453`), and native Base USDC token. Withdrawal terminal events are also checked against the durable user, amount, and recipient. Signature failures return `400`; transient processing/datastore failures return `500`/`503` so the provider can retry.
