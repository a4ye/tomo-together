import React, { useEffect, useState } from 'react';
import { View, ViewStyle } from 'react-native';

// Live ASCII-map pixel sprites — same technique as tools/generate-avatars.js,
// but rendered as Views so features can animate frames without new PNG assets.
// '.' and ' ' are transparent; every other char looks up the palette.

export type PixelMap = { rows: string[]; palette: Record<string, string> };

export function PixelSprite({
  map,
  px = 3,
  style,
}: {
  map: PixelMap;
  px?: number;
  style?: ViewStyle;
}) {
  return (
    <View style={style} pointerEvents="none">
      {map.rows.map((row, y) => (
        <View key={y} style={{ flexDirection: 'row', height: px }}>
          {[...row].map((ch, x) => (
            <View
              key={x}
              style={{
                width: px,
                height: px,
                backgroundColor:
                  ch === '.' || ch === ' ' ? 'transparent' : map.palette[ch],
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

// Chunky 2-frame flicker, steps() feel (no tweening between frames).
export function AnimatedPixelSprite({
  frames,
  px = 3,
  interval = 350,
  style,
}: {
  frames: PixelMap[];
  px?: number;
  interval?: number;
  style?: ViewStyle;
}) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % frames.length), interval);
    return () => clearInterval(t);
  }, [frames.length, interval]);
  return <PixelSprite map={frames[i]} px={px} style={style} />;
}

const INK = '#4A4031';
const FIRE = { R: '#E0475B', O: '#E8A33D', Y: '#F0C93F', K: INK };

// Streak halo flame (sketch 2) — sits behind/above an avatar head.
export const FLAME_FRAMES: PixelMap[] = [
  {
    palette: FIRE,
    rows: [
      '....R.....R...',
      '...RR..R..RR..',
      '..RRR.RRR.RR..',
      '..RORRRORRRO..',
      '.RROORROORRO..',
      '.ROYOROOYORRR.',
      'RROYYOOYYYORR.',
      'ROOYYYOYYYOOR.',
      'ROYYYYYYYYYOR.',
      '.ROYYYYYYYOR..',
    ],
  },
  {
    palette: FIRE,
    rows: [
      '..R.....R.....',
      '..RR.RR.RR.R..',
      '..RRRRR.RRRR..',
      '.RRORRORRORO..',
      '.RROOROORROO..',
      'RROYOOYOYORR..',
      'ROYYYOYYYOORR.',
      'ROYYYYYYYYOOR.',
      '.ROYYYYYYYYOR.',
      '..ROYYYYYYOR..',
    ],
  },
];

// Small tear drops (sketch 1) — overlay near a sad avatar's eyes.
export const TEAR_FRAMES: PixelMap[] = [
  {
    palette: { B: '#4A90D9', W: '#FFFFFF' },
    rows: ['..B.', '.BB.', '.BWB', '..B.'],
  },
  {
    palette: { B: '#4A90D9', W: '#FFFFFF' },
    rows: ['.B..', '.BB.', 'BWB.', '.B..'],
  },
];

// Money bag (sketch 5).
export const MONEYBAG: PixelMap = {
  palette: { K: INK, T: '#C89A62', D: '#8A6B42', Y: '#F0C93F' },
  rows: [
    '....KKKK....',
    '...KTTTTK...',
    '....KDDK....',
    '...KDTTDK...',
    '..KTTTTTTK..',
    '.KTTTTTTTTK.',
    'KTTTYKKYTTTK',
    'KTTTKYYKTTTK',
    'KTTTYKKYTTTK',
    'KTTTKYYKTTTK',
    '.KTTTYYTTTK.',
    '..KKKKKKKK..',
  ],
};

// Campfire (sketch 3) — logs + 2-frame flame.
export const CAMPFIRE_FRAMES: PixelMap[] = [
  {
    palette: { ...FIRE, D: '#8A6B42', L: '#C89058' },
    rows: [
      '......R.......',
      '.....RRR..R...',
      '....RRORR.RR..',
      '....ROYORRRR..',
      '...RROYYOORR..',
      '...ROYYYYORR..',
      '....ROYYYOR...',
      '.....ROYOR....',
      '.DLLLLDDLLLLD.',
      'DLDDDDLLDDDDLD',
      '.DLLLLDDLLLLD.',
    ],
  },
  {
    palette: { ...FIRE, D: '#8A6B42', L: '#C89058' },
    rows: [
      '...R..........',
      '..RRR..RR.....',
      '..RRORRRRR....',
      '..ROYOORRR....',
      '..RROYYOORR...',
      '..ROYYYYYOR...',
      '...ROYYYOR....',
      '....ROYOR.....',
      '.DLLLLDDLLLLD.',
      'DLDDDDLLDDDDLD',
      '.DLLLLDDLLLLD.',
    ],
  },
];

// Determined headband (sketch 5) — overlay across an avatar's forehead,
// knot + tails on the right.
export const HEADBAND: PixelMap = {
  palette: { K: INK, R: '#E0475B' },
  rows: [
    'KKKKKKKKKKKKKK..K.',
    'KRRRRRRRRRRRRKKKRK',
    'KRRRRRRRRRRRRKRKK.',
    'KKKKKKKKKKKKKK.KR.',
    '................K..',
  ],
};
