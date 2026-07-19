import React from 'react';
import Svg, { Circle, Ellipse, G, Path, Rect } from 'react-native-svg';
import { C } from '../theme';

const INK = C.darkInk;

// Shared eye positions — used by the eyes themselves below and by the
// eyewear accessories here, so glasses always line up with the eyes.
const EYE_L = 34;
const EYE_R = 66;
const EYE_Y = 50;
const BLUSH_L = 22;
const BLUSH_R = 78;

// A pupil with a small sparkle highlight instead of a white eye-backing.
function EyeDot({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  return (
    <G>
      <Circle cx={cx} cy={cy} r={r} fill={INK} />
      <Circle cx={cx - r * 0.38} cy={cy - r * 0.38} r={r * 0.34} fill="#FFFFFF" />
    </G>
  );
}

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
          <Circle cx={EYE_L} cy={EYE_Y} r={8.5} fill="none" stroke={INK} strokeWidth={3.5} />
          <Circle cx={EYE_R} cy={EYE_Y} r={8.5} fill="none" stroke={INK} strokeWidth={3.5} />
          <Path d={`M${EYE_L + 8.5} ${EYE_Y} L${EYE_R - 8.5} ${EYE_Y}`} stroke={INK} strokeWidth={3.5} />
        </G>
      );
    case 'star_glasses':
      return (
        <G>
          {[EYE_L, EYE_R].map((cx) => (
            <Path
              key={cx}
              d={`M${cx} 36 L${cx + 2.8} 42 L${cx + 9} 42.8 L${cx + 4.4} 47 L${cx + 5.6} 53 L${cx} 50
                  L${cx - 5.6} 53 L${cx - 4.4} 47 L${cx - 9} 42.8 L${cx - 2.8} 42 Z`}
              fill="#F0C93F" stroke={INK} strokeWidth={2.5} strokeLinejoin="round"
            />
          ))}
          <Path d={`M${EYE_L + 7} ${EYE_Y} L${EYE_R - 7} ${EYE_Y}`} stroke={INK} strokeWidth={3} />
        </G>
      );
    case 'sunglasses':
      return (
        <G>
          <Rect x={EYE_L - 8.5} y={39} width={17} height={11} rx={4} fill={INK} />
          <Rect x={EYE_R - 8.5} y={39} width={17} height={11} rx={4} fill={INK} />
          <Path d={`M${EYE_L + 8} 43 L${EYE_R - 8} 43`} stroke={INK} strokeWidth={3.5} />
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

const BODY_PATH = 'M50 12 C74 12 84 32 84 54 C84 78 72 92 50 92 C28 92 16 78 16 54 C16 32 26 12 50 12 Z';

// Wide, flat-ish head for mascots — closer to a sticker-style cat-face icon
// than the legacy egg body (which stays as-is above, paws and all).
const MASCOT_HEAD_PATH = 'M50 14 C76 14 92 30 94 50 C96 72 78 90 50 90 C22 90 4 72 6 50 C8 30 24 14 50 14 Z';

// Mascot presets. `color` on the account is either a legacy hex blob color
// (still fully supported below) or one of these preset ids. Add more here
// to add more mascots — nothing else needs to change.
type MascotPreset = {
  base: string;
  earInner: string;
  muzzle: string;
  whisker?: string; // defaults to INK; dark-furred mascots need a lighter tone
  pattern?: 'tabby';
  patternColor?: string;
  earShape?: 'cat' | 'bunny' | 'bear'; // defaults to 'cat'
  whiskers?: boolean; // defaults to true
};

const MASCOTS: Record<string, MascotPreset> = {
  kitty_cream: { base: '#F6E9D0', earInner: '#F0B8C8', muzzle: '#FFF8EC' },
  kitty_tabby: {
    base: '#C7B79C', earInner: '#F0B8C8', muzzle: '#EFE2C8',
    pattern: 'tabby', patternColor: '#8B7355',
  },
  cat_black: {
    base: '#5A5C61', earInner: '#8A6570', muzzle: '#8B8D92',
    whisker: '#E8E7E5',
  },
  cat_orange: {
    base: '#E8A33D', earInner: '#F6CFA0', muzzle: '#F8E7C6',
    pattern: 'tabby', patternColor: '#C77F22',
  },
  bunny: {
    base: '#F8F1E6', earInner: '#F0B8C8', muzzle: '#FFFFFF',
    earShape: 'bunny', whiskers: false,
  },
  bear: {
    base: '#C89968', earInner: '#8A6042', muzzle: '#F3E0C4',
    earShape: 'bear', whiskers: false,
  },
};
const DEFAULT_MASCOT = 'kitty_cream';

function isHexColor(s: string) {
  return s.startsWith('#');
}

// Simple triangular ears, drawn behind the head so the silhouette covers
// their base — clean points (rounded only at the tip/joins), matching a
// classic cat-face icon.
function CatEars({ base, inner }: { base: string; inner: string }) {
  return (
    <G>
      <Path
        d="M4 42 L13 3 L36 30 Z"
        fill={base} stroke={INK} strokeWidth={4} strokeLinejoin="round"
      />
      <Path
        d="M96 42 L87 3 L64 30 Z"
        fill={base} stroke={INK} strokeWidth={4} strokeLinejoin="round"
      />
      <Path d="M12 33 L18 12 L32 28 Z" fill={inner} />
      <Path d="M88 33 L82 12 L68 28 Z" fill={inner} />
    </G>
  );
}

// Tall, upright bunny ears — same behind-the-head layering as CatEars.
function BunnyEars({ base, inner }: { base: string; inner: string }) {
  return (
    <G>
      <Path
        d="M10 34 Q4 10 9 -10 Q18 8 22 24 Q17 32 10 34 Z"
        fill={base} stroke={INK} strokeWidth={4} strokeLinejoin="round"
      />
      <Path
        d="M90 34 Q96 10 91 -10 Q82 8 78 24 Q83 32 90 34 Z"
        fill={base} stroke={INK} strokeWidth={4} strokeLinejoin="round"
      />
      <Path d="M13 28 Q9 12 12 -2 Q17 10 19 20 Q16 25 13 28 Z" fill={inner} />
      <Path d="M87 28 Q91 12 88 -2 Q83 10 81 20 Q84 25 87 28 Z" fill={inner} />
    </G>
  );
}

// Small semicircle bear ears, slanted so the base runs diagonally down
// into the head silhouette (like the cat/bunny ears) instead of floating
// beside it on a level line.
function BearEars({ base, inner }: { base: string; inner: string }) {
  return (
    <G>
      <Path d="M6 34 A18 18 0 0 1 34 16 Z" fill={base} stroke={INK} strokeWidth={4} strokeLinejoin="round" />
      <Path d="M94 34 A18 18 0 0 0 66 16 Z" fill={base} stroke={INK} strokeWidth={4} strokeLinejoin="round" />
      <Path d="M11 29 A11 11 0 0 1 29 18 Z" fill={inner} />
      <Path d="M89 29 A11 11 0 0 0 71 18 Z" fill={inner} />
    </G>
  );
}

function TabbyStripes({ color }: { color: string }) {
  return (
    <G stroke={color} strokeWidth={3} fill="none" strokeLinecap="round">
      <Path d="M35 28 Q39 20 45 25" />
      <Path d="M50 26 L50 17" />
      <Path d="M65 28 Q61 20 55 25" />
    </G>
  );
}

// No nose — just a small "w" mouth, cat-icon style, roughly at eye level.
function CatMouth({ happy }: { happy: boolean }) {
  return happy ? (
    <Path
      d="M44.5 53.5 Q47.5 57 50 53.8 Q52.5 57 55.5 53.5"
      fill="none" stroke={INK} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round"
    />
  ) : (
    <Path d="M45 55.5 Q50 58 55 55.5" fill="none" stroke={INK} strokeWidth={2.6} strokeLinecap="round" />
  );
}

function CatFace({
  muzzle, whisker, happy, whiskers = true,
}: {
  muzzle: string; whisker: string; happy: boolean; whiskers?: boolean;
}) {
  return (
    <G>
      <Ellipse cx={50} cy={61} rx={17} ry={11} fill={muzzle} />
      <CatMouth happy={happy} />
      {whiskers && (
        <G stroke={whisker} strokeWidth={2} strokeLinecap="round">
          <Path d="M4 55 Q9.5 56 15 57" />
          <Path d="M4 60 Q9.5 60.5 15 59" />
          <Path d="M96 55 Q90.5 56 85 57" />
          <Path d="M96 60 Q90.5 60.5 85 59" />
        </G>
      )}
    </G>
  );
}

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

  const legacy = isHexColor(color);
  const mascot = legacy ? null : (MASCOTS[color] ?? MASCOTS[DEFAULT_MASCOT]);
  const bodyFill = legacy ? color : mascot!.base;

  return (
    <Svg width={size} height={size} viewBox="-8 -12 116 116">
      {mascot && (
        mascot.earShape === 'bunny' ? <BunnyEars base={bodyFill} inner={mascot.earInner} />
        : mascot.earShape === 'bear' ? <BearEars base={bodyFill} inner={mascot.earInner} />
        : <CatEars base={bodyFill} inner={mascot.earInner} />
      )}
      <Path
        d={mascot ? MASCOT_HEAD_PATH : BODY_PATH}
        fill={bodyFill}
        stroke={INK}
        strokeWidth={4}
        strokeLinejoin="round"
      />
      {!mascot && (
        <G>
          <Ellipse cx={38} cy={91} rx={7} ry={4} fill={bodyFill} stroke={INK} strokeWidth={3.5} />
          <Ellipse cx={62} cy={91} rx={7} ry={4} fill={bodyFill} stroke={INK} strokeWidth={3.5} />
        </G>
      )}
      {mascot?.pattern === 'tabby' && <TabbyStripes color={mascot.patternColor!} />}
      {mascot && (
        <CatFace
          muzzle={mascot.muzzle} whisker={mascot.whisker ?? INK} happy={happy}
          whiskers={mascot.whiskers ?? true}
        />
      )}
      {!hasEyewear && (
        <G>
          <EyeDot cx={EYE_L} cy={EYE_Y} r={4.5} />
          <EyeDot cx={EYE_R} cy={EYE_Y} r={4.5} />
        </G>
      )}
      {items.includes('sunglasses') ? null : hasEyewear ? (
        <G>
          <EyeDot cx={EYE_L} cy={EYE_Y} r={2.6} />
          <EyeDot cx={EYE_R} cy={EYE_Y} r={2.6} />
        </G>
      ) : null}
      {!mascot && (happy ? (
        <Path d="M44 56 C47 60 53 60 56 56" fill="none" stroke={INK} strokeWidth={3.5} strokeLinecap="round" />
      ) : (
        <Path d="M45 58 L55 58" fill="none" stroke={INK} strokeWidth={3.5} strokeLinecap="round" />
      ))}
      <Circle cx={BLUSH_L} cy={EYE_Y + 7} r={4.5} fill="#F2A7B3" opacity={0.75} />
      <Circle cx={BLUSH_R} cy={EYE_Y + 7} r={4.5} fill="#F2A7B3" opacity={0.75} />
      {items.map((i) => <ItemArt key={i} id={i} />)}
    </Svg>
  );
}
