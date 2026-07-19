import React from 'react';
import { Image, ImageSourcePropType, View } from 'react-native';

// Pixel-art avatars: pre-rendered body sprites (species x color) with aligned
// accessory overlays, all pixelated on the same 36px grid.

export const SPECIES = ['cat', 'bear', 'bunny', 'frog', 'duck'] as const;
export type Species = (typeof SPECIES)[number];

const COLORS = ['#A8D8C8', '#F5B8A0', '#C9B8E8', '#A0C8E8', '#F0D890', '#F0B8D0'];

const BODIES: Record<string, ImageSourcePropType[]> = {
  cat: [
    require('../../assets/avatar/cat_0.png'),
    require('../../assets/avatar/cat_1.png'),
    require('../../assets/avatar/cat_2.png'),
    require('../../assets/avatar/cat_3.png'),
    require('../../assets/avatar/cat_4.png'),
    require('../../assets/avatar/cat_5.png'),
  ],
  bear: [
    require('../../assets/avatar/bear_0.png'),
    require('../../assets/avatar/bear_1.png'),
    require('../../assets/avatar/bear_2.png'),
    require('../../assets/avatar/bear_3.png'),
    require('../../assets/avatar/bear_4.png'),
    require('../../assets/avatar/bear_5.png'),
  ],
  bunny: [
    require('../../assets/avatar/bunny_0.png'),
    require('../../assets/avatar/bunny_1.png'),
    require('../../assets/avatar/bunny_2.png'),
    require('../../assets/avatar/bunny_3.png'),
    require('../../assets/avatar/bunny_4.png'),
    require('../../assets/avatar/bunny_5.png'),
  ],
  frog: [
    require('../../assets/avatar/frog_0.png'),
    require('../../assets/avatar/frog_1.png'),
    require('../../assets/avatar/frog_2.png'),
    require('../../assets/avatar/frog_3.png'),
    require('../../assets/avatar/frog_4.png'),
    require('../../assets/avatar/frog_5.png'),
  ],
  duck: [
    require('../../assets/avatar/duck_0.png'),
    require('../../assets/avatar/duck_1.png'),
    require('../../assets/avatar/duck_2.png'),
    require('../../assets/avatar/duck_3.png'),
    require('../../assets/avatar/duck_4.png'),
    require('../../assets/avatar/duck_5.png'),
  ],
};

const ACCS: Record<string, ImageSourcePropType> = {
  scarf: require('../../assets/avatar/acc_scarf.png'),
  bowtie: require('../../assets/avatar/acc_bowtie.png'),
  bandana: require('../../assets/avatar/acc_bandana.png'),
  bell_collar: require('../../assets/avatar/acc_bell_collar.png'),
  bow_ribbon: require('../../assets/avatar/acc_bow_ribbon.png'),
  round_glasses: require('../../assets/avatar/acc_round_glasses.png'),
  star_glasses: require('../../assets/avatar/acc_star_glasses.png'),
  sunglasses: require('../../assets/avatar/acc_sunglasses.png'),
  monocle: require('../../assets/avatar/acc_monocle.png'),
  eyepatch: require('../../assets/avatar/acc_eyepatch.png'),
  heart_glasses: require('../../assets/avatar/acc_heart_glasses.png'),
  ski_goggles: require('../../assets/avatar/acc_ski_goggles.png'),
  party_hat: require('../../assets/avatar/acc_party_hat.png'),
  beanie: require('../../assets/avatar/acc_beanie.png'),
  flower_crown: require('../../assets/avatar/acc_flower_crown.png'),
  crown: require('../../assets/avatar/acc_crown.png'),
  wizard_hat: require('../../assets/avatar/acc_wizard_hat.png'),
  cowboy_hat: require('../../assets/avatar/acc_cowboy_hat.png'),
  chef_hat: require('../../assets/avatar/acc_chef_hat.png'),
  halo: require('../../assets/avatar/acc_halo.png'),
  cat_ears: require('../../assets/avatar/acc_cat_ears.png'),
  propeller_cap: require('../../assets/avatar/acc_propeller_cap.png'),
  viking_helm: require('../../assets/avatar/acc_viking_helm.png'),
};

// draw order: neck, eyewear, then headwear on top
const ORDER = [
  'scarf', 'bowtie', 'bandana', 'bell_collar', 'bow_ribbon',
  'round_glasses', 'star_glasses', 'sunglasses', 'monocle', 'eyepatch',
  'heart_glasses', 'ski_goggles',
  'party_hat', 'beanie', 'flower_crown', 'crown', 'wizard_hat', 'cowboy_hat',
  'chef_hat', 'halo', 'cat_ears', 'propeller_cap', 'viking_helm',
];

export default function Avatar({
  color,
  species = 'cat',
  equipped = [],
  size = 72,
  happy: _happy = true,
}: {
  color: string;
  species?: string;
  equipped?: string[];
  size?: number;
  happy?: boolean;
}) {
  const ci = Math.max(0, COLORS.indexOf(color));
  const bodies = BODIES[species] ?? BODIES.cat;
  const items = ORDER.filter((i) => equipped.includes(i) && ACCS[i]);
  const layer = { position: 'absolute' as const, width: size, height: size };
  return (
    <View style={{ width: size, height: size }}>
      <Image source={bodies[ci]} style={layer} resizeMode="stretch" />
      {items.map((i) => (
        <Image key={i} source={ACCS[i]} style={layer} resizeMode="stretch" />
      ))}
    </View>
  );
}
