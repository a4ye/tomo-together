import React, { useMemo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Ellipse, G, Path, Rect } from 'react-native-svg';
import { C, wob } from '../theme';

const INK = C.darkInk;
const GRASS_DARK = '#9FC262';

function Sun() {
  return (
    <G>
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2;
        return (
          <Path
            key={i}
            d={`M${Math.cos(a) * 26} ${Math.sin(a) * 26} L${Math.cos(a) * 36} ${Math.sin(a) * 36}`}
            stroke="#E8B33C" strokeWidth={4.5} strokeLinecap="round"
          />
        );
      })}
      <Circle r={22} fill="#F7DC6F" stroke={INK} strokeWidth={3} />
    </G>
  );
}

function Cloud({ s = 1 }: { s?: number }) {
  return (
    <G scale={s}>
      <Ellipse cx={-18} cy={4} rx={18} ry={12} fill="#FDF6E3" stroke={INK} strokeWidth={3} />
      <Ellipse cx={18} cy={5} rx={16} ry={11} fill="#FDF6E3" stroke={INK} strokeWidth={3} />
      <Ellipse cx={0} cy={-4} rx={20} ry={14} fill="#FDF6E3" stroke={INK} strokeWidth={3} />
      <Path d="M-30 12 C-10 18 10 18 30 12" fill="#FDF6E3" />
    </G>
  );
}

function Tree({ s = 1 }: { s?: number }) {
  return (
    <G scale={s}>
      <Path d="M-3 46 L-3 12 C-10 5 -12 -2 -8 -4 C-12 -10 -6 -16 -1 -13 C-2 -22 10 -24 12 -16 C20 -17 22 -8 16 -4 C22 0 18 8 5 12 L5 46 Z"
        fill="#8A6B42" stroke={INK} strokeWidth={3} strokeLinejoin="round" />
      <Circle cx={-12} cy={-12} r={17} fill="#9CC46B" stroke={INK} strokeWidth={3} />
      <Circle cx={10} cy={-22} r={19} fill="#AACF78" stroke={INK} strokeWidth={3} />
      <Circle cx={20} cy={-4} r={14} fill="#9CC46B" stroke={INK} strokeWidth={3} />
      <Circle cx={2} cy={-30} r={3} fill="#E8A33D" />
      <Circle cx={18} cy={-16} r={3} fill="#E8A33D" />
    </G>
  );
}

function Bush({ s = 1 }: { s?: number }) {
  return (
    <G scale={s}>
      <Circle cx={-14} cy={2} r={13} fill="#A8CF78" stroke={INK} strokeWidth={3} />
      <Circle cx={12} cy={3} r={11} fill="#A8CF78" stroke={INK} strokeWidth={3} />
      <Circle cx={0} cy={-6} r={14} fill="#B5D687" stroke={INK} strokeWidth={3} />
      <Circle cx={-4} cy={-8} r={2.4} fill="#F09CB5" />
      <Circle cx={7} cy={-1} r={2.4} fill="#F09CB5" />
    </G>
  );
}

function Blanket({ s = 1 }: { s?: number }) {
  return (
    <G scale={s} rotation={-4}>
      <Rect x={-46} y={-28} width={92} height={56} rx={8} fill="#F3E0E4" stroke={INK} strokeWidth={3} />
      {[-32, -10, 12, 34].map((x) => (
        <Rect key={x} x={x} y={-25} width={9} height={50} fill="#E9B8C4" opacity={0.8} />
      ))}
      {[-16, 6].map((y) => (
        <Rect key={y} x={-43} y={y} width={86} height={8} fill="#E9B8C4" opacity={0.6} />
      ))}
    </G>
  );
}

function Pond({ s = 1 }: { s?: number }) {
  return (
    <G scale={s}>
      <Ellipse rx={54} ry={30} fill="#A9D3E5" stroke={INK} strokeWidth={3} />
      <Ellipse cx={-8} cy={-6} rx={30} ry={14} fill="#C4E3EF" />
      <Ellipse cx={26} cy={8} rx={11} ry={7} fill="#8FBF64" stroke={INK} strokeWidth={2.5} />
      <Path d="M26 8 L38 4" stroke={INK} strokeWidth={2} />
    </G>
  );
}

function Stone({ s = 1 }: { s?: number }) {
  return (
    <G scale={s}>
      <Ellipse rx={15} ry={9} fill="#E3D9BF" stroke={INK} strokeWidth={2.5} />
      <Ellipse cx={-3} cy={-2} rx={7} ry={3} fill="#EFE8D8" />
    </G>
  );
}

function Tuft({ s = 1 }: { s?: number }) {
  return (
    <G scale={s}>
      <Path d="M-6 0 C-7 -6 -9 -9 -11 -10 M0 0 C0 -8 -1 -12 -2 -14 M6 0 C7 -6 9 -9 11 -10"
        stroke={GRASS_DARK} strokeWidth={3} strokeLinecap="round" fill="none" />
    </G>
  );
}

function Daisy({ s = 1 }: { s?: number }) {
  return (
    <G scale={s}>
      {Array.from({ length: 5 }, (_, i) => {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        return <Circle key={i} cx={Math.cos(a) * 6} cy={Math.sin(a) * 6} r={4.6} fill={C.white} stroke={INK} strokeWidth={1.8} />;
      })}
      <Circle r={4} fill={C.yellow} stroke={INK} strokeWidth={1.8} />
    </G>
  );
}

function Tulip({ s = 1 }: { s?: number }) {
  return (
    <G scale={s}>
      <Path d="M0 2 L0 14" stroke={GRASS_DARK} strokeWidth={2.5} strokeLinecap="round" />
      <Path d="M-6 -8 C-6 -14 6 -14 6 -8 L6 -2 C6 3 -6 3 -6 -2 Z M-6 -8 L-2 -4 L0 -9 L2 -4 L6 -8"
        fill="#F09CB5" stroke={INK} strokeWidth={2.2} strokeLinejoin="round" />
    </G>
  );
}

function Butterfly({ s = 1 }: { s?: number }) {
  return (
    <G scale={s} rotation={-12}>
      <Ellipse cx={-6} cy={-2} rx={6} ry={8} fill="#F0C93F" stroke={INK} strokeWidth={2} />
      <Ellipse cx={6} cy={-2} rx={6} ry={8} fill="#F0C93F" stroke={INK} strokeWidth={2} />
      <Path d="M0 -10 L0 8" stroke={INK} strokeWidth={2.5} strokeLinecap="round" />
      <Path d="M-1 -10 C-4 -14 -6 -15 -7 -16 M1 -10 C4 -14 6 -15 7 -16" stroke={INK} strokeWidth={1.8} fill="none" strokeLinecap="round" />
    </G>
  );
}

// The decorated yard: sky above the hill crest at 38% height, grass below.
export default function YardScene() {
  const { width: w, height: h } = useWindowDimensions();

  const tufts = useMemo(
    () =>
      Array.from({ length: 9 }, (_, i) => ({
        x: (0.06 + wob(i * 7 + 1) * 0.88) * w,
        y: (0.46 + wob(i * 13 + 4) * 0.46) * h,
        s: 0.8 + wob(i * 3) * 0.5,
      })),
    [w, h]
  );
  const daisies = useMemo(
    () =>
      // kept to the left half so they never sprout through the blanket
      Array.from({ length: 4 }, (_, i) => ({
        x: (0.08 + wob(i * 17 + 8) * 0.42) * w,
        y: (0.5 + wob(i * 23 + 2) * 0.4) * h,
        s: 0.85 + wob(i * 5) * 0.4,
      })),
    [w, h]
  );

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg width={w} height={h}>
        {/* sky */}
        <G x={0.10 * w} y={0.245 * h}><Cloud s={0.9} /></G>
        <G x={0.46 * w} y={0.225 * h}><Cloud s={0.7} /></G>
        <G x={0.66 * w} y={0.27 * h}><Sun /></G>

        {/* hill crest, tucked behind the grass edge */}
        <G x={0.15 * w} y={0.385 * h}><Tree s={1.1} /></G>
        <G x={0.84 * w} y={0.315 * h}><Tree s={1.5} /></G>
        <G x={0.38 * w} y={0.372 * h}><Bush s={1.1} /></G>
        <G x={0.62 * w} y={0.385 * h}><Bush s={0.9} /></G>

        {/* on the grass */}
        <G x={0.47 * w} y={0.50 * h}><Stone /></G>
        <G x={0.55 * w} y={0.57 * h}><Stone s={0.85} /></G>
        <G x={0.49 * w} y={0.64 * h}><Stone s={0.75} /></G>
        <G x={0.70 * w} y={0.74 * h}><Blanket s={1.25} /></G>
        <G x={0.17 * w} y={0.85 * h}><Pond s={1.1} /></G>
        {tufts.map((t, i) => (
          <G key={`t${i}`} x={t.x} y={t.y}><Tuft s={t.s} /></G>
        ))}
        {daisies.map((d, i) => (
          <G key={`d${i}`} x={d.x} y={d.y}><Daisy s={d.s} /></G>
        ))}
        <G x={0.86 * w} y={0.56 * h}><Tulip s={1.1} /></G>
        <G x={0.08 * w} y={0.62 * h}><Tulip s={0.9} /></G>
        <G x={0.78 * w} y={0.445 * h}><Butterfly /></G>
      </Svg>
    </View>
  );
}
