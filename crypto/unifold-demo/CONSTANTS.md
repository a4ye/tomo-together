# Constants — shared spec

The single source of truth for the treasury-custody model. These values must be **identical across `app/` and `server/`**. All amounts are USDC **base-unit strings** (USDC has **6 decimals**).

## Money

| Constant | Value | Base units | Notes |
| --- | --- | --- | --- |
| Chain | **Base** | — | chain_id `8453` |
| USDC decimals | 6 | — | 1 USDC = 1000000 units |
| Monthly grant | 4 USDC | `4000000` | credited once per calendar month |
| Minimum withdraw | 3 USDC | `3000000` | Unifold L2/Base minimum |
| Treasury source | Base | — | chain_id `"8453"`, currency `"usdc"` |
| API base URL | `http://localhost:8787` | — | default |

## Destination presets (cross-chain routing demo)

| Label | chain_type | chain_id | token_address |
| --- | --- | --- | --- |
| **USDC on Base** (default) | ethereum | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| USDC on Polygon | ethereum | 137 | `0x3c499c542cEF5E3811e1192cE70d8cC03d5c3359` |
| USDC on Arbitrum | ethereum | 42161 | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |

## HTTP API contract

Server implements, app consumes. Amounts are USDC base-unit strings.

| Method | Path | Request body | Response |
| --- | --- | --- | --- |
| GET | `/health` | — | `{ ok: true }` |
| POST | `/users/register` | `{ externalUserId }` | `{ ok:true, externalUserId, balanceUnits:"0" }` |
| GET | `/users/:externalUserId` | — | `{ externalUserId, balanceUnits, lastGrantPeriod: string\|null, withdrawals: Withdrawal[] }` |
| POST | `/grant` | `{ externalUserId }` | `{ ok:true, alreadyGranted:boolean, period:"YYYY-MM", balanceUnits }` — idempotent per (user, current `YYYY-MM`); credits `4000000` once/month |
| POST | `/adjust` | `{ externalUserId, deltaUnits:string(signed int), reference?:string }` | `{ ok:true, alreadyApplied, balanceUnits, appliedUnits, requestedDeltaUnits, clamped }` — external-input credit/debit; balance floors at 0; optional `reference` makes it idempotent |
| POST | `/add-funds` | `{ externalUserId }` | `{ ok:true, treasuryAddress, depositAddresses }` — returns a Unifold deposit address to send USDC to |
| POST | `/deposits/refresh` | `{ externalUserId }` | `{ ok:true, creditedUnits, newDeposits[], balanceUnits }` — polls Unifold `directExecutions` and credits arrived deposits (idempotent) |
| POST | `/webhooks/unifold` | raw body + `unifold-*` headers | `{ received:true, type, handled }` or `400` — HMAC-verified real-time events: `deposit.direct_execution.completed` credits (same `deposit:<execId>` ref as the poll → mutually idempotent); `treasury.outbound_transfer.completed`/`.failed` updates/refunds. Set `UNIFOLD_WEBHOOK_SECRET`. |
| POST | `/withdraw` | `{ externalUserId, amountUnits:string, destination:{ chain_type, chain_id, token_address, recipient_address } }` | `{ ok:true, withdrawalId, transferId, status, balanceUnits }` |
| GET | `/withdrawals/:withdrawalId` | — | `{ withdrawalId, transferId, status, amountUnits, destination, balanceUnits }` |
| GET | `/treasury` | — | `{ treasuryAccountId, address, chainType }` (best-effort via `treasury.accounts.retrieve`) |
| GET | `/catalog` | — | `{ ok:true, destinations[] }` — **live** supported tokens/chains from Unifold (`GET /v1/tokens/supported_deposit_tokens`), flattened; drives the cash-out picker. Empty list on error → app falls back to presets. |
| POST | `/events` | `{ host, title, stakeUnits, multiplierBps? }` | `{ ok:true, event }` — create a flake-tax hangout (`multiplierBps` 10000=1×, 15000=1.5× holiday) |
| POST | `/events/:id/rsvp` | `{ userId }` | `{ ok:true, event }` — stake to RSVP (debits balance; rejects if insufficient) |
| POST | `/events/:id/checkin` | `{ userId }` | `{ ok:true, event }` — the attendance oracle marks a user `attended` |
| POST | `/events/:id/settle` | — | `{ ok:true, eventId, forfeitPoolUnits, results[] }` — flakers' stakes split among attendees (+ holiday bonus); no-show-only refunds all |
| GET | `/events/:id` | — | `{ ok:true, event }` |
| GET | `/users/:externalUserId/events` | — | `{ ok:true, events[] }` |

### `/withdraw` validation

Validate, in order: user exists; `amountUnits` is a **positive integer string**; `amountUnits >= 3000000`; `amountUnits <= balance`; `recipient_address` non-empty.

- **Success:** create the Unifold outbound transfer, deduct balance, record the withdrawal.
- **Validation failure:** `400 { ok:false, error }`.
- **Unifold error:** `500 { ok:false, error }` and **do NOT deduct** the balance.

### `/withdrawals/:withdrawalId` status

`status` is one of `'pending' | 'processing' | 'completed' | 'failed'`. Calls `unifold.treasury.outboundTransfers.retrieve(transferId)`, updates stored status. If `'failed'` and **not already refunded**, re-credit the balance **once** (set a `refunded` flag).

### Withdrawal object

```ts
{ id, transferId, amountUnits, destination, status, refunded: boolean, createdAt }
```

## Server environment

| Variable | Example | Purpose |
| --- | --- | --- |
| `UNIFOLD_SECRET_KEY` | `sk_live_…` | Unifold Node SDK secret key (server-only) |
| `TREASURY_ACCOUNT_ID` | `ta_…` | Treasury account holding USDC on Base |
| `TREASURY_SOURCE_CHAIN_ID` | `8453` | Treasury source chain (Base) |
