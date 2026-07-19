import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { C, F, doodleCorners } from '../theme';
import OutlinedText from './OutlinedText';
import { useNav } from '../state/nav';

// Screen header: Close button top-left, chunky outlined title.
export default function TopBar({ title }: { title: string }) {
  const nav = useNav();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingTop: 10,
      }}
    >
      <Pressable onPress={nav.back} hitSlop={8}>
        <View
          style={[
            {
              backgroundColor: C.cream,
              borderWidth: 3,
              borderColor: C.brown,
              width: 62,
              height: 62,
              alignItems: 'center',
              justifyContent: 'center',
            },
            doodleCorners(21, 16),
          ]}
        >
          <Text
            allowFontScaling={false}
            style={{ fontFamily: F.display, fontSize: 26, color: C.orange, includeFontPadding: false, lineHeight: 30 }}
          >
            ✕
          </Text>
          <Text
            allowFontScaling={false}
            style={{ fontFamily: F.display, fontSize: 12, color: C.brown, includeFontPadding: false }}
          >
            Close
          </Text>
        </View>
      </Pressable>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
        <OutlinedText size={30} color={C.white} outline={C.darkInk} thickness={2.5}>
          {title}
        </OutlinedText>
      </View>
      <View style={{ width: 62 }} />
    </View>
  );
}
