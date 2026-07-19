import React, { useMemo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';
import { wob } from '../theme';

function Acorn({ color, bg }: { color: string; bg: string }) {
  return (
    <G>
      <Path d="M-7 2 C-7 10 -3 15 0 15 C3 15 7 10 7 2 Z" fill={color} />
      <Path d="M-8.5 3 C-8.5 -4 8.5 -4 8.5 3 Z" fill={color} />
      <Path d="M-8.5 3 L8.5 3" stroke={bg} strokeWidth={1.6} />
      <Path d="M0 -3 C-0.5 -6 1 -8 3.5 -8.5" stroke={color} strokeWidth={2.2} fill="none" strokeLinecap="round" />
    </G>
  );
}

function Leaf({ color, bg }: { color: string; bg: string }) {
  return (
    <G>
      <Path d="M0 -12 C6.5 -6 6.5 6 0 14 C-6.5 6 -6.5 -6 0 -12 Z" fill={color} />
      <Path d="M0 -9 L0 11" stroke={bg} strokeWidth={1.4} />
      <Path d="M0 14 L0 19" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    </G>
  );
}

// Scattered acorns and oak leaves, flat silhouettes in the page tint.
export default function YardBackground({ bg, tint, seed = 3 }: { bg: string; tint: string; seed?: number }) {
  const { width, height } = useWindowDimensions();
  const items = useMemo(() => {
    const out = [];
    const cols = 4;
    const rows = Math.ceil(height / (width / cols));
    let i = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        i++;
        if (wob(seed * 100 + i) < 0.5) continue; // sparse scatter
        const cell = width / cols;
        out.push({
          x: c * cell + cell * (0.25 + wob(seed + i * 3) * 0.5),
          y: r * cell + cell * (0.2 + wob(seed + i * 5) * 0.6),
          s: 0.8 + wob(seed + i * 7) * 0.7,
          rot: (wob(seed + i * 11) * 2 - 1) * 40,
          leaf: wob(seed + i * 13) < 0.55,
        });
      }
    }
    return out;
  }, [width, height, seed]);

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: bg }]} pointerEvents="none">
      <Svg width={width} height={height}>
        {items.map((p, i) => (
          <G key={i} transform={`translate(${p.x} ${p.y}) rotate(${p.rot}) scale(${p.s})`}>
            {p.leaf ? <Leaf color={tint} bg={bg} /> : <Acorn color={tint} bg={bg} />}
          </G>
        ))}
      </Svg>
    </View>
  );
}
