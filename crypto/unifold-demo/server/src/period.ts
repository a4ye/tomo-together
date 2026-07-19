// Returns the current billing period as "YYYY-MM" in local time.
export function currentPeriod(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}
