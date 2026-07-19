import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, Easing, Pressable, Text, useWindowDimensions, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AcornPill from '../components/Acorn';
import Avatar from '../components/Avatar';
import DepositReminder from '../components/DepositReminder';
import { DoodleCard } from '../components/Doodle';
import OutlinedText from '../components/OutlinedText';
import { AnimatedPixelSprite, TEAR_FRAMES } from '../components/PixelSprite';
import SuggestionCard from '../components/SuggestionCard';
import YardBackground from '../components/YardBackground';
import YardScene from '../components/YardScene';
import { bonusPreview } from '../bonus';
import { useNav } from '../state/nav';
import { useSession } from '../state/session';
import { BTN_CREAM, NineSliceBg, PANEL_CREAM } from '../components/PixelUI';
import { C, F, wob } from '../theme';
import { FriendView, Hangout, Holiday } from '../types';
import { checkForUpdate, downloadAndInstall, UpdateInfo } from '../updater';
import MenuOverlay from './MenuOverlay';

function BobbingAvatar({
  friend, delay, size, sad = false, onPress,
}: {
  friend: FriendView; delay: number; size: number; sad?: boolean; onPress: () => void;
}) {
  const y = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (sad) {
      // sad friends sit still
      y.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(y, { toValue: -5, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(y, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [y, delay, sad]);
  return (
    <Pressable onPress={onPress}>
      <Animated.View style={{ transform: [{ translateY: y }], alignItems: 'center' }}>
        <View>
          <Avatar color={friend.color} species={friend.species} equipped={friend.equipped} size={size} />
          {sad && (
            <AnimatedPixelSprite
              frames={TEAR_FRAMES}
              px={3}
              interval={500}
              style={{ position: 'absolute', left: size * 0.6, top: size * 0.42 }}
            />
          )}
        </View>
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
  const { me, api, serverUrl } = useSession();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [menuOpen, setMenuOpen] = useState(false);
  const [friends, setFriends] = useState<FriendView[]>([]);
  const [nextHangout, setNextHangout] = useState<Hangout | null>(null);
  const [needsAttention, setNeedsAttention] = useState(0);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updating, setUpdating] = useState<number | null>(null); // download fraction
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    checkForUpdate(serverUrl).then(setUpdate);
  }, [serverUrl]);

  const runUpdate = async () => {
    setUpdateError(null);
    setUpdating(0);
    try {
      await downloadAndInstall(serverUrl, setUpdating);
      setUpdating(null);
    } catch (e) {
      setUpdating(null);
      setUpdateError(e instanceof Error ? e.message : 'Update failed');
    }
  };

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

  // The single stalest friend in the yard: no hangout yet, or none in 14+ days.
  // (FriendView carries no friendship age, so a null lastHangoutAt qualifies.)
  const nudge = useMemo(() => {
    const staleMs = 14 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const stale = friends
      .slice(0, 8)
      .filter((f) => !f.lastHangoutAt || now - new Date(f.lastHangoutAt).getTime() > staleMs)
      .sort(
        (a, b) =>
          (a.lastHangoutAt ? new Date(a.lastHangoutAt).getTime() : 0) -
          (b.lastHangoutAt ? new Date(b.lastHangoutAt).getTime() : 0)
      );
    return stale.length > 0 ? stale[0].username : null;
  }, [friends]);

  const spots = useMemo(() => {
    const list = friends.slice(0, 8);
    const perRow = 3;
    // Keep friends on the open foreground lawn: laneTop sits just below the back
    // tree/crest line (~0.50h) so avatars never overlap the trees, and laneBottom
    // stays above the pond. Rows go back-to-front.
    const laneTop = height * 0.53;
    const laneBottom = height * 0.72;
    const rows = Math.max(1, Math.ceil(list.length / perRow));
    const rowGap = rows > 1 ? (laneBottom - laneTop) / (rows - 1) : 0;
    const cellW = (width - 24) / perRow;
    return list.map((f, i) => {
      const sad = f.username === nudge;
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      // front rows (higher i) are larger and, being mapped later, draw on top -
      // giving a natural front-over-back depth to the crowd.
      const size = 58 + row * 9 + Math.round(wob(i * 7) * 8);
      const cx = 12 + col * cellW + cellW / 2 + (wob(i * 17 + 2) - 0.5) * cellW * 0.5;
      const x = Math.min(Math.max(8, cx - size / 2), width - size - 8);
      const baseY = laneTop + row * rowGap + (wob(i * 31) - 0.5) * 16;
      return {
        friend: f,
        sad,
        x,
        // keep the sad friend's speech bubble clear of the header chips
        y: sad ? Math.max(baseY, height * 0.53) : baseY,
        size,
        delay: Math.round(wob(i * 3) * 1200),
      };
    });
  }, [friends, width, height, nudge]);

  const nudgeSpot = spots.find((s) => s.sad);

  return (
    <View style={{ flex: 1 }}>
      <YardBackground bg={C.tan} tint={C.tanPaw} seed={3} />

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
                  borderRadius: 6, paddingVertical: 8, paddingHorizontal: 18,
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
              sad={s.sad}
              onPress={() => nav.push({ name: 'friendProfile', username: s.friend.username })}
            />
          </View>
        ))
      )}

      {/* nudge speech bubble above the sad friend */}
      {nudgeSpot && (() => {
        const bubbleW = 200;
        const cx = nudgeSpot.x + nudgeSpot.size / 2;
        const left = Math.min(Math.max(10, cx - bubbleW / 2), width - bubbleW - 10);
        const notchLeft = Math.min(Math.max(cx - left - 6, 14), bubbleW - 26);
        return (
          <Pressable
            onPress={() => nav.push({ name: 'newHangout', preselect: nudgeSpot.friend.username })}
            style={{ position: 'absolute', left, top: nudgeSpot.y - 66, width: bubbleW }}
          >
            <View style={{ paddingVertical: 8, paddingHorizontal: 11 }}>
              <NineSliceBg set={PANEL_CREAM} corner={12} />
              <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.darkInk }}>
                You haven't hung out with {nudgeSpot.friend.name} for a while…
              </Text>
            </View>
            <View
              style={{
                position: 'absolute', bottom: -4, left: notchLeft, width: 11, height: 11,
                backgroundColor: C.cream, transform: [{ rotate: '45deg' }],
              }}
            />
          </Pressable>
        );
      })()}

      {/* header */}
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 14 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Pressable onPress={() => nav.push({ name: 'profile' })}>
            <View
              style={{
                flexDirection: 'row', alignItems: 'center', backgroundColor: C.cream,
                borderWidth: 2.5, borderColor: '#C89A62', borderRadius: 6,
                paddingVertical: 3, paddingHorizontal: 10,
              }}
            >
              <Avatar color={me?.color ?? '#A8D8C8'} species={me?.species} equipped={me?.equipped} size={34} />
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

        {update && (
          <Pressable onPress={updating == null ? runUpdate : undefined}>
            <DoodleCard seed={11} bg={C.yellow} style={{ marginTop: 8, paddingVertical: 8 }}>
              <Text style={{ fontFamily: F.display, fontSize: 13, color: C.darkInk }}>
                {updating == null
                  ? `Update available (v${update.versionName} build ${update.versionCode}). Tap to install.`
                  : `Downloading update: ${Math.round(updating * 100)}%`}
              </Text>
              {updateError && (
                <Text style={{ fontFamily: F.body, fontSize: 12, color: C.redPin, marginTop: 2 }}>
                  {updateError}
                </Text>
              )}
            </DoodleCard>
          </Pressable>
        )}
      </View>

      {/* suggestion + deposit reminder cards, above the menu button */}
      <View
        pointerEvents="box-none"
        style={{ position: 'absolute', left: 14, right: 14, bottom: insets.bottom + 102 }}
      >
        <SuggestionCard />
        <DepositReminder delay={90} />
      </View>

      {/* menu button */}
      <Pressable
        onPress={() => setMenuOpen(true)}
        style={{ position: 'absolute', right: 16, bottom: insets.bottom + 18 }}
      >
        <View
          style={{
            width: 72, height: 72, alignItems: 'center', justifyContent: 'center',
          }}
        >
          <NineSliceBg set={BTN_CREAM} corner={13} />
          <View style={{ width: 26 }}>
            {[0, 1, 2].map((i) => (
              <View key={i} style={{ height: 4, backgroundColor: '#C89A62', marginVertical: 2.5 }} />
            ))}
          </View>
          <Text style={{ fontFamily: F.display, fontSize: 11, color: C.brown, includeFontPadding: false, marginTop: 3 }}>Menu</Text>
        </View>
      </Pressable>

      {menuOpen && <MenuOverlay onClose={() => setMenuOpen(false)} />}
    </View>
  );
}
