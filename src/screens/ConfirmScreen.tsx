import { CameraView, useCameraPermissions } from 'expo-camera';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';
import { DoodleButton } from '../components/Doodle';
import OutlinedText from '../components/OutlinedText';
import YardBackground from '../components/YardBackground';
import TopBar from '../components/TopBar';
import {
  cancelScan, diagLog, getDiagSnapshot, lastServedAt, lastTapAt, moduleInfo, nfcState,
  scanOnce, startShowing, stopShowing, subscribeDiag,
} from '../nfc';
import type { DiagEntry } from '../nfc';
import { useNav } from '../state/nav';
import { useSession } from '../state/session';
import { C, F } from '../theme';

function PhonesTouching({ size = 120 }: { size?: number }) {
  return (
    <Svg width={size} height={size * 0.7} viewBox="0 0 120 84">
      <Path d="M14 10 L44 10 L44 74 L14 74 Z" fill={C.white} stroke={C.darkInk} strokeWidth={3.5}
        strokeLinejoin="round" transform="rotate(-8 29 42)" />
      <Path d="M76 10 L106 10 L106 74 L76 74 Z" fill={C.white} stroke={C.darkInk} strokeWidth={3.5}
        strokeLinejoin="round" transform="rotate(8 91 42)" />
      <Circle cx={60} cy={42} r={5} fill={C.orange} />
      <Path d="M52 30 C46 36 46 48 52 54 M68 30 C74 36 74 48 68 54"
        fill="none" stroke={C.orange} strokeWidth={3} strokeLinecap="round" />
    </Svg>
  );
}

function fmtTime(ts: number): string {
  if (!ts) return '--:--:--.---';
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

type Phase = 'pick' | 'showing' | 'scanning' | 'done';

export default function ConfirmScreen({
  hangoutId, otherUsername, otherName,
}: {
  hangoutId: number; otherUsername: string; otherName: string;
}) {
  const { api } = useSession();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>('pick');
  const [status, setStatus] = useState<string | null>(null);
  const [nfcNote, setNfcNote] = useState<string | null>(null);
  const [payload, setPayload] = useState<string | null>(null);
  const [hceOn, setHceOn] = useState(false);
  const [nfc, setNfc] = useState({ supported: false, enabled: false });
  const [tapSeen, setTapSeen] = useState(false);
  const [servedSeen, setServedSeen] = useState(false);
  const [result, setResult] = useState<{ vibeGain: number; acornGain: number; bonusReason: string | null } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tapPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const handled = useRef(false);
  const armed = useRef(false);
  const tapSeenRef = useRef(false);
  const servedSeenRef = useRef(false);

  // ---- hidden diagnostics overlay: 5 rapid taps on the QR/code/camera area ----
  const [diagOpen, setDiagOpen] = useState(false);
  const [diagRows, setDiagRows] = useState<DiagEntry[]>([]);
  const diagTapRef = useRef({ n: 0, t: 0 });

  const onDiagTap = useCallback(() => {
    const now = Date.now();
    const prev = diagTapRef.current;
    const n = now - prev.t < 2200 ? prev.n + 1 : 1;
    diagTapRef.current = { n, t: now };
    if (n >= 5) {
      diagTapRef.current = { n: 0, t: 0 };
      setDiagOpen((v) => {
        if (!v) diagLog('ui: diagnostics overlay opened');
        return !v;
      });
    }
  }, []);

  useEffect(() => {
    if (!diagOpen) return;
    let live = true;
    const refresh = async () => {
      const rows = await getDiagSnapshot();
      if (live) setDiagRows(rows);
    };
    refresh();
    const id = setInterval(refresh, 700);
    const unsub = subscribeDiag(refresh);
    return () => {
      live = false;
      clearInterval(id);
      unsub();
    };
  }, [diagOpen]);

  useEffect(() => {
    const mi = moduleInfo();
    diagLog(`ui: confirm open (modules hce=${mi.tomoHce} reader=${mi.tomoReader} nfcMgr=${mi.nfcManagerNative})`);
    nfcState().then(setNfc);
    return () => {
      armed.current = false;
      stopShowing().catch(() => {});
      cancelScan().catch(() => {});
      if (pollRef.current) clearInterval(pollRef.current);
      if (tapPollRef.current) clearInterval(tapPollRef.current);
    };
  }, []);

  const isConfirmedWithOther = useCallback(async () => {
    const { hangout } = await api.hangout(hangoutId);
    return hangout.confirmedPairs.some(([x, y]) => x === otherUsername || y === otherUsername);
  }, [api, hangoutId, otherUsername]);

  // ---- show side: QR always, NFC too when the hardware allows it ----
  const show = async () => {
    setStatus(null);
    diagLog('ui: "Show my code" pressed');
    try {
      const { payload: p } = await api.nfcToken(hangoutId);
      diagLog(`ui: token fetched (${p.length} chars)`);
      setPayload(p);
      const on = await startShowing(p);
      diagLog(`ui: startShowing -> tap hint ${on ? 'ON' : 'OFF'}`);
      setHceOn(on);
      setPhase('showing');
      const showStart = Date.now();
      // Poll the HCE service state whenever the module exists - even when the
      // hint is off, the payload stays armed and the radio may come back.
      tapPollRef.current = setInterval(async () => {
        const [t, s] = await Promise.all([lastTapAt(), lastServedAt()]);
        if (t > showStart && !tapSeenRef.current) {
          tapSeenRef.current = true;
          diagLog('ui: phones touched (hce got an apdu)');
          setTapSeen(true);
        }
        if (s > showStart && !servedSeenRef.current) {
          servedSeenRef.current = true;
          diagLog('ui: their phone read the payload (sw 9000)');
          setServedSeen(true);
        }
      }, 1000);
      pollRef.current = setInterval(async () => {
        try {
          if (await isConfirmedWithOther()) {
            diagLog('ui: server says confirmed, closing');
            if (pollRef.current) clearInterval(pollRef.current);
            await stopShowing();
            setResult({ vibeGain: 0, acornGain: 0, bonusReason: null });
            setPhase('done');
          }
        } catch {
          // keep polling
        }
      }, 2500);
    } catch (e) {
      diagLog(`ui: show failed (${e instanceof Error ? e.message : 'unknown'})`);
      setStatus(e instanceof Error ? e.message : 'Could not start');
    }
  };

  // ---- scan side ----
  const handlePayload = useCallback(async (raw: string, src: 'qr' | 'nfc' = 'qr') => {
    if (handled.current) return;
    handled.current = true;
    diagLog(`ui: payload via ${src}, confirming with server...`);
    try {
      const parts = raw.split('|');
      if (parts[0] !== 'TY1' || parts.length !== 4) throw new Error('That is not a Tomo Yard code');
      if (Number(parts[1]) !== hangoutId) throw new Error('That code is for a different hangout');
      if (parts[2] !== otherUsername) throw new Error(`That code belongs to @${parts[2]}, not @${otherUsername}`);
      const r = await api.confirm(hangoutId, parts[2], parts[3]);
      diagLog('ui: confirm OK');
      armed.current = false;
      await cancelScan();
      setResult({ vibeGain: r.vibeGain, acornGain: r.acornGain, bonusReason: r.bonusReason });
      setPhase('done');
    } catch (e) {
      diagLog(`ui: confirm failed (${e instanceof Error ? e.message : 'unknown'})`);
      setStatus(e instanceof Error ? e.message : 'Could not confirm, try again');
      setTimeout(() => {
        handled.current = false;
        setStatus(null);
      }, 2500);
    }
  }, [api, hangoutId, otherUsername]);

  // keep the NFC reader armed while scanning; surface every failure
  const armNfcLoop = useCallback(async () => {
    const s = await nfcState();
    if (!s.supported) {
      setNfcNote('This phone has no NFC. Use the camera on their code.');
      return;
    }
    if (!s.enabled) {
      setNfcNote('NFC is turned off in your phone settings. Turn it on, or use the camera.');
      return;
    }
    armed.current = true;
    diagLog('ui: nfc scan loop armed');
    setNfcNote('NFC is listening. Touch the phones back to back, slowly.');
    while (armed.current && !handled.current) {
      try {
        const p = await scanOnce();
        if (!armed.current) break;
        await handlePayload(p, 'nfc');
        break;
      } catch (e) {
        if (!armed.current) break;
        const msg = e instanceof Error && e.message ? e.message : 'no contact yet';
        if (msg === 'cancelled') break;
        diagLog(`ui: scan loop retry (${msg})`);
        if (msg === 'still waiting for a touch') {
          setNfcNote('NFC is listening. Touch the phones back to back, slowly.');
        } else if (msg === 'This phone has no NFC' || msg.startsWith('NFC is turned off')) {
          // Hard condition - stop looping instead of hammering the radio.
          setNfcNote(`${msg}. Use the camera on their code.`);
          armed.current = false;
          break;
        } else {
          setNfcNote(`NFC: ${msg}. Still listening.`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    diagLog('ui: nfc scan loop ended');
  }, [handlePayload]);

  const scan = async () => {
    setStatus(null);
    handled.current = false;
    diagLog(`ui: "Scan ${otherUsername}'s code" pressed`);
    if (!permission?.granted) {
      const r = await requestPermission();
      diagLog(`ui: camera permission ${r.granted ? 'granted' : 'DENIED'}`);
      if (!r.granted) {
        setStatus('The camera is needed to scan their code.');
        return;
      }
    }
    setPhase('scanning');
    armNfcLoop();
  };

  const mi = moduleInfo();

  return (
    <View style={{ flex: 1 }}>
      <YardBackground bg={C.tan} tint={C.tanPaw} seed={27} />
      <View style={{ paddingTop: insets.top }}>
        <TopBar title="Confirm" />
      </View>

      <View style={{ flex: 1, padding: 20, alignItems: 'center' }}>
        {phase !== 'scanning' && (
          <Pressable onPress={onDiagTap}>
            <PhonesTouching size={130} />
          </Pressable>
        )}
        <Text style={{ fontFamily: F.display, fontSize: 15, color: C.darkInk, marginTop: 6, textAlign: 'center' }}>
          You and {otherName}
        </Text>

        {phase === 'pick' && (
          <>
            <Text style={{ fontFamily: F.body, fontSize: 14, color: C.brown, marginTop: 6, textAlign: 'center' }}>
              Prove you are really together. One of you shows a code, the other scans it.
              {nfc.enabled ? ' Tapping phones works too.' : ''}
            </Text>
            {nfc.supported && !nfc.enabled && (
              <Text style={{ fontFamily: F.body, fontSize: 13, color: C.redPin, marginTop: 6, textAlign: 'center' }}>
                NFC is turned off in your phone settings, so only the camera will work.
              </Text>
            )}
            <View style={{ marginTop: 18, width: '100%' }}>
              <DoodleButton label="Show my code" seed={5} bg={C.yellow} border={C.brown} onPress={show} />
              <View style={{ height: 10 }} />
              <DoodleButton label={`Scan ${otherName}'s code`} seed={6} onPress={scan} />
            </View>
            {status && (
              <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.redPin, marginTop: 12, textAlign: 'center' }}>
                {status}
              </Text>
            )}
          </>
        )}

        {phase === 'showing' && payload && (
          <View style={{ alignItems: 'center', marginTop: 12 }}>
            <Pressable
              onPress={onDiagTap}
              style={{
                backgroundColor: C.white, borderWidth: 3, borderColor: C.darkInk,
                borderRadius: 6, padding: 14,
              }}
            >
              <QRCode value={payload} size={214} color={C.darkInk} backgroundColor={C.white} />
            </Pressable>
            <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.brown, marginTop: 12, textAlign: 'center' }}>
              Have {otherName} scan this{hceOn ? ', or touch your phones back to back' : ''}.
              This screen will notice when it works.
            </Text>
            {servedSeen ? (
              <Text style={{ fontFamily: F.display, fontSize: 13.5, color: C.labelGreen, marginTop: 8, textAlign: 'center' }}>
                Their phone read your code! Waiting for the confirm to land.
              </Text>
            ) : tapSeen ? (
              <Text style={{ fontFamily: F.display, fontSize: 13.5, color: C.labelGreen, marginTop: 8, textAlign: 'center' }}>
                Phones touched! Waiting for their phone to finish.
              </Text>
            ) : null}
            {!hceOn && nfc.supported && (
              <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.fadedInk, marginTop: 6, textAlign: 'center' }}>
                Phone tapping is unavailable on this phone, the code still works.
              </Text>
            )}
          </View>
        )}

        {phase === 'scanning' && (
          <>
            <Pressable
              onPress={onDiagTap}
              style={{
                width: '92%', aspectRatio: 1, borderWidth: 3, borderColor: C.darkInk,
                borderRadius: 6, overflow: 'hidden', backgroundColor: '#EFE8D8', marginTop: 12,
              }}
            >
              {permission?.granted && (
                <CameraView
                  facing="back"
                  style={{ width: '100%', height: '100%' }}
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={({ data }) => handlePayload(data, 'qr')}
                />
              )}
            </Pressable>
            <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.brown, marginTop: 10, textAlign: 'center' }}>
              Point the camera at {otherName}'s code.
            </Text>
            {nfcNote && (
              <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.fadedInk, marginTop: 6, textAlign: 'center' }}>
                {nfcNote}
              </Text>
            )}
            {status && (
              <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.redPin, marginTop: 8, textAlign: 'center' }}>
                {status}
              </Text>
            )}
          </>
        )}

        {phase === 'done' && (
          <View style={{ alignItems: 'center', marginTop: 16 }}>
            <OutlinedText size={28} color={C.yellow} outline={C.darkInk} thickness={2.5}>
              Confirmed!
            </OutlinedText>
            {result && result.vibeGain > 0 && (
              <Text style={{ fontFamily: F.display, fontSize: 15, color: C.labelGreen, marginTop: 6 }}>
                Vibe +{result.vibeGain}
                {result.bonusReason ? ` (${result.bonusReason} x2)` : ''}
              </Text>
            )}
            {result && result.acornGain > 0 && (
              <Text style={{ fontFamily: F.display, fontSize: 15, color: C.orange, marginTop: 2 }}>
                Vibe level up! You both got {result.acornGain} acorns
              </Text>
            )}
            <View style={{ marginTop: 14 }}>
              <DoodleButton label="Back to the hangout" seed={11} onPress={nav.back} />
            </View>
          </View>
        )}
      </View>

      {diagOpen && (
        <View
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '46%',
            backgroundColor: 'rgba(24,18,12,0.94)', borderTopWidth: 2, borderColor: C.orange,
            paddingBottom: insets.bottom, zIndex: 40, elevation: 40,
          }}
        >
          <Pressable
            onPress={() => setDiagOpen(false)}
            style={{ paddingHorizontal: 8, paddingVertical: 7, borderBottomWidth: 1, borderColor: '#5A4632' }}
          >
            <Text style={{ color: '#FFD37E', fontSize: 11, fontFamily: 'monospace' }}>
              NFC DIAG · hce:{mi.tomoHce ? 'yes' : 'MISSING'} rdr:{mi.tomoReader ? 'yes' : 'MISSING'} mgr:
              {mi.nfcManagerNative ? 'yes' : 'MISSING'} · sup:{nfc.supported ? 'y' : 'N'} on:
              {nfc.enabled ? 'y' : 'N'} · tap here to close
            </Text>
          </Pressable>
          <ScrollView style={{ paddingHorizontal: 8, paddingTop: 4 }}>
            {diagRows.slice().reverse().map((r, i) => (
              <Text
                key={`${r.ts}-${i}`}
                style={{
                  color: r.src === 'hce' ? '#8FD98F' : r.src === 'native' ? '#9FCFFF' : '#EFE3CF',
                  fontSize: 10, fontFamily: 'monospace', marginBottom: 1,
                }}
              >
                {fmtTime(r.ts)} {r.msg}
              </Text>
            ))}
            <View style={{ height: 8 }} />
          </ScrollView>
        </View>
      )}
    </View>
  );
}
