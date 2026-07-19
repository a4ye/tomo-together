import { CameraView, useCameraPermissions } from 'expo-camera';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';
import { DoodleButton, DoodleCard } from '../components/Doodle';
import OutlinedText from '../components/OutlinedText';
import YardBackground from '../components/YardBackground';
import TopBar from '../components/TopBar';
import { cancelScan, nfcAvailable, scanOnce, startShowing, stopShowing } from '../nfc';
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
  const [payload, setPayload] = useState<string | null>(null);
  const [hceOn, setHceOn] = useState(false);
  const [nfcOn, setNfcOn] = useState(false);
  const [result, setResult] = useState<{ vibeGain: number; acornGain: number; bonusReason: string | null } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    nfcAvailable().then(setNfcOn);
    return () => {
      stopShowing().catch(() => {});
      cancelScan().catch(() => {});
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const isConfirmedWithOther = useCallback(async () => {
    const { hangout } = await api.hangout(hangoutId);
    return hangout.confirmedPairs.some(([x, y]) => x === otherUsername || y === otherUsername);
  }, [api, hangoutId, otherUsername]);

  // ---- show side: QR always, NFC too when the hardware can ----
  const show = async () => {
    setStatus(null);
    try {
      const { payload: p } = await api.nfcToken(hangoutId);
      setPayload(p);
      setHceOn(await startShowing(p));
      setPhase('showing');
      pollRef.current = setInterval(async () => {
        try {
          if (await isConfirmedWithOther()) {
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
      setStatus(e instanceof Error ? e.message : 'Could not start');
    }
  };

  // ---- scan side: camera reads the QR; NFC listens too when available ----
  const handlePayload = useCallback(async (raw: string) => {
    if (handled.current) return;
    handled.current = true;
    try {
      const parts = raw.split('|');
      if (parts[0] !== 'TY1' || parts.length !== 4) throw new Error('That is not a Tomo Yard code');
      if (Number(parts[1]) !== hangoutId) throw new Error('That code is for a different hangout');
      if (parts[2] !== otherUsername) throw new Error(`That code belongs to @${parts[2]}, not @${otherUsername}`);
      const r = await api.confirm(hangoutId, parts[2], parts[3]);
      await cancelScan();
      setResult({ vibeGain: r.vibeGain, acornGain: r.acornGain, bonusReason: r.bonusReason });
      setPhase('done');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Could not confirm, try again');
      setTimeout(() => {
        handled.current = false;
        setStatus(null);
      }, 2500);
    }
  }, [api, hangoutId, otherUsername]);

  const scan = async () => {
    setStatus(null);
    handled.current = false;
    if (!permission?.granted) {
      const r = await requestPermission();
      if (!r.granted) {
        setStatus('The camera is needed to scan their code.');
        return;
      }
    }
    setPhase('scanning');
    if (await nfcAvailable()) {
      // race the NFC reader alongside the camera; first source wins
      scanOnce().then(handlePayload).catch(() => {});
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <YardBackground bg={C.tan} tint={C.tanPaw} seed={27} />
      <View style={{ paddingTop: insets.top }}>
        <TopBar title="Confirm" />
      </View>

      <View style={{ flex: 1, padding: 20, alignItems: 'center' }}>
        {phase !== 'scanning' && <PhonesTouching size={130} />}
        <Text style={{ fontFamily: F.display, fontSize: 17, color: C.darkInk, marginTop: 6, textAlign: 'center' }}>
          You and {otherName}
        </Text>

        {phase === 'pick' && (
          <>
            <Text style={{ fontFamily: F.body, fontSize: 14, color: C.brown, marginTop: 6, textAlign: 'center' }}>
              Prove you are really together. One of you shows a code, the other scans it.
              {nfcOn ? ' Tapping phones works too.' : ''}
            </Text>
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
            <View
              style={{
                backgroundColor: C.white, borderWidth: 3, borderColor: C.darkInk,
                borderRadius: 12, padding: 14,
              }}
            >
              <QRCode value={payload} size={214} color={C.darkInk} backgroundColor={C.white} />
            </View>
            <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.brown, marginTop: 12, textAlign: 'center' }}>
              Have {otherName} scan this{hceOn ? ', or just tap your phones together' : ''}.
              This screen will notice when it works.
            </Text>
          </View>
        )}

        {phase === 'scanning' && (
          <>
            <View
              style={{
                width: '92%', aspectRatio: 1, borderWidth: 3, borderColor: C.darkInk,
                borderRadius: 12, overflow: 'hidden', backgroundColor: '#EFE8D8', marginTop: 12,
              }}
            >
              {permission?.granted && (
                <CameraView
                  facing="back"
                  style={{ width: '100%', height: '100%' }}
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={({ data }) => handlePayload(data)}
                />
              )}
            </View>
            <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.brown, marginTop: 10, textAlign: 'center' }}>
              Point the camera at {otherName}'s code{nfcOn ? ', or touch your phones back to back' : ''}.
            </Text>
            {status && (
              <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.redPin, marginTop: 8, textAlign: 'center' }}>
                {status}
              </Text>
            )}
          </>
        )}

        {phase === 'done' && (
          <View style={{ alignItems: 'center', marginTop: 16 }}>
            <OutlinedText size={30} color={C.yellow} outline={C.darkInk} thickness={2.5}>
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
    </View>
  );
}
