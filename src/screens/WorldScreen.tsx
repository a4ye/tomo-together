import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, Image, PanResponder, Pressable, Text, useWindowDimensions, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Avatar from '../components/Avatar';
import OutlinedText from '../components/OutlinedText';
import { BTN_CREAM, NineSliceBg } from '../components/PixelUI';
import { useNav } from '../state/nav';
import { useSession } from '../state/session';
import { C, F, wob } from '../theme';
import { useWorldSocket, WorldPlayer } from '../worldSocket';

const AVATAR_R = 40;
const SPEED = 6.5;   // px per tick
const TICK_MS = 30;  // ~33fps
const JOY_R = 60;
const THUMB_R = 30;

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

// Static scenery — never changes, so it renders once and is memoized out of
// every subsequent re-render (movement + other players).
const StaticWorld = React.memo(function StaticWorld({ w, h }: { w: number; h: number }) {
  const decals = [];
  const ds = [W.decal1, W.decal2, W.decal3];
  for (let i = 0; i < 70; i++) {
    decals.push({ src: ds[i % 3], x: 40 + wob(i * 5 + 3) * (w - 80), y: 40 + wob(i * 9 + 7) * (h - 80) });
  }
  const kinds = [
    { src: W.tree, w: 150, h: 150 }, { src: W.treeHeart, w: 150, h: 150 },
    { src: W.hedge, w: 150, h: 50 }, { src: W.bush, w: 120, h: 60 },
    { src: W.mushroomsPink, w: 70, h: 70 }, { src: W.mushroomPurple, w: 55, h: 55 },
    { src: W.rockBig, w: 70, h: 70 }, { src: W.log, w: 74, h: 74 },
    { src: W.sunflower, w: 60, h: 120 }, { src: W.flowerYellow, w: 52, h: 52 },
  ];
  const scenery = [];
  for (let i = 0; i < 46; i++) {
    const k = kinds[Math.floor(wob(i * 3 + 1) * kinds.length)];
    const x = 120 + wob(i * 7 + 2) * (w - 240);
    const y = 120 + wob(i * 11 + 5) * (h - 240);
    if (Math.abs(x - w / 2) < 260 && Math.abs(y - h / 2) < 200) continue;
    scenery.push({ ...k, x, y, flip: wob(i * 13) > 0.5 });
  }
  const fenceCount = Math.ceil(w / 90) + 1;
  return (
    <>
      {decals.map((d, i) => (
        <Image key={`d${i}`} source={d.src}
          style={{ position: 'absolute', left: d.x, top: d.y, width: 60, height: 60, opacity: 0.85 }} resizeMode="stretch" />
      ))}
      {Array.from({ length: fenceCount }, (_, i) => (
        <React.Fragment key={`f${i}`}>
          <Image source={W.fenceH} style={{ position: 'absolute', left: i * 90, top: -6, width: 92, height: 46 }} resizeMode="stretch" />
          <Image source={W.fenceH} style={{ position: 'absolute', left: i * 90, top: h - 40, width: 92, height: 46 }} resizeMode="stretch" />
        </React.Fragment>
      ))}
      <Image source={W.pond} style={{ position: 'absolute', left: w * 0.24 - 150, top: h * 0.72 - 110, width: 300, height: 220 }} resizeMode="stretch" />
      {scenery.map((s, i) => (
        <Image key={`s${i}`} source={s.src}
          style={{ position: 'absolute', left: s.x - s.w / 2, top: s.y - s.h / 2, width: s.w, height: s.h, transform: s.flip ? [{ scaleX: -1 }] : undefined }}
          resizeMode="stretch" />
      ))}
    </>
  );
});

// Another player, smoothly eased toward each incoming position.
const OtherPlayer = React.memo(function OtherPlayer({ p }: { p: WorldPlayer }) {
  const xy = useRef(new Animated.ValueXY({ x: p.x - 34, y: p.y - 40 })).current;
  useEffect(() => {
    Animated.timing(xy, {
      toValue: { x: p.x - 34, y: p.y - 40 }, duration: 110, useNativeDriver: true,
    }).start();
  }, [p.x, p.y, xy]);
  return (
    <Animated.View style={{ position: 'absolute', alignItems: 'center', opacity: p.online ? 1 : 0.5, transform: xy.getTranslateTransform() }}>
      <Avatar color={p.color} species={p.species} equipped={p.equipped} size={68} />
      <View style={{ marginTop: -8 }}>
        <OutlinedText size={12} color={p.online ? C.white : '#E6E0CE'} outline={C.darkInk} thickness={1.5}>
          {p.name}
        </OutlinedText>
      </View>
    </Animated.View>
  );
});

// Self-contained joystick: its own thumb state stays internal so dragging does
// not re-render the world. It writes the movement vector into a parent ref.
function Joystick({ vecRef, style }: { vecRef: React.MutableRefObject<{ x: number; y: number }>; style: any }) {
  const [thumb, setThumb] = useState({ x: 0, y: 0 });
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (_e, g) => {
        let dx = g.dx, dy = g.dy;
        const d = Math.hypot(dx, dy);
        if (d > JOY_R) { dx = (dx / d) * JOY_R; dy = (dy / d) * JOY_R; }
        vecRef.current = { x: dx / JOY_R, y: dy / JOY_R };
        setThumb({ x: dx, y: dy });
      },
      onPanResponderRelease: () => { vecRef.current = { x: 0, y: 0 }; setThumb({ x: 0, y: 0 }); },
      onPanResponderTerminate: () => { vecRef.current = { x: 0, y: 0 }; setThumb({ x: 0, y: 0 }); },
    })
  ).current;
  return (
    <View
      {...pan.panHandlers}
      style={[{
        width: JOY_R * 2, height: JOY_R * 2, borderRadius: JOY_R,
        backgroundColor: 'rgba(74,64,49,0.18)', borderWidth: 3, borderColor: 'rgba(74,64,49,0.4)',
        alignItems: 'center', justifyContent: 'center',
      }, style]}
    >
      <View style={{
        width: THUMB_R * 2, height: THUMB_R * 2, borderRadius: THUMB_R,
        backgroundColor: C.cream, borderWidth: 3, borderColor: C.brown,
        transform: [{ translateX: thumb.x }, { translateY: thumb.y }],
      }} />
    </View>
  );
}

export default function WorldScreen() {
  const { serverUrl, token, me } = useSession();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const { width: sw, height: sh } = useWindowDimensions();
  const { world, me: myUsername, players, connected, sendMove } = useWorldSocket(serverUrl, token);

  const vec = useRef({ x: 0, y: 0 });
  const pos = useRef({ x: 0, y: 0 });
  const seeded = useRef(false);
  const cam = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const meXY = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const [ready, setReady] = useState(false);

  const applyCam = useRef((): void => {});
  applyCam.current = () => {
    if (!world) return;
    const { x, y } = pos.current;
    const camX = clamp(x - sw / 2, 0, Math.max(0, world.w - sw));
    const camY = clamp(y - sh / 2, 0, Math.max(0, world.h - sh));
    cam.setValue({ x: -camX, y: -camY });
    meXY.setValue({ x: x - 36, y: y - 42 });
  };

  // seed my position from the saved spot the server sent on init
  useEffect(() => {
    if (seeded.current || !world || !myUsername) return;
    const mine = players[myUsername];
    if (mine) {
      pos.current = { x: mine.x, y: mine.y };
      seeded.current = true;
      applyCam.current();
      setReady(true);
    }
  }, [world, myUsername, players]);

  // movement loop: read the joystick vector, move, ease the camera, send. This
  // updates Animated values only (no React re-render), so it stays smooth.
  useEffect(() => {
    if (!world) return;
    const id = setInterval(() => {
      const v = vec.current;
      if (v.x === 0 && v.y === 0) return;
      const p = pos.current;
      p.x = clamp(p.x + v.x * SPEED, AVATAR_R, world.w - AVATAR_R);
      p.y = clamp(p.y + v.y * SPEED, AVATAR_R, world.h - AVATAR_R);
      applyCam.current();
      sendMove(p.x, p.y);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [world, sendMove]);

  const others = useMemo(
    () => Object.values(players).filter((p) => p.username !== myUsername),
    [players, myUsername]
  );

  if (!world || !ready) {
    return (
      <View style={{ flex: 1, backgroundColor: '#BFD98A', alignItems: 'center', justifyContent: 'center' }}>
        <OutlinedText size={22} color={C.white} outline={C.darkInk} thickness={2}>
          Entering the world...
        </OutlinedText>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#BFD98A', overflow: 'hidden' }}>
      <Animated.View
        style={{
          position: 'absolute', width: world.w, height: world.h, backgroundColor: '#BFD98A',
          transform: cam.getTranslateTransform(),
        }}
      >
        <StaticWorld w={world.w} h={world.h} />
        {others.map((p) => <OtherPlayer key={p.username} p={p} />)}
        <Animated.View style={{ position: 'absolute', alignItems: 'center', transform: meXY.getTranslateTransform() }}>
          <Avatar color={me?.color ?? '#A8D8C8'} species={me?.species} equipped={me?.equipped} size={72} />
          <View style={{ marginTop: -8 }}>
            <OutlinedText size={12} color={C.yellow} outline={C.darkInk} thickness={1.5}>
              {me?.name ?? 'You'}
            </OutlinedText>
          </View>
        </Animated.View>
      </Animated.View>

      <Pressable onPress={nav.back} style={{ position: 'absolute', top: insets.top + 8, left: 14 }}>
        <View style={{ width: 58, height: 58, alignItems: 'center', justifyContent: 'center' }}>
          <NineSliceBg set={BTN_CREAM} corner={12} />
          <Text style={{ fontFamily: F.display, fontSize: 22, color: C.orange, includeFontPadding: false }}>✕</Text>
        </View>
      </Pressable>

      <View style={{ position: 'absolute', top: insets.top + 12, alignSelf: 'center' }}>
        <OutlinedText size={20} color={C.white} outline={C.darkInk} thickness={2}>The Commons</OutlinedText>
        <Text style={{ fontFamily: F.body, fontSize: 11, color: connected ? C.brown : C.redPin, textAlign: 'center' }}>
          {connected ? `${others.length + 1} here` : 'reconnecting...'}
        </Text>
      </View>

      <Joystick vecRef={vec} style={{ position: 'absolute', left: 26, bottom: insets.bottom + 30 }} />
    </View>
  );
}
