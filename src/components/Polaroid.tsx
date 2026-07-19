import React from 'react';
import { Image, Text, View, ViewStyle } from 'react-native';
import { C, F, PIN_COLORS, doodleTilt, wob } from '../theme';

// Album-style pinned polaroid: white frame, colored pin on a little stem, slight tilt.
export default function Polaroid({
  photoUri,
  placeholder,
  caption,
  seed = 1,
  width = 150,
  style,
}: {
  photoUri?: string;
  placeholder?: React.ReactNode;
  caption?: string;
  seed?: number;
  width?: number | '100%';
  style?: ViewStyle;
}) {
  const pin = PIN_COLORS[Math.floor(wob(seed * 13) * PIN_COLORS.length)];
  return (
    <View style={[{ alignItems: 'center' }, style]}>
      {/* pin + stem */}
      <View style={{ alignItems: 'center', zIndex: 2 }}>
        <View
          style={{
            width: 15, height: 15, borderRadius: 8,
            backgroundColor: pin, borderWidth: 2.5, borderColor: C.darkInk,
          }}
        />
        <View style={{ width: 3, height: 9, backgroundColor: C.darkInk, marginTop: -1 }} />
      </View>
      <View
        style={[
          {
            width,
            backgroundColor: C.white,
            borderWidth: 2.5,
            borderColor: C.darkInk,
            borderRadius: 4,
            padding: 8,
            paddingBottom: caption ? 6 : 20,
            marginTop: -3,
          },
          doodleTilt(seed, 2.5),
        ]}
      >
        <View
          style={{
            width: '100%',
            alignSelf: 'center',
            aspectRatio: 4 / 3,
            backgroundColor: '#EFE8D8',
            overflow: 'hidden',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {photoUri ? (
            <Image source={{ uri: photoUri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
          ) : (
            placeholder ?? (
              <Text style={{ fontFamily: F.body, fontSize: 13, color: C.fadedInk }}>No photo yet</Text>
            )
          )}
        </View>
        {caption ? (
          <Text
            numberOfLines={1}
            allowFontScaling={false}
            style={{
              fontFamily: F.body, fontSize: 12, color: C.darkInk,
              textAlign: 'center', marginTop: 5, includeFontPadding: false,
            }}
          >
            {caption}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
