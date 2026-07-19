import React from 'react';
import { Text, View, ViewStyle } from 'react-native';
import { C, F } from '../theme';
import { TitleKind } from '../types';

// Colour per friend title kind. Muted fill + darker text so it reads as a chip.
const STYLES: Record<TitleKind, { bg: string; fg: string }> = {
  stale: { bg: '#F6D2D6', fg: C.redPin },
  streak: { bg: '#F8E0B8', fg: C.orange },
  best: { bg: '#F7D6E4', fg: C.labelPink },
  new: { bg: '#DDEBC2', fg: C.labelGreen },
  close: { bg: '#CFE2F5', fg: C.labelBlue },
  friend: { bg: '#EFE3C8', fg: C.brown },
};

export default function TitleBadge({
  title, kind, style,
}: {
  title: string; kind: TitleKind; style?: ViewStyle;
}) {
  const s = STYLES[kind] ?? STYLES.friend;
  return (
    <View
      style={[
        {
          alignSelf: 'flex-start',
          backgroundColor: s.bg,
          borderColor: s.fg,
          borderWidth: 2,
          borderRadius: 5,
          paddingHorizontal: 7,
          paddingVertical: 2,
        },
        style,
      ]}
    >
      <Text
        allowFontScaling={false}
        style={{ fontFamily: F.display, fontSize: 11, color: s.fg, includeFontPadding: false }}
      >
        {title}
      </Text>
    </View>
  );
}
