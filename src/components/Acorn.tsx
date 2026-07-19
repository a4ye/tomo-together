import React from 'react';
import { Text, View, ViewStyle } from 'react-native';
import Svg, { Ellipse, Path } from 'react-native-svg';
import { C, F } from '../theme';

export function AcornIcon({ size = 22 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <Path d="M8 14 C8 24 13 29 16 29 C19 29 24 24 24 14 Z"
        fill="#C89058" stroke={C.darkInk} strokeWidth={2.5} strokeLinejoin="round" />
      <Ellipse cx={16} cy={12.5} rx={10} ry={5} fill="#8A6B42" stroke={C.darkInk} strokeWidth={2.5} />
      <Path d="M16 7.5 C15 4.5 17 3 19 3" fill="none" stroke={C.darkInk} strokeWidth={2.5} strokeLinecap="round" />
    </Svg>
  );
}

export default function AcornPill({ amount, style }: { amount: number; style?: ViewStyle }) {
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: C.cream,
          borderWidth: 3,
          borderColor: C.brown,
          borderRadius: 18,
          paddingVertical: 5,
          paddingHorizontal: 12,
        },
        style,
      ]}
    >
      <AcornIcon size={20} />
      <Text
        allowFontScaling={false}
        style={{ fontFamily: F.display, fontSize: 17, color: C.brown, marginLeft: 6, includeFontPadding: false }}
      >
        {amount}
      </Text>
    </View>
  );
}
