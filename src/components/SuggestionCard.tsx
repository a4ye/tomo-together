import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Image, ImageSourcePropType, Pressable, Text, View } from 'react-native';
import { useNav } from '../state/nav';
import { useSession } from '../state/session';
import { C, F } from '../theme';
import { Suggestion } from '../types';
import Avatar from './Avatar';
import { DoodleCard } from './Doodle';
import { AnimatedPixelSprite, CAMPFIRE_FRAMES } from './PixelSprite';
import {
  BTN_CREAM, BTN_CREAM_PRESSED, BTN_TAN, BTN_TAN_PRESSED, ICONS, NineSliceBg,
} from './PixelUI';

const DISMISS_KEY = 'tomo.suggestDismissed';
const DEPOSIT_KEY = 'tomo.deposit';

function todayStamp(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// "Friday 6pm" — weekday plus compact time, minutes only when non-zero.
function formatWhen(iso: string): string {
  const d = new Date(iso);
  const weekday = d.toLocaleDateString(undefined, { weekday: 'long' });
  const h = d.getHours();
  const m = d.getMinutes();
  const h12 = ((h + 11) % 12) + 1;
  const ampm = h < 12 ? 'am' : 'pm';
  return `${weekday} ${h12}${m > 0 ? `:${String(m).padStart(2, '0')}` : ''}${ampm}`;
}

// Sprout Lands sprite button holding a pixel icon instead of a text label
// (same press behavior as DoodleButton, which only renders text).
function IconButton({
  icon, primary = false, disabled = false, onPress,
}: {
  icon: ImageSourcePropType; primary?: boolean; disabled?: boolean; onPress: () => void;
}) {
  const [pressed, setPressed] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;
  const springTo = (v: number) =>
    Animated.spring(scale, { toValue: v, useNativeDriver: true, speed: 40, bounciness: 10 }).start();
  const set = primary
    ? pressed ? BTN_TAN_PRESSED : BTN_TAN
    : pressed ? BTN_CREAM_PRESSED : BTN_CREAM;
  return (
    <Pressable
      disabled={disabled}
      style={{ flex: 1 }}
      onPressIn={() => { setPressed(true); springTo(0.95); }}
      onPressOut={() => { setPressed(false); springTo(1); }}
      onPress={onPress}
    >
      <Animated.View
        style={{
          paddingVertical: 9, minHeight: 40, alignItems: 'center', justifyContent: 'center',
          opacity: disabled ? 0.45 : 1, transform: [{ scale }],
        }}
      >
        <NineSliceBg set={set} corner={12} />
        <Image source={icon} style={{ width: 20, height: 20, marginTop: pressed ? 2 : 0 }} resizeMode="contain" />
      </Animated.View>
    </Pressable>
  );
}

export default function SuggestionCard({ delay = 0 }: { delay?: number }) {
  const { api } = useSession();
  const nav = useNav();
  const [sugg, setSugg] = useState<Suggestion | null>(null);
  const [deposit, setDeposit] = useState<{ amount: number; quota: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pop = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.suggestion(),
      AsyncStorage.getItem(DISMISS_KEY).catch(() => null),
    ])
      .then(([r, dismissed]) => {
        if (!alive) return;
        const s = r.suggestion;
        if (!s) return;
        if (dismissed === `${todayStamp()}|${s.friend.username}|${s.activity.id}`) return;
        setSugg(s);
      })
      .catch(() => {}); // request failed: no card
    AsyncStorage.getItem(DEPOSIT_KEY)
      .then((raw) => {
        if (!alive || !raw) return;
        try {
          const d = JSON.parse(raw) as { amount?: unknown; quota?: unknown };
          if (typeof d.amount === 'number' && typeof d.quota === 'number' && d.quota > 0) {
            setDeposit({ amount: d.amount, quota: d.quota });
          }
        } catch {}
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [api]);

  useEffect(() => {
    if (!sugg) return;
    Animated.sequence([
      Animated.delay(delay),
      Animated.spring(pop, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 10 }),
    ]).start();
  }, [sugg, delay, pop]);

  if (!sugg) return null;
  const s = sugg;

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const { hangout } = await api.createHangout({
        activity: s.activity.id,
        date: s.date,
        place: 'TBD',
        friendUsernames: [s.friend.username],
      });
      // hide the card right away; the server also stops suggesting this pair
      // while the created hangout is open
      AsyncStorage.setItem(DISMISS_KEY, `${todayStamp()}|${s.friend.username}|${s.activity.id}`).catch(() => {});
      setSugg(null);
      nav.push({ name: 'hangoutDetail', hangoutId: hangout.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create hangout');
      setBusy(false);
    }
  };

  const dismiss = () => {
    AsyncStorage.setItem(DISMISS_KEY, `${todayStamp()}|${s.friend.username}|${s.activity.id}`).catch(() => {});
    setSugg(null);
  };

  const perHangout = deposit ? Math.round(deposit.amount / deposit.quota) : 0;

  return (
    <Animated.View
      style={{
        opacity: pop,
        transform: [
          { translateY: pop.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
          { scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) },
        ],
      }}
    >
      <DoodleCard seed={23} bg={C.card} style={{ padding: 13 }}>
        <Text
          allowFontScaling={false}
          style={{ fontFamily: F.display, fontSize: 16, color: C.darkInk, textAlign: 'center' }}
        >
          Hangout suggestion
        </Text>
        <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.brown, textAlign: 'center', marginTop: 3 }}>
          {s.activity.label} with {s.friend.name} · {formatWhen(s.date)}?
        </Text>

        <View style={{ flexDirection: 'row', marginTop: 10 }}>
          <IconButton icon={ICONS.check} primary disabled={busy} onPress={accept} />
          <View style={{ width: 10 }} />
          <IconButton icon={ICONS.x} disabled={busy} onPress={dismiss} />
        </View>
        {error && (
          <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.redPin, textAlign: 'center', marginTop: 6 }}>
            {error}
          </Text>
        )}

        {/* friend by the campfire, like the sketch */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', marginTop: 8 }}>
          <Avatar color={s.friend.color} species={s.friend.species} equipped={s.friend.equipped} size={64} />
          <View style={{ width: 12 }} />
          <AnimatedPixelSprite frames={CAMPFIRE_FRAMES} px={4} interval={300} style={{ marginBottom: 4 }} />
        </View>

        {deposit && (
          <View
            style={{
              alignSelf: 'center', marginTop: 8, backgroundColor: C.yellow,
              borderWidth: 2.5, borderColor: C.brown, borderRadius: 6,
              paddingVertical: 3, paddingHorizontal: 10,
            }}
          >
            <Text
              allowFontScaling={false}
              style={{ fontFamily: F.display, fontSize: 12, color: C.darkInk, includeFontPadding: false }}
            >
              Earn ${perHangout} back
            </Text>
          </View>
        )}
      </DoodleCard>
    </Animated.View>
  );
}
