# Unifold Bank — Pitch

> **A social bank where flaking on your friends literally pays them.**
> Stake to show up; no-shows' stakes go to the friends who did — and the money settles **instantly for everyone, no matter what bank, app, or country they're on.** Powered end-to-end by Unifold.

---

## The problem (two of them, actually)

**1. Showing up is hard.** Friend groups run on soft RSVPs and last-minute flakes. There's no cost to bailing, so people bail.

**2. Moving money between friends is a fragmented mess.** The classic scene: *"Venmo me." "I only have Cash App." "I'm visiting from London, I have neither."* Peer payment apps are **single-country and single-app** — Venmo/Zelle don't cross borders, everyone's on something different, and even domestic transfers can take days. The moment your group spans cities, countries, or a visiting friend, splitting money stops working.

Real friend groups today are **spread out** — study-abroad friends, people who moved cities, someone crashing on your couch for the week. The money should just work for all of them.

## The idea

Put a small amount of **real money** behind every hangout, and settle it on rails that work for *everyone*:

1. You get a **stablecoin balance** in the app.
2. To RSVP to a hangout (shared like a Luma link), you **stake** some of it.
3. Show up (verified in-app) → get your stake back.
4. **Flake → your stake is split among the friends who showed up.**

Your no-show doesn't just disappoint people — it **pays** them. And when the group cashes out, it doesn't matter who banks where.

## Why this needs Unifold (the honest answer)

A plain app could track points. What makes this actually *work* is the settlement layer, and that's Unifold:

- **No "which app do you use?"** — everyone receives on one rail, then cashes out however they want. No Venmo/Cash App/Zelle fragmentation.
- **Works across banks and borders** — a friend visiting from abroad, or your group scattered across countries, all get paid the same way. No local bank account needed.
- **Instant** — the pot settles the moment the hangout ends, not in 1–3 business days.
- **Easy to share** — the hangout link *is* the money. Sharing an event shares the stake pool; no account setup, no wallet, no seed phrase, no gas.

Take Unifold out and it's Monopoly money that only some of your friends could ever collect. That's why it's central, not decoration.

## How Unifold powers every step

| Step in the app | Unifold product |
|---|---|
| **Add funds** (any chain / card / Coinbase, gas-sponsored) | **Deposit SDK** — `beginDeposit()` |
| The shared pool everyone banks into | **Treasury** |
| Real-time crediting the instant a deposit lands | **Verified webhooks** + `directExecutions` |
| **Cash out** — instant, to whatever chain/token each friend prefers | **Payout** — `treasury.outboundTransfers` |
| Payout options that never drift from what Unifold supports | **Live token catalog** |
| One identity across the whole flow | **Unifold users** (`external_user_id`) |

Money **in via the Deposit SDK**, **out via Payout** — instant, cross-chain, gas-sponsored, and bank-/country-agnostic.

## The demo (the money shot)

1. **Add funds** → the Unifold deposit modal opens → deposit from **Coinbase** → balance credits in real time via webhook.
2. Create a **hangout**, share the link, everyone **stakes** to RSVP.
3. Check in whoever showed → **Settle** → the flaker's stake lands in the winners' balances instantly (`+$` / `−$`).
4. **Cash out** → the friend visiting from out of the country pulls their winnings to **their** preferred token/chain — Unifold routes it and pays the gas, no local bank required.

The narration: *"Everyone got paid the instant the hangout ended — different banks, different countries, one tap. Unifold handled custody, settlement, and gas; nobody touched a wallet."*

## Under the hood

Built to actually hold up, not just demo:

- **Treasury-custody + internal ledger.** All USDC lives in one Unifold treasury; per-user balances are DB claims. Stakes and settlement are ledger moves, so the chain is touched **only at deposit and cash-out** — a $1.50 flake share never hits (and *can't* hit) Unifold's ~$3 network minimum.
- **Deposit crediting is idempotent two ways.** A **verified webhook** and a **`directExecutions` poll** both credit using the *same* `deposit:<execId>` reference — whichever fires first wins, the other no-ops. Have a public URL? Real-time webhooks. Don't? The poll covers it. Never a double-credit.
- **Webhooks are genuinely verified.** HMAC-SHA256 over the raw body via `unifold.webhooks.constructEvent`; forged signatures are rejected — and it's tested with *real* signatures, not mocks.
- **Settlement can't leak money.** Flake-tax redistribution splits evenly with a deterministic remainder, and a runtime **conservation invariant** asserts `payouts == stakes` on every settle (throws otherwise). Double-RSVP / double-settle are guarded.
- **No cheatable debt.** Balances floor at **$0** — you can only stake what you have — so a throwaway account can't skip out on a negative balance. **Net settlement** batches cash-outs at $20 to cut transaction fees.
- **Multi-chain, live.** Cash-out destinations are pulled from Unifold's **supported-token catalog** at runtime (not hardcoded), and Payout routes cross-chain to each recipient's preferred token.
- **Tested + typed.** **40 tests** run fully offline (Unifold stubbed, webhooks signed for real), and everything compiles against the real `@unifold/node` types.

Idempotency is everywhere it matters: grants (per month), balance adjustments (per reference), withdrawals (per key), deposits (per execution id).

## Positioning

Unifold's **Fintech & Banking** solution, made consumer: a **borderless stablecoin neobank** where the hook is social accountability and the superpower is money that settles instantly for a friend group no matter where anyone banks. The full deposit → treasury → cross-chain payout lifecycle on one integration.

## What's real vs. roadmap (we don't oversell)

- **Real & tested:** the ledger, no-debt floor, flake-tax settlement math (with a conservation invariant), deposit crediting, and webhook verification — 40 passing tests against the real SDK types.
- **Live on demo day:** deposit via `beginDeposit`, credit via webhook, instant cross-chain cash-out via Payout.
- **Roadmap:** "pay your exact stake" via **Checkout / Payment Intents** (web-only today) through a web companion; a harder-to-game attendance oracle (host-attested / majority check-in) for money-moving fairness at scale.

---

### One line
**Unifold Bank turns showing up into a payout — and settles it instantly for your whole friend group, whatever bank or country they're in.**
