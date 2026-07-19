import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNav } from '../state/nav';
import { C, F, doodleCorners } from '../theme';
import { Route } from '../types';

const ITEMS: { label: string; route: Route }[] = [
  { label: 'Friends', route: { name: 'friends' } },
  { label: 'Hangouts', route: { name: 'hangouts' } },
  { label: 'Memory Book', route: { name: 'memoryBook' } },
  { label: 'Leaderboard', route: { name: 'leaderboard' } },
  { label: 'Wardrobe', route: { name: 'wardrobe' } },
  { label: 'Deposit', route: { name: 'deposit' } },
];

export default function MenuOverlay({ onClose }: { onClose: () => void }) {
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const anims = useRef(ITEMS.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    Animated.stagger(
      45,
      anims.map((a) =>
        Animated.spring(a, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 10 })
      )
    ).start();
  }, [anims]);

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(74,64,49,0.35)' }]} onPress={onClose} />
      <View style={{ position: 'absolute', right: 16, bottom: insets.bottom + 100 }}>
        {ITEMS.map((item, i) => (
          <Animated.View
            key={item.label}
            style={{
              opacity: anims[i],
              transform: [
                { translateY: anims[i].interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
                { scale: anims[i].interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) },
              ],
              marginTop: 8,
            }}
          >
            <Pressable
              onPress={() => {
                onClose();
                nav.push(item.route);
              }}
            >
              <View
                style={[
                  {
                    backgroundColor: C.cream, borderWidth: 3, borderColor: C.brown,
                    alignItems: 'center',
                    paddingVertical: 11, paddingHorizontal: 14, minWidth: 185,
                  },
                  doodleCorners(i * 4 + 2, 15),
                ]}
              >
                <Text style={{ fontFamily: F.display, fontSize: 17, color: C.brown, includeFontPadding: false }}>
                  {item.label}
                </Text>
              </View>
            </Pressable>
          </Animated.View>
        ))}
      </View>
    </View>
  );
}
