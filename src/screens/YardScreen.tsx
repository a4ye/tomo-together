import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, Easing, Pressable, Text, useWindowDimensions, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AcornPill from '../components/Acorn';
import Avatar from '../components/Avatar';
import { DoodleCard } from '../components/Doodle';
import OutlinedText from '../components/OutlinedText';
import YardBackground from '../components/YardBackground';
import YardScene from '../components/YardScene';
import { bonusPreview } from '../bonus';
import { useNav } from '../state/nav';
import { useSession } from '../state/session';
import { C, F, doodleCorners, wob } from '../theme';
import { FriendView, Hangout, Holiday } from '../types';
import MenuOverlay from './MenuOverlay';

function BobbingAvatar({
  friend, delay, size, onPress,
}: {
  friend: FriendView; delay: number; size: number; onPress: () => void;
}) {
  const y = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(y, { toValue: -5, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(y, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [y, delay]);
  return (
    <Pressable onPress={onPress}>
      <Animated.View style={{ transform: [{ translateY: y }], alignItems: 'center' }}>
        <Avatar color={friend.color} equipped={friend.equipped} size={size} />
        <View style={{ marginTop: -6 }}>
          <OutlinedText size={13} color={C.white} outline={C.darkInk} thickness={1.5}>
            {friend.name}
          </OutlinedText>
        </View>
      </Animated.View>
    </Pressable>
  );
}

export default function YardScreen() {
  const { me, api } = useSession();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [menuOpen, setMenuOpen] = useState(false);
  const [friends, setFriends] = useState<FriendView[]>([]);
  const [nextHangout, setNextHangout] = useState<Hangout | null>(null);
  const [needsAttention, setNeedsAttention] = useState(0);
  const [holidays, setHolidays] = useState<Holiday[]>([]);

  const load = useCallback(() => {
    api.friends().then((r) => setFriends(r.friends)).catch(() => {});
    api.catalog().then((r) => setHolidays(r.holidays)).catch(() => {});
    api.hangouts().then((r) => {
      const open = r.hangouts.filter((h) => !h.completedAt);
      const upcoming = open
        .filter((h) => new Date(h.date).getTime() >= Date.now())
        .sort((a, b) => a.date.localeCompare(b.date));
      setNextHangout(upcoming[0] ?? null);
      setNeedsAttention(open.filter((h) => new Date(h.date).getTime() < Date.now()).length);
    }).catch(() => {});
  }, [api]);

  // refresh whenever the yard becomes the visible screen
  useEffect(() => { load(); }, [load, nav.route]);

  const today = useMemo(
    () => bonusPreview(new Date(), holidays, friends),
    [holidays, friends]
  );

  const spots = useMemo(() => {
    const yardTop = height * 0.42;
    const yardH = height * 0.38;
    return friends.slice(0, 8).map((f, i) => ({
      friend: f,
      x: 10 + ((i % 2) * 0.5 + wob(i * 17 + 2) * 0.38) * (width - 120),
      y: yardTop + (i % 4) * (yardH / 4.4) + wob(i * 31) * 22,
      size: 64 + Math.round(wob(i * 7) * 14),
      delay: Math.round(wob(i * 3) * 1200),
    }));
  }, [friends, width, height]);

  return (
    <View style={{ flex: 1 }}>
      <YardBackground bg={C.tan} tint={C.tanPaw} seed={3} />

      {/* grass */}
      <View
        style={{
          position: 'absolute', left: -30, right: -30, bottom: -40, top: height * 0.38,
          backgroundColor: '#BFD98A', borderTopLeftRadius: 180, borderTopRightRadius: 140,
          borderWidth: 3, borderColor: C.brown,
        }}
      />
      <YardScene />

      {friends.length === 0 ? (
        <View style={{ position: 'absolute', left: 30, right: 30, top: height * 0.52, alignItems: 'center' }}>
          <DoodleCard seed={19} style={{ alignItems: 'center' }}>
            <Text style={{ fontFamily: F.display, fontSize: 16, color: C.darkInk, textAlign: 'center' }}>
              Your yard is empty
            </Text>
            <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.brown, textAlign: 'center', marginTop: 4 }}>
              Add friends by username and they will hang out here.
            </Text>
            <Pressable onPress={() => nav.push({ name: 'friends' })} style={{ marginTop: 10 }}>
              <View
                style={{
                  backgroundColor: C.yellow, borderWidth: 3, borderColor: C.brown,
                  borderRadius: 14, paddingVertical: 8, paddingHorizontal: 18,
                }}
              >
                <Text style={{ fontFamily: F.display, fontSize: 14, color: C.darkInk }}>Find friends</Text>
              </View>
            </Pressable>
          </DoodleCard>
        </View>
      ) : (
        spots.map((s) => (
          <View key={s.friend.username} style={{ position: 'absolute', left: s.x, top: s.y }}>
            <BobbingAvatar
              friend={s.friend}
              size={s.size}
              delay={s.delay}
              onPress={() => nav.push({ name: 'friends' })}
            />
          </View>
        ))
      )}

      {/* header */}
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 14 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Pressable onPress={() => nav.push({ name: 'profile' })}>
            <View
              style={{
                flexDirection: 'row', alignItems: 'center', backgroundColor: C.cream,
                borderWidth: 3, borderColor: C.brown, borderRadius: 18,
                paddingVertical: 3, paddingHorizontal: 10,
              }}
            >
              <Avatar color={me?.color ?? '#A8D8C8'} equipped={me?.equipped} size={34} />
              <Text style={{ fontFamily: F.display, fontSize: 15, color: C.brown, marginLeft: 6 }}>
                {me?.name ?? ''}
              </Text>
            </View>
          </Pressable>
          <AcornPill amount={me?.acorns ?? 0} />
        </View>

        {today.reason && (
          <DoodleCard
            seed={9} tilt={1.2} bg={C.yellow}
            style={{ marginTop: 10, paddingVertical: 6, alignSelf: 'flex-start' }}
          >
            <Text style={{ fontFamily: F.display, fontSize: 14, color: C.darkInk }}>
              {today.reason} today: vibe x2 on hangouts
            </Text>
          </DoodleCard>
        )}

        {nextHangout && (
          <Pressable onPress={() => nav.push({ name: 'hangoutDetail', hangoutId: nextHangout.id })}>
            <DoodleCard seed={5} style={{ marginTop: 10, paddingVertical: 8 }}>
              <Text style={{ fontFamily: F.display, fontSize: 14, color: C.darkInk }}>
                Next: {nextHangout.activityLabel} with {nextHangout.members
                  .filter((m) => m.username !== me?.username).map((m) => m.name).join(', ')}
              </Text>
              <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.brown }}>
                {new Date(nextHangout.date).toLocaleString(undefined, {
                  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                })}
              </Text>
            </DoodleCard>
          </Pressable>
        )}

        {needsAttention > 0 && (
          <Pressable onPress={() => nav.push({ name: 'hangouts' })}>
            <DoodleCard seed={7} bg="#F6D9BC" style={{ marginTop: 8, paddingVertical: 7 }}>
              <Text style={{ fontFamily: F.body, fontSize: 13, color: C.darkInk }}>
                {needsAttention} hangout{needsAttention > 1 ? 's' : ''} waiting on a photo or confirmation
              </Text>
            </DoodleCard>
          </Pressable>
        )}
      </View>

      {/* menu button */}
      <Pressable
        onPress={() => setMenuOpen(true)}
        style={{ position: 'absolute', right: 16, bottom: insets.bottom + 18 }}
      >
        <View
          style={[
            {
              backgroundColor: C.cream, borderWidth: 3, borderColor: C.brown,
              width: 72, height: 72, alignItems: 'center', justifyContent: 'center',
            },
            doodleCorners(33, 18),
          ]}
        >
          <View style={{ width: 26 }}>
            {[0, 1, 2].map((i) => (
              <View key={i} style={{ height: 3.5, backgroundColor: C.orange, borderRadius: 2, marginVertical: 2.5 }} />
            ))}
          </View>
          <Text style={{ fontFamily: F.display, fontSize: 13, color: C.brown, includeFontPadding: false }}>Menu</Text>
        </View>
      </Pressable>

      {menuOpen && <MenuOverlay onClose={() => setMenuOpen(false)} />}
    </View>
  );
}
