// USDC has 6 decimals; all amounts move as base-unit strings.
export const USDC = 1_000_000;

export function fmtUsd(units: string | number | undefined | null): string {
  if (units == null) return '$0';
  // Floor to cents so we never show more than the user actually has.
  const cents = Math.floor(Number(units) / (USDC / 100));
  const n = cents / 100;
  // whole dollars show as $2, cents show as $1.50
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

// Preset stake amounts, in base units.
export const STAKE_PRESETS = [
  { label: 'None', units: null },
  { label: '$0.50', units: String(USDC / 2) },
  { label: '$1', units: String(USDC) },
  { label: '$2', units: String(2 * USDC) },
] as const;
