import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Avatar from '../components/Avatar';
import { DoodleButton, DoodleCard } from '../components/Doodle';
import OutlinedText from '../components/OutlinedText';
import YardBackground from '../components/YardBackground';
import TopBar from '../components/TopBar';
import { useNav } from '../state/nav';
import { useSession } from '../state/session';
import { C, F } from '../theme';
import { Hangout } from '../types';

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) +
    ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function HangoutCard({ h, seed, onOpen }: { h: Hangout; seed: number; onOpen: () => void }) {
  const { me } = useSession();
  const others = h.members.filter((m) => m.username !== me?.username);
  const confirmed = h.confirmedPairs.length;
  return (
    <Pressable onPress={onOpen}>
      <DoodleCard seed={seed} tilt={0.5} style={{ marginBottom: 12 }}>
        <Text style={{ fontFamily: F.display, fontSize: 17, color: C.darkInk }}>
          {h.activityLabel} with {others.map((m) => m.name).join(', ')}
        </Text>
        <Text style={{ fontFamily: F.body, fontSize: 13, color: C.brown }}>
          {fmtDate(h.date)} at {h.place}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
          {h.members.map((m) => (
            <View key={m.username} style={{ marginRight: 2 }}>
              <Avatar color={m.color} equipped={m.equipped} size={30} />
            </View>
          ))}
          <View style={{ flex: 1 }} />
          {h.completedAt ? (
            <Text style={{ fontFamily: F.display, fontSize: 12.5, color: C.labelGreen }}>In your Memory Book</Text>
          ) : new Date(h.date).getTime() < Date.now() ? (
            <Text style={{ fontFamily: F.display, fontSize: 12.5, color: C.orange }}>
              {h.photoUrl ? '' : 'Needs photo. '}Confirmed {confirmed}/{h.pairsTotal}
            </Text>
          ) : h.bonusReason ? (
            <Text style={{ fontFamily: F.display, fontSize: 12.5, color: C.labelGreen }}>
              {h.bonusReason}: x2
            </Text>
          ) : null}
        </View>
      </DoodleCard>
    </Pressable>
  );
}

export default function HangoutsScreen() {
  const { api } = useSession();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const [hangouts, setHangouts] = useState<Hangout[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    return api.hangouts().then((r) => setHangouts(r.hangouts)).catch(() => {});
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const upcoming = hangouts
    .filter((h) => !h.completedAt && new Date(h.date).getTime() >= Date.now())
    .sort((a, b) => a.date.localeCompare(b.date));
  const toFinish = hangouts.filter((h) => !h.completedAt && new Date(h.date).getTime() < Date.now());
  const done = hangouts.filter((h) => h.completedAt);

  return (
    <View style={{ flex: 1 }}>
      <YardBackground bg={C.tan} tint={C.tanPaw} seed={12} />
      <View style={{ paddingTop: insets.top }}>
        <TopBar title="Hangouts" />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[C.orange]} />
        }
      >
        <DoodleButton
          label="Plan a hangout"
          seed={2} bg={C.yellow} border={C.brown}
          onPress={() => nav.push({ name: 'newHangout' })}
        />

        {toFinish.length > 0 && (
          <>
            <View style={{ marginTop: 18, marginBottom: 6 }}>
              <OutlinedText size={20} color={C.labelOrange} outline={C.white} thickness={2}>
                Finish these up
              </OutlinedText>
            </View>
            {toFinish.map((h, i) => (
              <HangoutCard key={h.id} h={h} seed={i * 7 + 3}
                onOpen={() => nav.push({ name: 'hangoutDetail', hangoutId: h.id })} />
            ))}
          </>
        )}

        <View style={{ marginTop: 18, marginBottom: 6 }}>
          <OutlinedText size={20} color={C.labelBlue} outline={C.white} thickness={2}>
            Coming up
          </OutlinedText>
        </View>
        {upcoming.length === 0 && (
          <Text style={{ fontFamily: F.body, fontSize: 14, color: C.brown }}>
            Nothing planned yet.
          </Text>
        )}
        {upcoming.map((h, i) => (
          <HangoutCard key={h.id} h={h} seed={i * 5 + 23}
            onOpen={() => nav.push({ name: 'hangoutDetail', hangoutId: h.id })} />
        ))}

        {done.length > 0 && (
          <>
            <View style={{ marginTop: 18, marginBottom: 6 }}>
              <OutlinedText size={20} color={C.labelGreen} outline={C.white} thickness={2}>
                Done
              </OutlinedText>
            </View>
            {done.map((h, i) => (
              <HangoutCard key={h.id} h={h} seed={i * 3 + 53}
                onOpen={() => nav.push({ name: 'hangoutDetail', hangoutId: h.id })} />
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}
