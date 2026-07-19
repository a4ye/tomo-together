import React from 'react';
import { Text, TextStyle, View, ViewStyle } from 'react-native';
import { C, F } from '../theme';

type Props = {
  children: React.ReactNode;
  size?: number;
  color?: string;
  outline?: string;
  font?: string;
  thickness?: number;
  style?: ViewStyle;
  textAlign?: TextStyle['textAlign'];
};

// Neko Atsume-style chunky lettering: RN has no text stroke, so we stack
// offset copies of the text behind the fill to fake a hand-inked outline.
export default function OutlinedText({
  children,
  size = 26,
  color = C.white,
  outline = C.darkInk,
  font = F.display,
  thickness = 2,
  style,
  textAlign,
}: Props) {
  const t = thickness;
  const offsets: [number, number][] = [
    [-t, 0], [t, 0], [0, -t], [0, t],
    [-t, -t], [t, -t], [-t, t], [t, t],
  ];
  const base: TextStyle = {
    fontFamily: font,
    fontSize: size,
    lineHeight: size * 1.35,
    textAlign,
    includeFontPadding: false,
  };
  return (
    <View style={style}>
      {offsets.map(([x, y], i) => (
        <Text
          key={i}
          allowFontScaling={false}
          style={[base, { color: outline, position: 'absolute', left: x, top: y, right: -x }]}
        >
          {children}
        </Text>
      ))}
      <Text allowFontScaling={false} style={[base, { color }]}>
        {children}
      </Text>
    </View>
  );
}
