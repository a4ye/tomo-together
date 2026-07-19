// Web build of src/nfc.ts (Metro picks .web.ts on web exports automatically).
// Browsers have no HCE/IsoDep access, so everything reports unavailable and the
// app falls back to QR codes. Keep the API surface identical to nfc.ts.

export function hceAvailable(): boolean {
  return false;
}

export async function nfcState(): Promise<{ supported: boolean; enabled: boolean }> {
  return { supported: false, enabled: false };
}

export async function nfcAvailable(): Promise<boolean> {
  return false;
}

export async function lastTapAt(): Promise<number> {
  return 0;
}

export async function lastServedAt(): Promise<number> {
  return 0;
}

export async function startShowing(_payload: string): Promise<boolean> {
  return false;
}

export async function stopShowing(): Promise<void> {}

export async function cancelScan(): Promise<void> {}

export async function scanOnce(): Promise<string> {
  throw new Error('NFC is not available on web');
}
