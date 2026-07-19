import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { useNav } from '../state/nav';
import { useSession } from '../state/session';
import { C, F } from '../theme';
import Avatar from './Avatar';
import { DoodleCard } from './Doodle';
import { HEADBAND, MONEYBAG, PixelSprite } from './PixelSprite';

const DEPOSIT_KEY = 'tomo.deposit';

// "Hangout Reminder" (sketch 5): determined creature with headband, money bag
// in paw, speech bubble with the accumulated deposit. Tap goes to Deposit.
export default function DepositReminder({ delay = 0 }: { delay?: number }) {
  const { api, me } = useSession();
  const nav = useNav();
  const [deposit, setDeposit] = useState<{ amount: number; quota: number } | null>(null);
  const [thisMonth, setThisMonth] = useState<number | null>(null);
  const pop = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(DEPOSIT_KEY)
      .then((raw) => {
        if (!alive || !raw) return;
        try {
          const d = JSON.parse(raw) as { amount?: unknown; quota?: unknown };
          if (typeof d.amount === 'number' && typeof d.quota === 'number' && d.quota > 0) {
            setDeposit({ amount: d.amount, quota: d.quota });
            // same source DepositScreen uses for this month's completed count
            api.leaderboard()
              .then((r) => {
                if (!alive) return;
                const meRow = r.leaderboard.find((x) => x.isMe);
                setThisMonth(meRow ? meRow.count : 0);
              })
              .catch(() => {});
          }
        } catch {}
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [api]);

  useEffect(() => {
    if (!deposit) return;
    Animated.sequence([
      Animated.delay(delay),
      Animated.spring(pop, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 10 }),
    ]).start();
  }, [deposit, delay, pop]);

  if (!deposit) return null;

  const size = 60;
  return (
    <Animated.View
      style={{
        opacity: pop,
        transform: [
          { translateY: pop.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
          { scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) },
        ],
        marginTop: 8,
      }}
    >
      <Pressable onPress={() => nav.push({ name: 'deposit' })}>
        <DoodleCard seed={31} style={{ padding: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {/* determined me: headband tied across the forehead, money bag in paw */}
            <View style={{ width: size + 26, height: size + 4, justifyContent: 'flex-end' }}>
              <Avatar
                color={me?.color ?? '#A8D8C8'}
                species={me?.species}
                equipped={me?.equipped}
                size={size}
              />
              <PixelSprite
                map={HEADBAND}
                px={3}
                style={{ position: 'absolute', left: 2, top: size * 0.2 }}
              />
              <PixelSprite
                map={MONEYBAG}
                px={3}
                style={{ position: 'absolute', right: -8, bottom: -2 }}
              />
            </View>

            {/* speech bubble */}
            <View style={{ flex: 1, marginLeft: 14 }}>
              <View
                style={{
                  position: 'absolute', left: -5, top: '42%', width: 13, height: 13,
                  backgroundColor: C.white, borderWidth: 2.5, borderColor: '#C89A62',
                  transform: [{ rotate: '45deg' }],
                }}
              />
              <View
                style={{
                  backgroundColor: C.white, borderWidth: 2.5, borderColor: '#C89A62',
                  borderRadius: 6, paddingVertical: 7, paddingHorizontal: 11,
                }}
              >
                <Text
                  allowFontScaling={false}
                  style={{ fontFamily: F.display, fontSize: 15, color: C.darkInk, includeFontPadding: false }}
                >
                  Accumulated ${deposit.amount}
                </Text>
                <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.brown, marginTop: 2 }}>
                  {thisMonth ?? 0} of {deposit.quota} hangouts this month
                </Text>
              </View>
            </View>
          </View>
        </DoodleCard>
      </Pressable>
    </Animated.View>
  );
}
