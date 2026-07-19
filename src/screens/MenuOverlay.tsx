import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DoodleButton } from '../components/Doodle';
import { useNav } from '../state/nav';
import { Route } from '../types';

const ITEMS: { label: string; route: Route }[] = [
  { label: 'Explore', route: { name: 'world' } },
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
            <DoodleButton
              label={item.label}
              size={15}
              onPress={() => {
                onClose();
                nav.push(item.route);
              }}
              style={{ minWidth: 185 }}
            />
          </Animated.View>
        ))}
      </View>
    </View>
  );
}
