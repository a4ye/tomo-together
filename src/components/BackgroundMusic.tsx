import AsyncStorage from '@react-native-async-storage/async-storage';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { AppState, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, F } from '../theme';

const MUSIC_MUTED_KEY = '@tomo-yard/background-music-muted';
const MUSIC_VOLUME = 0.16;

type BackgroundMusicContextValue = {
  muted: boolean;
  preferenceLoaded: boolean;
  toggleMuted: () => void;
};

const BackgroundMusicContext = createContext<BackgroundMusicContextValue | null>(null);

function MusicToggle() {
  const music = useContext(BackgroundMusicContext);
  const insets = useSafeAreaInsets();

  if (!music) return null;

  return (
    <Pressable
      accessibilityHint={music.muted ? 'Turns background music on' : 'Turns background music off'}
      accessibilityLabel="Background music"
      accessibilityRole="switch"
      accessibilityState={{ checked: !music.muted, disabled: !music.preferenceLoaded }}
      disabled={!music.preferenceLoaded}
      hitSlop={8}
      onPress={music.toggleMuted}
      style={({ pressed }) => ({
        position: 'absolute',
        left: 14,
        bottom: insets.bottom + 16,
        zIndex: 1000,
        elevation: 8,
        minWidth: 82,
        minHeight: 38,
        paddingHorizontal: 12,
        paddingVertical: 8,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: C.cream,
        borderWidth: 2.5,
        borderColor: '#C89A62',
        borderRadius: 6,
        opacity: music.preferenceLoaded ? (pressed ? 0.72 : 0.92) : 0.5,
        transform: [{ scale: pressed ? 0.96 : 1 }],
      })}
    >
      <Text
        allowFontScaling={false}
        style={{
          color: music.muted ? C.fadedInk : C.brown,
          fontFamily: F.display,
          fontSize: 11,
          includeFontPadding: false,
        }}
      >
        {music.muted ? 'Music off' : 'Music on'}
      </Text>
    </Pressable>
  );
}

export default function BackgroundMusic({ children }: { children: React.ReactNode }) {
  const player = useAudioPlayer(require('../../Tomo Yard.mp3'));
  const [muted, setMuted] = useState(false);
  const [preferenceLoaded, setPreferenceLoaded] = useState(false);
  const [appIsActive, setAppIsActive] = useState(AppState.currentState === 'active');
  const [webGestureUnlocked, setWebGestureUnlocked] = useState(Platform.OS !== 'web');
  const webGestureUnlockedRef = useRef(Platform.OS !== 'web');

  useEffect(() => {
    player.loop = true;
    player.volume = MUSIC_VOLUME;
  }, [player]);

  useEffect(() => {
    if (Platform.OS === 'web') return;

    // This is foreground-only music: respect silent mode, mix politely with
    // other audio, and let the lifecycle handler below pause in the background.
    setAudioModeAsync({
      interruptionMode: 'mixWithOthers',
      playsInSilentMode: false,
      shouldPlayInBackground: false,
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(MUSIC_MUTED_KEY)
      .then((value) => {
        if (alive) setMuted(value === 'true');
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setPreferenceLoaded(true);
      });

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setAppIsActive(state === 'active');
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const shouldPlay = preferenceLoaded
      && !muted
      && appIsActive
      && webGestureUnlocked;

    try {
      if (shouldPlay) player.play();
      else player.pause();
    } catch {
      // A media failure should not interrupt navigation or auth startup.
    }
  }, [appIsActive, muted, player, preferenceLoaded, webGestureUnlocked]);

  useEffect(() => {
    if (
      Platform.OS !== 'web'
      || !preferenceLoaded
      || muted
      || !appIsActive
      || webGestureUnlockedRef.current
      || typeof document === 'undefined'
    ) {
      return;
    }

    let handled = false;
    const unlockOnGesture = () => {
      if (handled) return;
      handled = true;
      webGestureUnlockedRef.current = true;

      // Calling play inside the gesture handler satisfies browser autoplay
      // policies. The state update keeps normal lifecycle syncing in charge.
      try {
        player.play();
      } catch {
        // expo-audio will retain the preference; a later explicit toggle can retry.
      }
      setWebGestureUnlocked(true);
    };

    document.addEventListener('pointerdown', unlockOnGesture, { capture: true, once: true });
    document.addEventListener('touchend', unlockOnGesture, { capture: true, once: true });
    document.addEventListener('keydown', unlockOnGesture, { capture: true, once: true });

    return () => {
      document.removeEventListener('pointerdown', unlockOnGesture, true);
      document.removeEventListener('touchend', unlockOnGesture, true);
      document.removeEventListener('keydown', unlockOnGesture, true);
    };
  }, [appIsActive, muted, player, preferenceLoaded]);

  const toggleMuted = useCallback(() => {
    const nextMuted = !muted;
    setMuted(nextMuted);
    AsyncStorage.setItem(MUSIC_MUTED_KEY, String(nextMuted)).catch(() => {});

    if (nextMuted) {
      try {
        player.pause();
      } catch {}
      return;
    }

    // On web the toggle itself is a user gesture, so it is always a safe place
    // to unlock playback if autoplay was previously blocked or muted at launch.
    if (Platform.OS === 'web') {
      webGestureUnlockedRef.current = true;
      setWebGestureUnlocked(true);
    }
    if (appIsActive) {
      try {
        player.play();
      } catch {}
    }
  }, [appIsActive, muted, player]);

  const contextValue = useMemo(
    () => ({ muted, preferenceLoaded, toggleMuted }),
    [muted, preferenceLoaded, toggleMuted]
  );

  return (
    <BackgroundMusicContext.Provider value={contextValue}>
      <View style={{ flex: 1 }}>
        {children}
        <MusicToggle />
      </View>
    </BackgroundMusicContext.Provider>
  );
}
