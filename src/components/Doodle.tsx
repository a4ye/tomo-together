import React, { useRef } from 'react';
import { Animated, Pressable, Text, View, ViewStyle } from 'react-native';
import { C, F, doodleCorners, doodleTilt } from '../theme';

// ---- DoodleCard: cream card with wobbly corners + hand-inked border ----
export function DoodleCard({
  children,
  seed = 1,
  tilt = 0,
  bg = C.cream,
  border = C.brown,
  style,
}: {
  children?: React.ReactNode;
  seed?: number;
  tilt?: number;
  bg?: string;
  border?: string;
  style?: ViewStyle | ViewStyle[];
}) {
  return (
    <View
      style={[
        {
          backgroundColor: bg,
          borderWidth: 3,
          borderColor: border,
          padding: 14,
        },
        doodleCorners(seed),
        tilt ? doodleTilt(seed, tilt) : null,
        style as ViewStyle,
      ]}
    >
      {children}
    </View>
  );
}

// ---- DoodleButton: springy hand-drawn button ----
export function DoodleButton({
  label,
  icon,
  onPress,
  seed = 7,
  bg = C.white,
  border = C.orange,
  color = C.brown,
  size = 17,
  disabled = false,
  style,
}: {
  label: string;
  icon?: string;
  onPress?: () => void;
  seed?: number;
  bg?: string;
  border?: string;
  color?: string;
  size?: number;
  disabled?: boolean;
  style?: ViewStyle | ViewStyle[];
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const springTo = (v: number) =>
    Animated.spring(scale, { toValue: v, useNativeDriver: true, speed: 40, bounciness: 12 }).start();
  return (
    <Pressable
      disabled={disabled}
      onPressIn={() => springTo(0.92)}
      onPressOut={() => springTo(1)}
      onPress={onPress}
    >
      <Animated.View
        style={[
          {
            backgroundColor: disabled ? '#E8DDC2' : bg,
            borderWidth: 3,
            borderColor: disabled ? C.fadedInk : border,
            paddingVertical: 9,
            paddingHorizontal: 16,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            transform: [{ scale }],
          },
          doodleCorners(seed, 14),
          style as ViewStyle,
        ]}
      >
        {icon ? (
          <Text allowFontScaling={false} style={{ fontSize: size + 2, marginRight: 7 }}>{icon}</Text>
        ) : null}
        <Text
          allowFontScaling={false}
          style={{
            fontFamily: F.display,
            fontSize: size,
            color: disabled ? C.fadedInk : color,
            includeFontPadding: false,
          }}
        >
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

// ---- Small pill (Catbook stat fields) ----
export function StatPill({
  children,
  borderColor = C.fadedInk,
  style,
}: {
  children: React.ReactNode;
  borderColor?: string;
  style?: ViewStyle;
}) {
  return (
    <View
      style={[
        {
          backgroundColor: C.white,
          borderWidth: 2.5,
          borderColor,
          borderRadius: 14,
          paddingVertical: 6,
          paddingHorizontal: 12,
          minHeight: 34,
          justifyContent: 'center',
        },
        style,
      ]}
    >
      {typeof children === 'string' ? (
        <Text
          allowFontScaling={false}
          style={{ fontFamily: F.body, fontSize: 15, color: C.darkInk, includeFontPadding: false }}
        >
          {children}
        </Text>
      ) : (
        children
      )}
    </View>
  );
}
