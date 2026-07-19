import React from 'react';
import Svg, { Circle, Ellipse, G, Path, Rect } from 'react-native-svg';
import { C } from '../theme';

const INK = C.darkInk;

// Accessory art, drawn on the same 100x100 canvas as the blob body.
function ItemArt({ id }: { id: string }) {
  switch (id) {
    case 'party_hat':
      return (
        <G>
          <Path d="M38 18 L50 -6 L62 18 Z" fill="#F0A8C0" stroke={INK} strokeWidth={3.5} strokeLinejoin="round" />
          <Circle cx={50} cy={-7} r={4.5} fill={C.yellow} stroke={INK} strokeWidth={3} />
        </G>
      );
    case 'beanie':
      return (
        <G>
          <Path d="M30 20 C32 4 68 4 70 20 L70 24 L30 24 Z" fill="#7FA8D8" stroke={INK} strokeWidth={3.5} strokeLinejoin="round" />
          <Circle cx={50} cy={4} r={5} fill="#F6E4BC" stroke={INK} strokeWidth={3} />
        </G>
      );
    case 'flower_crown':
      return (
        <G>
          {[
            [36, 16], [50, 11], [64, 16],
          ].map(([x, y], i) => (
            <G key={i}>
              <Circle cx={x - 4} cy={y} r={3.4} fill="#F0A8C0" stroke={INK} strokeWidth={2} />
              <Circle cx={x + 4} cy={y} r={3.4} fill="#F0A8C0" stroke={INK} strokeWidth={2} />
              <Circle cx={x} cy={y - 4} r={3.4} fill="#F0A8C0" stroke={INK} strokeWidth={2} />
              <Circle cx={x} cy={y} r={2.6} fill={C.yellow} stroke={INK} strokeWidth={2} />
            </G>
          ))}
        </G>
      );
    case 'crown':
      return (
        <Path d="M34 20 L34 6 L42 13 L50 2 L58 13 L66 6 L66 20 Z"
          fill={C.yellow} stroke={INK} strokeWidth={3.5} strokeLinejoin="round" />
      );
    case 'round_glasses':
      return (
        <G>
          <Circle cx={39} cy={45} r={8.5} fill="none" stroke={INK} strokeWidth={3.5} />
          <Circle cx={61} cy={45} r={8.5} fill="none" stroke={INK} strokeWidth={3.5} />
          <Path d="M47.5 45 L52.5 45" stroke={INK} strokeWidth={3.5} />
        </G>
      );
    case 'star_glasses':
      return (
        <G>
          {[39, 61].map((cx) => (
            <Path
              key={cx}
              d={`M${cx} 36 L${cx + 2.8} 42 L${cx + 9} 42.8 L${cx + 4.4} 47 L${cx + 5.6} 53 L${cx} 50
                  L${cx - 5.6} 53 L${cx - 4.4} 47 L${cx - 9} 42.8 L${cx - 2.8} 42 Z`}
              fill="#F0C93F" stroke={INK} strokeWidth={2.5} strokeLinejoin="round"
            />
          ))}
          <Path d="M46 45 L54 45" stroke={INK} strokeWidth={3} />
        </G>
      );
    case 'sunglasses':
      return (
        <G>
          <Rect x={30} y={39} width={17} height={11} rx={4} fill={INK} />
          <Rect x={53} y={39} width={17} height={11} rx={4} fill={INK} />
          <Path d="M47 43 L53 43" stroke={INK} strokeWidth={3.5} />
        </G>
      );
    case 'scarf':
      return (
        <G>
          <Path d="M28 72 C36 80 64 80 72 72 L72 80 C64 88 36 88 28 80 Z"
            fill="#E08A5A" stroke={INK} strokeWidth={3.5} strokeLinejoin="round" />
          <Path d="M58 82 L60 96 L50 96 L52 83" fill="#E08A5A" stroke={INK} strokeWidth={3} strokeLinejoin="round" />
        </G>
      );
    case 'bowtie':
      return (
        <G>
          <Path d="M50 78 L36 71 L36 85 Z" fill="#D86A6A" stroke={INK} strokeWidth={3} strokeLinejoin="round" />
          <Path d="M50 78 L64 71 L64 85 Z" fill="#D86A6A" stroke={INK} strokeWidth={3} strokeLinejoin="round" />
          <Circle cx={50} cy={78} r={4} fill="#F6E4BC" stroke={INK} strokeWidth={2.5} />
        </G>
      );
    default:
      return null;
  }
}

const ORDER = ['scarf', 'bowtie', 'round_glasses', 'star_glasses', 'sunglasses',
  'party_hat', 'beanie', 'flower_crown', 'crown'];

export default function Avatar({
  color,
  equipped = [],
  size = 72,
  happy = true,
}: {
  color: string;
  equipped?: string[];
  size?: number;
  happy?: boolean;
}) {
  const items = ORDER.filter((i) => equipped.includes(i));
  const hasEyewear = items.some((i) => ['round_glasses', 'star_glasses', 'sunglasses'].includes(i));
  return (
    <Svg width={size} height={size} viewBox="-8 -12 116 116">
      <Path
        d="M50 12 C74 12 84 32 84 54 C84 78 72 92 50 92 C28 92 16 78 16 54 C16 32 26 12 50 12 Z"
        fill={color}
        stroke={INK}
        strokeWidth={4}
        strokeLinejoin="round"
      />
      <Ellipse cx={38} cy={91} rx={7} ry={4} fill={color} stroke={INK} strokeWidth={3.5} />
      <Ellipse cx={62} cy={91} rx={7} ry={4} fill={color} stroke={INK} strokeWidth={3.5} />
      {!hasEyewear && (
        <G>
          <Circle cx={39} cy={45} r={3.6} fill={INK} />
          <Circle cx={61} cy={45} r={3.6} fill={INK} />
        </G>
      )}
      {items.includes('sunglasses') ? null : hasEyewear ? (
        <G>
          <Circle cx={39} cy={45} r={2.6} fill={INK} />
          <Circle cx={61} cy={45} r={2.6} fill={INK} />
        </G>
      ) : null}
      {happy ? (
        <Path d="M44 56 C47 60 53 60 56 56" fill="none" stroke={INK} strokeWidth={3.5} strokeLinecap="round" />
      ) : (
        <Path d="M45 58 L55 58" fill="none" stroke={INK} strokeWidth={3.5} strokeLinecap="round" />
      )}
      <Circle cx={31} cy={54} r={4.5} fill="#F2A7B3" opacity={0.75} />
      <Circle cx={69} cy={54} r={4.5} fill="#F2A7B3" opacity={0.75} />
      {items.map((i) => <ItemArt key={i} id={i} />)}
    </Svg>
  );
}
