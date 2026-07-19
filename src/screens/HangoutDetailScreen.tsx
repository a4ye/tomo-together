import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Avatar from '../components/Avatar';
import { DoodleButton, DoodleCard } from '../components/Doodle';
import OutlinedText from '../components/OutlinedText';
import YardBackground from '../components/YardBackground';
import Polaroid from '../components/Polaroid';
import TopBar from '../components/TopBar';
import { useNav } from '../state/nav';
import { useSession } from '../state/session';
import { C, F } from '../theme';
import { Hangout } from '../types';
import { fmtDate } from './HangoutsScreen';

export default function HangoutDetailScreen({ hangoutId }: { hangoutId: number }) {
  const { api, me, serverUrl } = useSession();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const [h, setH] = useState<Hangout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    return api.hangout(hangoutId).then((r) => setH(r.hangout)).catch((e) => setError(e.message));
  }, [api, hangoutId]);

  // reload when returning from the photo or confirm screens
  useEffect(() => { load(); }, [load, nav.route]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (!h) {
    return (
      <View style={{ flex: 1 }}>
        <YardBackground bg={C.tan} tint={C.tanPaw} seed={21} />
        <View style={{ paddingTop: insets.top }}>
          <TopBar title="Hangout" />
        </View>
        {error && (
          <Text style={{ fontFamily: F.body, fontSize: 14, color: C.redPin, textAlign: 'center', marginTop: 30 }}>
            {error}
          </Text>
        )}
      </View>
    );
  }

  const started = new Date(h.date).getTime() < Date.now();
  const isPairConfirmed = (a: string, b: string) =>
    h.confirmedPairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

  const pairs: { a: typeof h.members[number]; b: typeof h.members[number] }[] = [];
  for (let i = 0; i < h.members.length; i++)
    for (let j = i + 1; j < h.members.length; j++)
      pairs.push({ a: h.members[i], b: h.members[j] });

  return (
    <View style={{ flex: 1 }}>
      <YardBackground bg={C.tan} tint={C.tanPaw} seed={21} />
      <View style={{ paddingTop: insets.top }}>
        <TopBar title="Hangout" />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[C.orange]} />
        }
      >
        <DoodleCard seed={6} style={{ alignItems: 'center' }}>
          <Text style={{ fontFamily: F.display, fontSize: 24, color: C.darkInk, textAlign: 'center' }}>
            {h.activityLabel}
          </Text>
          <Text style={{ fontFamily: F.body, fontSize: 14, color: C.brown, marginTop: 2 }}>
            {fmtDate(h.date)} at {h.place}
          </Text>
          {h.bonusReason && (
            <Text style={{ fontFamily: F.display, fontSize: 13, color: C.labelGreen, marginTop: 4 }}>
              {h.bonusReason}: vibe x2
            </Text>
          )}
          <View style={{ flexDirection: 'row', marginTop: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
            {h.members.map((m) => (
              <View key={m.username} style={{ alignItems: 'center', marginHorizontal: 8, marginBottom: 4 }}>
                <Avatar color={m.color} equipped={m.equipped} size={52} />
                <Text style={{ fontFamily: F.body, fontSize: 12, color: C.darkInk }}>
                  {m.username === me?.username ? 'You' : m.name}
                </Text>
              </View>
            ))}
          </View>
        </DoodleCard>

        {/* photo */}
        <View style={{ marginTop: 16, marginBottom: 6 }}>
          <OutlinedText size={20} color={C.labelPink} outline={C.white} thickness={2}>
            The photo
          </OutlinedText>
        </View>
        <View style={{ alignItems: 'center' }}>
          <Polaroid
            seed={h.id * 7 + 2}
            width={220}
            photoUri={h.photoUrl ? `${serverUrl}${h.photoUrl}` : undefined}
            caption={h.photoUrl ? h.activityLabel : undefined}
          />
          {started && !h.completedAt && (
            <View style={{ marginTop: 10 }}>
              <DoodleButton
                label={h.photoUrl ? 'Retake photo' : 'Take the photo'}
                seed={9} bg={C.yellow} border={C.brown}
                onPress={() => nav.push({ name: 'photo', hangoutId: h.id })}
              />
            </View>
          )}
          {!started && (
            <Text style={{ fontFamily: F.body, fontSize: 13, color: C.brown, marginTop: 8, textAlign: 'center' }}>
              The photo and confirmations unlock once the hangout starts.
            </Text>
          )}
        </View>

        {/* pair confirmations */}
        <View style={{ marginTop: 16, marginBottom: 6 }}>
          <OutlinedText size={20} color={C.labelBlue} outline={C.white} thickness={2}>
            Confirmations
          </OutlinedText>
        </View>
        <DoodleCard seed={13}>
          <Text style={{ fontFamily: F.body, fontSize: 13, color: C.brown, marginBottom: 8 }}>
            Every pair confirms once to prove you were all really there.
            Tap phones or scan each other's code.
          </Text>
          {pairs.map(({ a, b }) => {
            const doneP = isPairConfirmed(a.username, b.username);
            const mine = me && (a.username === me.username || b.username === me.username);
            const other = a.username === me?.username ? b : a;
            return (
              <View
                key={`${a.username}-${b.username}`}
                style={{
                  flexDirection: 'row', alignItems: 'center', paddingVertical: 7,
                  borderTopWidth: 1.5, borderTopColor: '#EADFC6',
                }}
              >
                <Text style={{ flex: 1, fontFamily: F.body, fontSize: 14, color: C.darkInk }}>
                  {a.username === me?.username ? 'You' : a.name}
                  {'  +  '}
                  {b.username === me?.username ? 'You' : b.name}
                </Text>
                {doneP ? (
                  <Text style={{ fontFamily: F.display, fontSize: 13, color: C.labelGreen }}>Confirmed</Text>
                ) : mine && started && !h.completedAt ? (
                  <DoodleButton
                    label="Confirm"
                    size={12}
                    seed={a.username.length + b.username.length}
                    onPress={() =>
                      nav.push({
                        name: 'confirm', hangoutId: h.id,
                        otherUsername: other.username, otherName: other.name,
                      })
                    }
                  />
                ) : (
                  <Text style={{ fontFamily: F.body, fontSize: 13, color: C.fadedInk }}>Waiting</Text>
                )}
              </View>
            );
          })}
        </DoodleCard>

        {h.completedAt && (
          <View style={{ alignItems: 'center', marginTop: 16 }}>
            <OutlinedText size={22} color={C.labelGreen} outline={C.white} thickness={2}>
              In your Memory Book
            </OutlinedText>
            <View style={{ marginTop: 8 }}>
              <DoodleButton label="Open Memory Book" seed={17} onPress={() => nav.push({ name: 'memoryBook' })} />
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
