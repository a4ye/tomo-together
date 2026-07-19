// Live token/chain catalog from Unifold — so the app's cash-out options reflect
// what Unifold ACTUALLY supports instead of a hardcoded list. Flattens the
// supported-deposit-tokens response (token × chain) into destination rows.
import { UNIFOLD_SECRET_KEY } from './config.js';

export interface CatalogDestination {
  symbol: string;
  name: string;
  chain_type: string;
  chain_id: string;
  chain_name: string;
  token_address: string;
  is_stablecoin: boolean;
  icon_url?: string;
}

export async function getSupportedDestinations(): Promise<CatalogDestination[]> {
  const res = await fetch('https://api.unifold.io/v1/tokens/supported_deposit_tokens', {
    headers: { Authorization: `Bearer ${UNIFOLD_SECRET_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`supported_deposit_tokens ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const body = (await res.json()) as { data?: Array<Record<string, any>> };

  const out: CatalogDestination[] = [];
  for (const tok of body.data ?? []) {
    for (const ch of tok.chains ?? []) {
      out.push({
        symbol: String(tok.symbol),
        name: String(tok.name ?? tok.symbol),
        is_stablecoin: !!tok.is_stablecoin,
        chain_type: String(ch.chain_type),
        chain_id: String(ch.chain_id),
        chain_name: String(ch.chain_name ?? ch.chain_id),
        token_address: String(ch.token_address),
        icon_url: ch.icon_url ? String(ch.icon_url) : undefined,
      });
    }
  }
  return out;
}
