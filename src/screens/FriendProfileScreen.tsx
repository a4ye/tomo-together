import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Avatar from '../components/Avatar';
import { DoodleButton, DoodleCard } from '../components/Doodle';
import OutlinedText from '../components/OutlinedText';
import Polaroid from '../components/Polaroid';
import TitleBadge from '../components/TitleBadge';
import TopBar from '../components/TopBar';
import YardBackground from '../components/YardBackground';
import { useNav } from '../state/nav';
import { useSession } from '../state/session';
import { C, F } from '../theme';
import { FriendProfile } from '../types';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function prettyMonthDay(mmdd: string): string {
  const [m, d] = mmdd.split('-');
  return `${MONTHS[Number(m) - 1] ?? '?'} ${Number(d)}`;
}

// How long ago, in friendly words, from an ISO date.
function sinceWords(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60) return 'last month';
  return `${Math.floor(days / 30)} months ago`;
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={{ alignItems: 'center', flex: 1 }}>
      <Text style={{ fontFamily: F.display, fontSize: 22, color: C.darkInk }}>{value}</Text>
      <Text style={{ fontFamily: F.body, fontSize: 12, color }}>{label}</Text>
    </View>
  );
}

export default function FriendProfileScreen({ username }: { username: string }) {
  const { api, me, serverUrl } = useSession();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const [profile, setProfile] = useState<FriendProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    return api.friendProfile(username)
      .then((r) => setProfile(r.friend))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load profile'));
  }, [api, username]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return (
    <View style={{ flex: 1 }}>
      <YardBackground bg={C.pink} tint={C.pinkPaw} seed={8} />
      <View style={{ paddingTop: insets.top }}>
        <TopBar title="Friend" />
      </View>

      {!profile ? (
        <Text style={{ fontFamily: F.body, fontSize: 14, color: C.brown, textAlign: 'center', marginTop: 40 }}>
          {error ?? 'Loading...'}
        </Text>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[C.orange]} />}
        >
          {/* header card */}
          <DoodleCard seed={2} style={{ alignItems: 'center' }}>
            <Avatar color={profile.color} species={profile.species} equipped={profile.equipped} size={130} />
            <Text style={{ fontFamily: F.display, fontSize: 22, color: C.darkInk, marginTop: 4 }}>
              {profile.name}
            </Text>
            <Text style={{ fontFamily: F.body, fontSize: 14, color: C.fadedInk }}>@{profile.username}</Text>
            <TitleBadge title={profile.title} kind={profile.titleKind} style={{ marginTop: 6 }} />
            <Text style={{ fontFamily: F.body, fontSize: 13, color: C.brown, marginTop: 6 }}>
              Birthday {prettyMonthDay(profile.birthday)}
            </Text>

            {/* vibe */}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12, width: '90%' }}>
              <Text style={{ fontFamily: F.display, fontSize: 13, color: C.labelBlue, marginRight: 8 }}>
                Vibe Lv. {profile.vibeLevel}
              </Text>
              <View
                style={{
                  flex: 1, height: 12, backgroundColor: C.white, borderWidth: 2,
                  borderColor: '#C89A62', borderRadius: 2, overflow: 'hidden',
                }}
              >
                <View
                  style={{
                    width: `${Math.round((profile.vibeIntoLevel / profile.vibePerLevel) * 100)}%`,
                    height: '100%', backgroundColor: C.labelBlue,
                  }}
                />
              </View>
            </View>
          </DoodleCard>

          {/* stats row */}
          <DoodleCard seed={5} style={{ marginTop: 12, flexDirection: 'row', paddingVertical: 12 }}>
            <Stat label="hangouts" value={String(profile.hangoutCount)} color={C.labelGreen} />
            <Stat label="upcoming" value={String(profile.upcomingCount)} color={C.labelOrange} />
            <Stat label="vibe" value={String(profile.vibe)} color={C.labelBlue} />
          </DoodleCard>

          {/* last hangout */}
          <DoodleCard seed={7} style={{ marginTop: 12 }}>
            <Text style={{ fontFamily: F.display, fontSize: 13, color: C.brown }}>Last hangout</Text>
            {profile.lastHangout ? (
              <Text style={{ fontFamily: F.body, fontSize: 15, color: C.darkInk, marginTop: 2 }}>
                {new Date(profile.lastHangout).toLocaleDateString(undefined, {
                  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
                })}
                {'  '}
                <Text style={{ color: C.fadedInk }}>({sinceWords(profile.lastHangout)})</Text>
              </Text>
            ) : (
              <Text style={{ fontFamily: F.body, fontSize: 14, color: C.fadedInk, marginTop: 2 }}>
                You have not hung out yet. Plan something!
              </Text>
            )}
            <Text style={{ fontFamily: F.body, fontSize: 12, color: C.fadedInk, marginTop: 6 }}>
              Friends since {new Date(profile.friendsSince).toLocaleDateString(undefined, {
                month: 'long', year: 'numeric',
              })}
            </Text>
          </DoodleCard>

          {profile.topActivities.length > 0 && (
            <DoodleCard seed={9} style={{ marginTop: 12 }}>
              <Text style={{ fontFamily: F.display, fontSize: 13, color: C.brown, marginBottom: 4 }}>
                What you do together
              </Text>
              <Text style={{ fontFamily: F.body, fontSize: 14, color: C.darkInk }}>
                {profile.topActivities.join(' · ')}
              </Text>
            </DoodleCard>
          )}

          {/* shared memories */}
          {profile.recentMemories.length > 0 && (
            <>
              <View style={{ marginTop: 16, marginBottom: 6 }}>
                <OutlinedText size={18} color={C.labelPink} outline={C.white} thickness={2}>
                  Memories together
                </OutlinedText>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                {profile.recentMemories.map((m, i) => (
                  <Pressable
                    key={m.id}
                    onPress={() => nav.push({ name: 'hangoutDetail', hangoutId: m.id })}
                    style={{ width: '48%', marginBottom: 14 }}
                  >
                    <Polaroid
                      seed={i * 3 + 2}
                      width="100%"
                      photoUri={m.photoUrl ? `${serverUrl}${m.photoUrl}` : undefined}
                      caption={m.activityLabel}
                    />
                  </Pressable>
                ))}
              </View>
            </>
          )}

          {/* plan together */}
          <View style={{ marginTop: 8 }}>
            <DoodleButton
              label={`Plan a hangout with ${profile.name}`}
              bg={C.yellow} border={C.brown} seed={12}
              onPress={() => nav.push({ name: 'newHangout' })}
            />
          </View>
          {me && <View style={{ height: 4 }} />}
        </ScrollView>
      )}
    </View>
  );
}
