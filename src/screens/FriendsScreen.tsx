import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Avatar from '../components/Avatar';
import { DoodleButton, DoodleCard } from '../components/Doodle';
import OutlinedText from '../components/OutlinedText';
import { AnimatedPixelSprite, FLAME_FRAMES } from '../components/PixelSprite';
import YardBackground from '../components/YardBackground';
import TopBar from '../components/TopBar';
import { useNav } from '../state/nav';
import { useSession } from '../state/session';
import { C, F } from '../theme';
import { FriendView, PublicUser } from '../types';

function VibeBar({ f }: { f: FriendView }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
      <Text style={{ fontFamily: F.display, fontSize: 12, color: C.labelBlue, marginRight: 6 }}>
        Vibe Lv. {f.vibeLevel}
      </Text>
      <View
        style={{
          flex: 1, height: 10, backgroundColor: C.white, borderWidth: 2,
          borderColor: '#C89A62', borderRadius: 2, overflow: 'hidden',
        }}
      >
        <View
          style={{
            width: `${Math.round((f.vibeIntoLevel / f.vibePerLevel) * 100)}%`,
            height: '100%', backgroundColor: C.labelBlue,
          }}
        />
      </View>
    </View>
  );
}

// Accepted-friend row: tappable card, streak flame halo behind the avatar.
function FriendRow({ f, seed, onPress }: { f: FriendView; seed: number; onPress: () => void }) {
  const scale = useRef(new Animated.Value(1)).current;
  const springTo = (v: number) =>
    Animated.spring(scale, { toValue: v, useNativeDriver: true, speed: 40, bounciness: 10 }).start();
  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => springTo(0.97)}
      onPressOut={() => springTo(1)}
    >
      <Animated.View style={{ transform: [{ scale }] }}>
        <DoodleCard seed={seed} tilt={0.5} style={{ marginBottom: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ width: 54, height: 54 }}>
              {f.streak && (
                <AnimatedPixelSprite
                  frames={FLAME_FRAMES}
                  px={3}
                  interval={350}
                  style={{ position: 'absolute', top: -12, left: 6 }}
                />
              )}
              <Avatar color={f.color} species={f.species} equipped={f.equipped} size={54} />
            </View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
                <Text style={{ fontFamily: F.display, fontSize: 16, color: C.darkInk }}>{f.name}</Text>
                <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.fadedInk, marginLeft: 6 }}>
                  @{f.username}
                </Text>
              </View>
              {f.streak ? (
                <>
                  <Text style={{ fontFamily: F.display, fontSize: 11, color: C.orange }}>
                    Friendship streak
                  </Text>
                  <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.brown }}>
                    {`You've been hanging with ${f.name} a lot!`}
                  </Text>
                </>
              ) : (
                <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.brown }}>
                  Birthday {f.birthday.replace('-', '/')}
                </Text>
              )}
              <VibeBar f={f} />
            </View>
          </View>
        </DoodleCard>
      </Animated.View>
    </Pressable>
  );
}

export default function FriendsScreen() {
  const { api } = useSession();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PublicUser[]>([]);
  const [friends, setFriends] = useState<FriendView[]>([]);
  const [incoming, setIncoming] = useState<FriendView[]>([]);
  const [outgoing, setOutgoing] = useState<FriendView[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    return api.friends().then((r) => {
      setFriends(r.friends);
      setIncoming(r.incoming);
      setOutgoing(r.outgoing);
    }).catch((e) => setNotice(e.message));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      api.searchUsers(q).then((r) => setResults(r.users)).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [query, api]);

  const request = async (username: string) => {
    try {
      const r = await api.requestFriend(username);
      setNotice(r.accepted ? `You and ${username} are now friends` : `Request sent to ${username}`);
      setQuery('');
      setResults([]);
      load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not send request');
    }
  };

  const accept = async (username: string) => {
    try {
      await api.acceptFriend(username);
      setNotice(`You and ${username} are now friends`);
      load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not accept');
    }
  };

  const knownUsernames = new Set([
    ...friends.map((f) => f.username),
    ...incoming.map((f) => f.username),
    ...outgoing.map((f) => f.username),
  ]);

  return (
    <View style={{ flex: 1 }}>
      <YardBackground bg={C.pink} tint={C.pinkPaw} seed={8} />
      <View style={{ paddingTop: insets.top }}>
        <TopBar title="Friends" />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[C.orange]} />
        }
      >
        <DoodleCard seed={2}>
          <Text style={{ fontFamily: F.display, fontSize: 14, color: C.brown, marginBottom: 6 }}>
            Add a friend by username
          </Text>
          <TextInput
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            placeholder="Search username or name"
            placeholderTextColor={C.fadedInk}
            style={{
              position: 'relative', backgroundColor: C.white, borderWidth: 2.5, borderColor: '#C89A62',
              borderRadius: 6, paddingHorizontal: 12, paddingVertical: 9,
              fontFamily: F.body, fontSize: 15, color: C.darkInk,
            }}
          />
          {results.filter((u) => !knownUsernames.has(u.username)).map((u) => (
            <View
              key={u.username}
              style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 }}
            >
              <Avatar color={u.color} species={u.species} equipped={u.equipped} size={44} />
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={{ fontFamily: F.display, fontSize: 15, color: C.darkInk }}>{u.name}</Text>
                <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.fadedInk }}>@{u.username}</Text>
              </View>
              <DoodleButton label="Add" size={13} seed={11} onPress={() => request(u.username)} />
            </View>
          ))}
          {notice && (
            <Text style={{ fontFamily: F.body, fontSize: 13, color: C.brown, marginTop: 10 }}>{notice}</Text>
          )}
        </DoodleCard>

        {incoming.length > 0 && (
          <>
            <View style={{ marginTop: 16, marginBottom: 6 }}>
              <OutlinedText size={20} color={C.labelOrange} outline={C.white} thickness={2}>
                Wants to be friends
              </OutlinedText>
            </View>
            {incoming.map((f, i) => (
              <DoodleCard key={f.username} seed={i * 3 + 30} style={{ marginBottom: 10, flexDirection: 'row', alignItems: 'center' }}>
                <Avatar color={f.color} species={f.species} equipped={f.equipped} size={46} />
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={{ fontFamily: F.display, fontSize: 15, color: C.darkInk }}>{f.name}</Text>
                  <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.fadedInk }}>@{f.username}</Text>
                </View>
                <DoodleButton label="Accept" size={13} seed={i + 41} bg={C.yellow} border={C.brown}
                  onPress={() => accept(f.username)} />
              </DoodleCard>
            ))}
          </>
        )}

        <View style={{ marginTop: 16, marginBottom: 6 }}>
          <OutlinedText size={20} color={C.labelGreen} outline={C.white} thickness={2}>
            {`Your friends (${friends.length})`}
          </OutlinedText>
        </View>
        {friends.length === 0 && (
          <Text style={{ fontFamily: F.body, fontSize: 14, color: C.brown }}>
            No friends yet. Search a username above to send a request.
          </Text>
        )}
        {friends.map((f, i) => (
          <FriendRow
            key={f.username}
            f={f}
            seed={i * 5 + 50}
            onPress={() => nav.push({ name: 'friendCard', username: f.username })}
          />
        ))}

        {outgoing.length > 0 && (
          <>
            <View style={{ marginTop: 12, marginBottom: 6 }}>
              <OutlinedText size={18} color={C.labelPurple} outline={C.white} thickness={2}>
                Waiting on them
              </OutlinedText>
            </View>
            {outgoing.map((f) => (
              <Text key={f.username} style={{ fontFamily: F.body, fontSize: 13.5, color: C.brown, marginBottom: 4 }}>
                {f.name} (@{f.username}) has not accepted yet
              </Text>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}
