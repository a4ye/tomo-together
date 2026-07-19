import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Image, PanResponder, Pressable, Text, useWindowDimensions, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Avatar from '../components/Avatar';
import OutlinedText from '../components/OutlinedText';
import { BTN_CREAM, NineSliceBg } from '../components/PixelUI';
import { useNav } from '../state/nav';
import { useSession } from '../state/session';
import { C, F, wob } from '../theme';
import { useWorldSocket } from '../worldSocket';

const AVATAR_R = 40;
const SPEED = 7.5;        // px per tick
const TICK_MS = 33;       // ~30fps
const JOY_R = 58;
const THUMB_R = 28;

const W = {
  tree: require('../../assets/world/treeBig.png'),
  treeHeart: require('../../assets/world/treeHeart.png'),
  hedge: require('../../assets/world/hedgeBig.png'),
  bush: require('../../assets/world/bushBerry.png'),
  pond: require('../../assets/world/pond.png'),
  sunflower: require('../../assets/world/sunflower.png'),
  mushroomsPink: require('../../assets/world/mushroomsPink.png'),
  mushroomPurple: require('../../assets/world/mushroomPurple.png'),
  rockBig: require('../../assets/world/rockBig.png'),
  log: require('../../assets/world/log.png'),
  flowerYellow: require('../../assets/world/flowerYellow.png'),
  fenceH: require('../../assets/world/fenceH.png'),
  decal1: require('../../assets/world/decal1.png'),
  decal2: require('../../assets/world/decal2.png'),
  decal3: require('../../assets/world/decal3.png'),
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function Sprite({ src, x, y, w, h, flip }: { src: any; x: number; y: number; w: number; h: number; flip?: boolean }) {
  return (
    <Image
      source={src}
      style={{
        position: 'absolute', left: x - w / 2, top: y - h / 2, width: w, height: h,
        transform: flip ? [{ scaleX: -1 }] : undefined,
      }}
      resizeMode="stretch"
    />
  );
}

export default function WorldScreen() {
  const { serverUrl, token, me } = useSession();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const { width: sw, height: sh } = useWindowDimensions();
  const { world, me: myUsername, players, connected, sendMove } = useWorldSocket(serverUrl, token);

  const [myPos, setMyPos] = useState({ x: 0, y: 0 });
  const [thumb, setThumb] = useState({ x: 0, y: 0 });
  const vec = useRef({ x: 0, y: 0 });
  const seeded = useRef(false);

  // seed my position from the saved spot the server sent on init
  useEffect(() => {
    if (seeded.current || !world || !myUsername) return;
    const mine = players[myUsername];
    if (mine) { setMyPos({ x: mine.x, y: mine.y }); seeded.current = true; }
  }, [world, myUsername, players]);

  // movement loop: joystick vector -> position, clamped to the world, throttled send
  useEffect(() => {
    if (!world) return;
    const id = setInterval(() => {
      const v = vec.current;
      if (v.x === 0 && v.y === 0) return;
      setMyPos((p) => {
        const nx = clamp(p.x + v.x * SPEED, AVATAR_R, world.w - AVATAR_R);
        const ny = clamp(p.y + v.y * SPEED, AVATAR_R, world.h - AVATAR_R);
        sendMove(nx, ny);
        return { x: nx, y: ny };
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [world, sendMove]);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (_e, g) => {
        let dx = g.dx, dy = g.dy;
        const d = Math.hypot(dx, dy);
        if (d > JOY_R) { dx = (dx / d) * JOY_R; dy = (dy / d) * JOY_R; }
        vec.current = { x: dx / JOY_R, y: dy / JOY_R };
        setThumb({ x: dx, y: dy });
      },
      onPanResponderRelease: () => { vec.current = { x: 0, y: 0 }; setThumb({ x: 0, y: 0 }); },
      onPanResponderTerminate: () => { vec.current = { x: 0, y: 0 }; setThumb({ x: 0, y: 0 }); },
    })
  ).current;

  // deterministic scenery scattered across the world (skips the central spawn)
  const scenery = useMemo(() => {
    if (!world) return [];
    const items: { src: any; x: number; y: number; w: number; h: number; flip?: boolean }[] = [];
    const kinds = [
      { src: W.tree, w: 150, h: 150 }, { src: W.treeHeart, w: 150, h: 150 },
      { src: W.hedge, w: 150, h: 50 }, { src: W.bush, w: 120, h: 60 },
      { src: W.mushroomsPink, w: 70, h: 70 }, { src: W.mushroomPurple, w: 55, h: 55 },
      { src: W.rockBig, w: 70, h: 70 }, { src: W.log, w: 74, h: 74 },
      { src: W.sunflower, w: 60, h: 120 }, { src: W.flowerYellow, w: 52, h: 52 },
    ];
    for (let i = 0; i < 46; i++) {
      const k = kinds[Math.floor(wob(i * 3 + 1) * kinds.length)];
      const x = 120 + wob(i * 7 + 2) * (world.w - 240);
      const y = 120 + wob(i * 11 + 5) * (world.h - 240);
      // keep the spawn area (world center) fairly clear
      if (Math.abs(x - world.w / 2) < 260 && Math.abs(y - world.h / 2) < 200) continue;
      items.push({ ...k, x, y, flip: wob(i * 13) > 0.5 });
    }
    return items;
  }, [world]);

  const decals = useMemo(() => {
    if (!world) return [];
    const ds = [W.decal1, W.decal2, W.decal3];
    return Array.from({ length: 70 }, (_, i) => ({
      src: ds[i % 3],
      x: 40 + wob(i * 5 + 3) * (world.w - 80),
      y: 40 + wob(i * 9 + 7) * (world.h - 80),
    }));
  }, [world]);

  if (!world) {
    return (
      <View style={{ flex: 1, backgroundColor: '#BFD98A', alignItems: 'center', justifyContent: 'center' }}>
        <OutlinedText size={22} color={C.white} outline={C.darkInk} thickness={2}>
          Entering the world...
        </OutlinedText>
      </View>
    );
  }

  const camX = clamp(myPos.x - sw / 2, 0, Math.max(0, world.w - sw));
  const camY = clamp(myPos.y - sh / 2, 0, Math.max(0, world.h - sh));
  const others = Object.values(players).filter((p) => p.username !== myUsername);

  const fenceCount = Math.ceil(world.w / 92) + 1;

  return (
    <View style={{ flex: 1, backgroundColor: '#BFD98A', overflow: 'hidden' }}>
      {/* the world, translated so the camera follows the player */}
      <View
        style={{
          position: 'absolute', width: world.w, height: world.h,
          backgroundColor: '#BFD98A',
          transform: [{ translateX: -camX }, { translateY: -camY }],
        }}
      >
        {/* grass texture */}
        {decals.map((d, i) => (
          <Image key={`d${i}`} source={d.src}
            style={{ position: 'absolute', left: d.x, top: d.y, width: 60, height: 60, opacity: 0.85 }} resizeMode="stretch" />
        ))}
        {/* fence border top + bottom */}
        {Array.from({ length: fenceCount }, (_, i) => (
          <React.Fragment key={`f${i}`}>
            <Image source={W.fenceH} style={{ position: 'absolute', left: i * 90, top: -6, width: 92, height: 46 }} resizeMode="stretch" />
            <Image source={W.fenceH} style={{ position: 'absolute', left: i * 90, top: world.h - 40, width: 92, height: 46 }} resizeMode="stretch" />
          </React.Fragment>
        ))}
        {/* one big pond */}
        <Sprite src={W.pond} x={world.w * 0.24} y={world.h * 0.72} w={300} h={220} />
        {/* scenery */}
        {scenery.map((s, i) => (
          <Sprite key={`s${i}`} {...s} />
        ))}

        {/* other players */}
        {others.map((p) => (
          <View key={p.username} style={{ position: 'absolute', left: p.x - 34, top: p.y - 40, alignItems: 'center', opacity: p.online ? 1 : 0.55 }}>
            <Avatar color={p.color} species={p.species} equipped={p.equipped} size={68} />
            <View style={{ marginTop: -8 }}>
              <OutlinedText size={12} color={p.online ? C.white : '#E6E0CE'} outline={C.darkInk} thickness={1.5}>
                {p.name}
              </OutlinedText>
            </View>
          </View>
        ))}

        {/* me */}
        <View style={{ position: 'absolute', left: myPos.x - 36, top: myPos.y - 42, alignItems: 'center' }}>
          <Avatar color={me?.color ?? '#A8D8C8'} species={me?.species} equipped={me?.equipped} size={72} />
          <View style={{ marginTop: -8 }}>
            <OutlinedText size={12} color={C.yellow} outline={C.darkInk} thickness={1.5}>
              {me?.name ?? 'You'}
            </OutlinedText>
          </View>
        </View>
      </View>

      {/* close */}
      <Pressable onPress={nav.back} style={{ position: 'absolute', top: insets.top + 8, left: 14 }}>
        <View style={{ width: 58, height: 58, alignItems: 'center', justifyContent: 'center' }}>
          <NineSliceBg set={BTN_CREAM} corner={12} />
          <Text style={{ fontFamily: F.display, fontSize: 22, color: C.orange, includeFontPadding: false }}>✕</Text>
        </View>
      </Pressable>

      {/* header hint */}
      <View style={{ position: 'absolute', top: insets.top + 12, alignSelf: 'center' }}>
        <OutlinedText size={20} color={C.white} outline={C.darkInk} thickness={2}>
          The Commons
        </OutlinedText>
        <Text style={{ fontFamily: F.body, fontSize: 11, color: connected ? C.brown : C.redPin, textAlign: 'center' }}>
          {connected ? `${others.length + 1} here` : 'connecting...'}
        </Text>
      </View>

      {/* joystick */}
      <View
        {...pan.panHandlers}
        style={{
          position: 'absolute', left: 26, bottom: insets.bottom + 30,
          width: JOY_R * 2, height: JOY_R * 2, borderRadius: JOY_R,
          backgroundColor: 'rgba(74,64,49,0.18)', borderWidth: 3, borderColor: 'rgba(74,64,49,0.4)',
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        <View
          style={{
            width: THUMB_R * 2, height: THUMB_R * 2, borderRadius: THUMB_R,
            backgroundColor: C.cream, borderWidth: 3, borderColor: C.brown,
            transform: [{ translateX: thumb.x }, { translateY: thumb.y }],
          }}
        />
      </View>
    </View>
  );
}
