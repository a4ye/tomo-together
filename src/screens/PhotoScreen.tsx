import { CameraView, useCameraPermissions } from 'expo-camera';
import React, { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DoodleButton } from '../components/Doodle';
import YardBackground from '../components/YardBackground';
import Polaroid from '../components/Polaroid';
import TopBar from '../components/TopBar';
import { useNav } from '../state/nav';
import { useSession } from '../state/session';
import { C, F } from '../theme';

export default function PhotoScreen({ hangoutId }: { hangoutId: number }) {
  const { api } = useSession();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const camRef = useRef<CameraView>(null);
  const [facing, setFacing] = useState<'front' | 'back'>('front');
  const [shot, setShot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const snap = async () => {
    setError(null);
    try {
      const photo = await camRef.current?.takePictureAsync({ quality: 0.6 });
      if (photo?.uri) setShot(photo.uri);
      else setError('Could not take the photo, try again');
    } catch {
      setError('Could not take the photo, try again');
    }
  };

  const uploadShot = async () => {
    if (!shot) return;
    setBusy(true);
    setError(null);
    try {
      await api.uploadPhoto(hangoutId, shot);
      nav.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <YardBackground bg={C.tan} tint={C.tanPaw} seed={27} />
      <View style={{ paddingTop: insets.top }}>
        <TopBar title="The Photo" />
      </View>

      <View style={{ flex: 1, padding: 16, alignItems: 'center' }}>
        {shot ? (
          <>
            <Polaroid seed={5} width={240} photoUri={shot} />
            {error && (
              <Text style={{ fontFamily: F.body, fontSize: 13, color: C.redPin, marginTop: 8 }}>{error}</Text>
            )}
            <View style={{ flexDirection: 'row', marginTop: 16 }}>
              <DoodleButton label="Retake" seed={7} onPress={() => setShot(null)} style={{ marginRight: 10 }} />
              <DoodleButton
                label={busy ? 'Saving' : 'Use this one'}
                seed={8} bg={C.yellow} border={C.brown} disabled={busy}
                onPress={uploadShot}
              />
            </View>
          </>
        ) : (
          <>
            <Text style={{ fontFamily: F.body, fontSize: 14.5, color: C.brown, textAlign: 'center', marginBottom: 10 }}>
              One photo of the whole crew for the Memory Book.
            </Text>
            <View
              style={{
                width: '92%', aspectRatio: 3 / 4, borderWidth: 3, borderColor: C.darkInk,
                borderRadius: 8, overflow: 'hidden', backgroundColor: '#EFE8D8',
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              {permission?.granted ? (
                <CameraView ref={camRef} facing={facing} style={{ width: '100%', height: '100%' }} />
              ) : (
                <View style={{ alignItems: 'center', padding: 16 }}>
                  <Text style={{ fontFamily: F.body, fontSize: 14, color: C.brown, textAlign: 'center', marginBottom: 10 }}>
                    Tomo Yard needs the camera for hangout photos.
                  </Text>
                  <DoodleButton label="Allow camera" seed={3} onPress={() => requestPermission()} />
                </View>
              )}
            </View>
            {error && (
              <Text style={{ fontFamily: F.body, fontSize: 13, color: C.redPin, marginTop: 8 }}>{error}</Text>
            )}
            {permission?.granted && (
              <View style={{ flexDirection: 'row', marginTop: 14 }}>
                <DoodleButton
                  label="Flip"
                  seed={4}
                  onPress={() => setFacing((f) => (f === 'front' ? 'back' : 'front'))}
                  style={{ marginRight: 10 }}
                />
                <DoodleButton label="Snap" seed={5} bg={C.yellow} border={C.brown} onPress={snap} />
              </View>
            )}
          </>
        )}
      </View>
    </View>
  );
}
