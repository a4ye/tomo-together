// Read-only preflight. Moves NO money, costs nothing.
// Verifies: (1) Unifold accepts your sk_live, (2) the treasury account exists and
// is on Base, (3) it actually holds enough USDC on-chain, (4) the withdraw resource
// is reachable. If everything is ✅, the live demo path is one real transfer from proven.
//
// Run:  UNIFOLD_SECRET_KEY=sk_live_… TREASURY_ACCOUNT_ID=ta_… npm run check
//   or: put them in server/.env and just `npm run check`
import Unifold from '@unifold/node';
import {
  createPublicClient,
  http,
  erc20Abi,
  formatUnits,
  isAddress,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';

const SECRET = process.env.UNIFOLD_SECRET_KEY;
const TREASURY = process.env.TREASURY_ACCOUNT_ID;
const RPC = process.env.RPC_URL ?? 'https://mainnet.base.org';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Hex;
const MIN_USDC = 3;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
function fail(m: string): never {
  console.error('❌ ' + m);
  process.exit(1);
}

if (!SECRET) fail('Set UNIFOLD_SECRET_KEY (sk_live_…) — inline or in server/.env');
if (!TREASURY) fail('Set TREASURY_ACCOUNT_ID (ta_…) — inline or in server/.env');

const unifold = new Unifold(SECRET);
const pub = createPublicClient({ chain: base, transport: http(RPC) });

async function main(): Promise<void> {
  console.log('Unifold read-only preflight — no funds move.\n');

  // 1) Auth + treasury account (this call is what fails first if the key is wrong)
  let acct: { id?: string; address?: string; chain_type?: string };
  try {
    acct = await unifold.treasury.accounts.retrieve(TREASURY!);
  } catch (e) {
    fail(`treasury.accounts.retrieve failed — bad key or wrong treasury id?\n   ${msg(e)}`);
  }
  console.log('✅ Auth OK — Unifold accepted the secret key.');
  console.log(`✅ Treasury ${acct.id ?? TREASURY}`);
  console.log(`   address:   ${acct.address}`);
  console.log(`   chainType: ${acct.chain_type}`);
  if (acct.chain_type && acct.chain_type !== 'ethereum') {
    console.warn(
      `⚠️  chain_type is "${acct.chain_type}", not "ethereum" — the demo sources USDC from Base (ethereum-type).`,
    );
  }

  // 2) On-chain USDC + ETH balance on Base (read-only, free)
  if (acct.address && isAddress(acct.address)) {
    try {
      const addr = acct.address as Hex;
      const [usdcBal, ethBal] = await Promise.all([
        pub.readContract({
          address: USDC_BASE,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [addr],
        }),
        pub.getBalance({ address: addr }),
      ]);
      const usdc = Number(formatUnits(usdcBal, 6));
      console.log('\n✅ On-chain (Base mainnet):');
      console.log(`   USDC: ${usdc.toFixed(2)}  (${usdcBal.toString()} base units)`);
      console.log(`   ETH:  ${formatUnits(ethBal, 18)}`);
      if (usdc < MIN_USDC) {
        console.warn(
          `⚠️  USDC ${usdc.toFixed(2)} is below the ~${MIN_USDC} USDC minimum — a cash-out would be rejected. Top up on Base.`,
        );
      } else {
        console.log(`   → enough for a cash-out (>= ${MIN_USDC} USDC minimum). 👍`);
      }
    } catch (e) {
      console.warn(`⚠️  could not read on-chain balance via ${RPC}: ${msg(e)}`);
    }
  } else {
    console.warn('⚠️  treasury address missing/not an EVM address — skipped on-chain balance check.');
  }

  // 3) Withdraw resource reachable (read-only list)
  try {
    await unifold.treasury.outboundTransfers.list();
    console.log('\n✅ outboundTransfers.list OK — the withdraw resource is reachable.');
  } catch (e) {
    console.warn(`\n⚠️  outboundTransfers.list failed (non-fatal): ${msg(e)}`);
  }

  console.log('\nDone. No funds moved.');
  console.log('If everything above is ✅, the live path is one real transfer from proven.');
}

main().catch((e) => fail(msg(e)));
