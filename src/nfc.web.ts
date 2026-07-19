// Web build of src/nfc.ts (Metro picks .web.ts on web exports automatically).
// Browsers have no HCE/IsoDep access, so everything reports unavailable and the
// app falls back to QR codes. Keep the API surface identical to nfc.ts.

export type HceDiagnostics = {
  payloadSet: boolean;
  tappedAt: number;
  servedAt: number;
  apduCount: number;
  lastApduHex: string;
  lastRespHex: string;
  deactivatedAt: number;
  deactivatedReason: number;
};

export type DiagEntry = { ts: number; msg: string; src: 'js' | 'native' | 'hce' };

const jsDiag: DiagEntry[] = [];
const diagListeners = new Set<() => void>();

export function diagLog(msg: string): void {
  jsDiag.push({ ts: Date.now(), msg, src: 'js' });
  if (jsDiag.length > 300) jsDiag.splice(0, jsDiag.length - 300);
  for (const l of diagListeners) {
    try {
      l();
    } catch {
      // listeners must never break the feature
    }
  }
}

export function subscribeDiag(cb: () => void): () => void {
  diagListeners.add(cb);
  return () => {
    diagListeners.delete(cb);
  };
}

export function moduleInfo(): { tomoHce: boolean; tomoReader: boolean; nfcManagerNative: boolean } {
  return { tomoHce: false, tomoReader: false, nfcManagerNative: false };
}

export async function hceDiagnostics(): Promise<HceDiagnostics | null> {
  return null;
}

export async function getDiagSnapshot(): Promise<DiagEntry[]> {
  return [...jsDiag].slice(-140);
}

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
