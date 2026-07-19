// Programmatically register the Unifold webhook endpoint (instead of the dashboard).
// Prints the signing secret — copy it into custody/.env as UNIFOLD_WEBHOOK_SECRET.
//
// Run:  UNIFOLD_SECRET_KEY=sk_live_… WEBHOOK_URL=https://<tunnel>/webhooks/unifold npm run setup:webhook
import Unifold from '@unifold/node';

const SECRET = process.env.UNIFOLD_SECRET_KEY;
const URL = process.env.WEBHOOK_URL;

function fail(m: string): never {
  console.error('❌ ' + m);
  process.exit(1);
}

if (!SECRET) fail('Set UNIFOLD_SECRET_KEY (sk_live_…)');
if (!URL) fail('Set WEBHOOK_URL to your public endpoint, e.g. https://xxx.trycloudflare.com/webhooks/unifold');

const unifold = new Unifold(SECRET);

async function main(): Promise<void> {
  const endpoint = await unifold.webhookEndpoints.create({
    name: 'unifold-bank-demo',
    url: URL!,
    enabled_events: [
      'deposit.direct_execution.completed',
      'treasury.outbound_transfer.completed',
      'treasury.outbound_transfer.failed',
    ],
  });

  console.log('✅ Webhook endpoint created.');
  console.log(`   id:  ${endpoint.id}`);
  console.log(`   url: ${URL}`);
  console.log('\nSigning secret — put this in custody/.env as UNIFOLD_WEBHOOK_SECRET (shown once):');
  console.log(`\n   ${endpoint.secret}\n`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
