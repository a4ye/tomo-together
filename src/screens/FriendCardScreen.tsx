import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Avatar from '../components/Avatar';
import { DoodleButton, DoodleCard } from '../components/Doodle';
import { NineSliceBg, PANEL_TAN } from '../components/PixelUI';
import TopBar from '../components/TopBar';
import YardBackground from '../components/YardBackground';
import { useSession } from '../state/session';
import { C, F } from '../theme';
import { FriendCard } from '../types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'MM-DD' -> 'Mar 14'
function formatBday(birthday: string): string {
  const [m, d] = birthday.split('-').map((n) => parseInt(n, 10));
  if (!m || !d || m < 1 || m > 12) return birthday;
  return `${MONTHS[m - 1]} ${d}`;
}

// Hanging picture frame geometry (sketch: nail + string triangle + frame).
const FRAME_W = 200;
const FRAME_H = 200;
const NAIL = 10;
const STRING_H = 46;
const ATTACH_INSET = 30; // string meets the frame this far in from each side
const HALF_SPAN = FRAME_W / 2 - ATTACH_INSET;
const STRING_LEN = Math.sqrt(HALF_SPAN * HALF_SPAN + STRING_H * STRING_H);
const STRING_DEG = (Math.atan2(STRING_H, HALF_SPAN) * 180) / Math.PI;
const STRING_MID_X = (ATTACH_INSET + FRAME_W / 2) / 2;
const SWAY_H = STRING_H + FRAME_H; // the frame sways around the nail
// Arrows sit level with the frame's center, not the whole column's.
const ARROW_DROP = NAIL - 2 + STRING_H + FRAME_H / 2 - (NAIL - 2 + STRING_H + FRAME_H) / 2;

// Two thin angled darkInk lines from the nail down to the frame's top corners.
function HangString() {
  const line = {
    position: 'absolute' as const,
    width: STRING_LEN,
    height: 2.5,
    borderRadius: 2,
    backgroundColor: C.darkInk,
    top: STRING_H / 2 - 1.25,
  };
  return (
    <View style={{ width: FRAME_W, height: STRING_H }}>
      <View
        style={[line, {
          left: STRING_MID_X - STRING_LEN / 2,
          transform: [{ rotate: `-${STRING_DEG}deg` }],
        }]}
      />
      <View
        style={[line, {
          left: FRAME_W - STRING_MID_X - STRING_LEN / 2,
          transform: [{ rotate: `${STRING_DEG}deg` }],
        }]}
      />
    </View>
  );
}

function InfoRow({
  label,
  value,
  faded = false,
  last = false,
}: {
  label: string;
  value: string;
  faded?: boolean;
  last?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: last ? 0 : 10 }}>
      <Text
        allowFontScaling={false}
        style={{ fontFamily: F.display, fontSize: 12, color: C.brown, width: 76, marginTop: 2, includeFontPadding: false }}
      >
        {label}
      </Text>
      <Text style={{ flex: 1, fontFamily: F.body, fontSize: 13.5, color: faded ? C.fadedInk : C.darkInk }}>
        {value}
      </Text>
    </View>
  );
}

export default function FriendCardScreen({ username }: { username: string }) {
  const { api } = useSession();
  const insets = useSafeAreaInsets();
  const [current, setCurrent] = useState(username);
  const [card, setCard] = useState<FriendCard | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadCard = useCallback((u: string) => {
    setLoading(true);
    setError(null);
    api.friendCard(u)
      .then((r) => setCard(r.card))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the card'))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => {
    api.friends().then((r) => setOrder(r.friends.map((f) => f.username))).catch(() => {});
  }, [api]);

  useEffect(() => { loadCard(current); }, [current, loadCard]);

  const canCycle = !loading && order.length > 1;
  const cycle = (dir: 1 | -1) => {
    if (order.length < 2) return;
    const i = order.indexOf(current);
    const from = i < 0 ? 0 : i;
    setCurrent(order[(from + dir + order.length) % order.length]);
  };

  // Entrance: staggered rise, starting once the first card is in.
  const anims = useRef([new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]).current;
  const entered = useRef(false);
  useEffect(() => {
    if (!card || entered.current) return;
    entered.current = true;
    Animated.stagger(
      45,
      anims.map((a) =>
        Animated.spring(a, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 10 })
      )
    ).start();
  }, [card, anims]);

  // Gentle idle sway of the hanging frame around its nail.
  const sway = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(sway, { toValue: 1, duration: 1900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(sway, { toValue: 0, duration: 1900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [sway]);

  return (
    <View style={{ flex: 1 }}>
      <YardBackground bg={C.pink} tint={C.pinkPaw} seed={14} />
      <View style={{ paddingTop: insets.top }}>
        <TopBar title="Friend card" />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30, alignItems: 'center' }}>
        {error ? (
          <View style={{ alignItems: 'center', marginTop: 48 }}>
            <Text style={{ fontFamily: F.body, fontSize: 14, color: C.redPin, textAlign: 'center', marginBottom: 12 }}>
              {error}
            </Text>
            <DoodleButton label="Retry" size={14} seed={9} onPress={() => loadCard(current)} />
          </View>
        ) : !card ? (
          <Text style={{ fontFamily: F.body, fontSize: 14, color: C.fadedInk, marginTop: 48 }}>
            Loading…
          </Text>
        ) : (
          <>
            <Animated.View
              style={{
                opacity: anims[0],
                transform: [
                  { translateY: anims[0].interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
                  { scale: anims[0].interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) },
                ],
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ transform: [{ translateY: ARROW_DROP }] }}>
                  <DoodleButton
                    label="←"
                    size={18}
                    seed={21}
                    disabled={!canCycle}
                    onPress={() => cycle(-1)}
                    style={{ minWidth: 48, minHeight: 48, paddingHorizontal: 10 }}
                  />
                </View>

                <View style={{ alignItems: 'center', marginHorizontal: 8 }}>
                  <View style={{ width: NAIL, height: NAIL, borderRadius: 3, backgroundColor: C.darkInk, zIndex: 2 }} />
                  <Animated.View
                    style={{
                      marginTop: -2,
                      transform: [
                        { translateY: -SWAY_H / 2 },
                        { rotate: sway.interpolate({ inputRange: [0, 1], outputRange: ['-1.5deg', '1.5deg'] }) },
                        { translateY: SWAY_H / 2 },
                      ],
                    }}
                  >
                    <HangString />
                    <View style={{ width: FRAME_W, height: FRAME_H, padding: 18 }}>
                      <NineSliceBg set={PANEL_TAN} corner={15} />
                      <View
                        style={{
                          flex: 1, backgroundColor: C.white, borderRadius: 6,
                          alignItems: 'center', justifyContent: 'center',
                          opacity: loading ? 0.55 : 1,
                        }}
                      >
                        <Avatar color={card.color} species={card.species} equipped={card.equipped} size={130} />
                      </View>
                    </View>
                  </Animated.View>
                </View>

                <View style={{ transform: [{ translateY: ARROW_DROP }] }}>
                  <DoodleButton
                    label="→"
                    size={18}
                    seed={22}
                    disabled={!canCycle}
                    onPress={() => cycle(1)}
                    style={{ minWidth: 48, minHeight: 48, paddingHorizontal: 10 }}
                  />
                </View>
              </View>
            </Animated.View>

            <Animated.View
              style={{
                opacity: anims[1],
                transform: [
                  { translateY: anims[1].interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
                  { scale: anims[1].interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) },
                ],
              }}
            >
              <Text
                allowFontScaling={false}
                style={{ fontFamily: F.display, fontSize: 22, color: C.darkInk, marginTop: 12, includeFontPadding: false }}
              >
                {card.name.toUpperCase()}
              </Text>
            </Animated.View>

            <Animated.View
              style={{
                alignSelf: 'stretch',
                opacity: anims[2],
                transform: [
                  { translateY: anims[2].interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
                  { scale: anims[2].interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) },
                ],
              }}
            >
              <DoodleCard seed={5} style={{ marginTop: 16 }}>
                <InfoRow
                  label="Likes:"
                  value={card.likes.length > 0 ? card.likes.join(' · ') : 'Still figuring them out…'}
                  faded={card.likes.length === 0}
                />
                <InfoRow
                  label="Dislikes:"
                  value={card.dislikes.length > 0 ? card.dislikes.join(' · ') : 'Still figuring them out…'}
                  faded={card.dislikes.length === 0}
                />
                <InfoRow label="Bday:" value={formatBday(card.birthday)} last />
              </DoodleCard>
            </Animated.View>
          </>
        )}
      </ScrollView>
    </View>
  );
}
