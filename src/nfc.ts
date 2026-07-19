import { NativeModules, Platform } from 'react-native';
import NfcManager, { NfcAdapter, NfcTech } from 'react-native-nfc-manager';

// Custom AID registered in the HCE service (see plugins/withTomoHce.js, which
// generates android/app/src/main/res/xml/apduservice.xml on prebuild).
const AID = 'F0544F4D4F31';

type HceModule = {
  setPayload: (payload: string) => Promise<void>;
  clear: () => Promise<void>;
  lastTapAt: () => Promise<number>;
  // Added later than the other methods; may be missing on stale dev-client
  // binaries, so call sites treat it as optional.
  lastServedAt?: () => Promise<number>;
};

const TomoHce: HceModule | undefined = NativeModules.TomoHce;

export function hceAvailable(): boolean {
  return Platform.OS === 'android' && !!TomoHce;
}

// supported = hardware exists; enabled = the NFC toggle is actually on
export async function nfcState(): Promise<{ supported: boolean; enabled: boolean }> {
  try {
    if (Platform.OS !== 'android') return { supported: false, enabled: false };
    const supported = await NfcManager.isSupported();
    const enabled = supported ? await NfcManager.isEnabled() : false;
    return { supported, enabled };
  } catch {
    return { supported: false, enabled: false };
  }
}

export async function nfcAvailable(): Promise<boolean> {
  const s = await nfcState();
  return s.supported;
}

// Timestamp (ms) of the last time another phone touched ours while showing
// (any APDU reached our HCE service, even if we could not serve the payload).
export async function lastTapAt(): Promise<number> {
  try {
    return (await TomoHce?.lastTapAt()) ?? 0;
  } catch {
    return 0;
  }
}

// Timestamp (ms) of the last time the payload was actually delivered to a
// reader with SW 9000. lastTapAt > 0 but lastServedAt == 0 means radio contact
// happened but the SELECT never matched or no payload was set - that
// distinction pinpoints where a failing tap died.
export async function lastServedAt(): Promise<number> {
  try {
    return (await TomoHce?.lastServedAt?.()) ?? 0;
  } catch {
    return 0;
  }
}

// "Show" side: additionally act as an NFC tag when the hardware allows it.
// The QR code is always shown; NFC is a bonus transport. Returns whether the
// tap transport is genuinely live (module present AND the NFC toggle is on -
// HCE does nothing when the radio is off, so reporting true on a disabled
// radio would make the UI advertise a tap that can never work).
export async function startShowing(payload: string): Promise<boolean> {
  if (!TomoHce) return false;
  const s = await nfcState();
  if (!s.enabled) return false;
  try {
    await TomoHce.setPayload(payload);
    return true;
  } catch {
    return false;
  }
}

export async function stopShowing(): Promise<void> {
  await TomoHce?.clear();
}

function toBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

// --- scan side ---------------------------------------------------------------
//
// Reading another phone's HCE card MUST use Android reader mode: while active,
// reader mode "disables any peer-to-peer and card-emulation modes of the NFC
// adapter on this device" (NfcAdapter#enableReaderMode). Without it the
// scanning phone keeps polling AND listening as a card at the same time - and
// since both phones run this app, both advertise the same Tomo AID, so the two
// controllers pair up in a random direction on every tap and the read usually
// never happens. Reader mode pins the roles: scanner = reader, shower = card.
// It also delivers the tag straight to a callback instead of relaunching the
// activity through a foreground-dispatch intent while the RF link decays.
//
// We open the tag-event session ourselves (instead of letting
// requestTechnology auto-register) so that:
//  - our reader-mode flags are always applied, and
//  - nfc-manager's auto-cleanup (which unregisters the session on a delayed
//    timer after each cancel) cannot briefly kill the radio between retries.
const READER_MODE_OPTIONS = {
  isReaderModeEnabled: true,
  readerModeFlags:
    NfcAdapter.FLAG_READER_NFC_A |
    NfcAdapter.FLAG_READER_NFC_B |
    NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK,
};

let scanSessionOpen = false;

async function ensureScanSession(): Promise<void> {
  await NfcManager.start();
  if (!scanSessionOpen) {
    await NfcManager.registerTagEvent(READER_MODE_OPTIONS);
    scanSessionOpen = true;
  }
}

export async function cancelScan(): Promise<void> {
  await NfcManager.cancelTechnologyRequest().catch(() => {});
  if (scanSessionOpen) {
    scanSessionOpen = false;
    await NfcManager.unregisterTagEvent().catch(() => {});
  }
}

// "Scan" side: read the other phone once over NFC. Resolves with its payload string.
export async function scanOnce(): Promise<string> {
  await ensureScanSession();
  try {
    const tech = await NfcManager.requestTechnology(NfcTech.IsoDep);
    if (tech !== NfcTech.IsoDep) {
      // A tag was touched but the ISO-DEP connect failed (grazing contact).
      throw new Error('the touch was too quick');
    }
    const select = [0x00, 0xa4, 0x04, 0x00, AID.length / 2, ...toBytes(AID), 0x00];
    const resp: number[] = await NfcManager.isoDepHandler.transceive(select);
    if (resp.length < 2) throw new Error('Empty response');
    const sw = (resp[resp.length - 2] << 8) | resp[resp.length - 1];
    if (sw !== 0x9000) throw new Error('The other phone is not showing a code right now');
    const data = resp.slice(0, -2);
    return String.fromCharCode(...data);
  } finally {
    // Frees the pending tech request but keeps the reader-mode session open
    // for the caller's retry loop; cancelScan() closes the session. Awaited so
    // an immediate retry cannot race the native "one request at a time" guard.
    await NfcManager.cancelTechnologyRequest().catch(() => {});
  }
}
