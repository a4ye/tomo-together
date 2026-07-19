import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Avatar from '../components/Avatar';
import { DoodleCard } from '../components/Doodle';
import YardBackground from '../components/YardBackground';
import TopBar from '../components/TopBar';
import { useSession } from '../state/session';
import { C, F } from '../theme';
import { PublicUser } from '../types';

type Row = PublicUser & { count: number; isMe: boolean };

export default function LeaderboardScreen() {
  const { api, setMe } = useSession();
  const insets = useSafeAreaInsets();
  const [rows, setRows] = useState<Row[]>([]);
  const [month, setMonth] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  // secret: tapping the title rains acorns
  const [burstKey, setBurstKey] = useState(0);
  const burst = useRef(new Animated.Value(0)).current;

  const secretTap = useCallback(() => {
    api.secretAcorns().then((r) => {
      setMe(r.me);
      setBurstKey((k) => k + 1);
      burst.setValue(0);
      Animated.timing(burst, { toValue: 1, duration: 700, useNativeDriver: true }).start();
    }).catch(() => {});
  }, [api, setMe, burst]);

  const load = useCallback(() => {
    return api.leaderboard().then((r) => {
      setRows(r.leaderboard);
      setMonth(new Date(`${r.month}-02`).toLocaleDateString(undefined, { month: 'long' }));
    }).catch(() => {});
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return (
    <View style={{ flex: 1 }}>
      <YardBackground bg={C.pink} tint={C.pinkPaw} seed={44} />
      <View style={{ paddingTop: insets.top }}>
        <TopBar title="Leaderboard" onTitlePress={secretTap} />
        {burstKey > 0 && (
          <Animated.View
            key={burstKey}
            pointerEvents="none"
            style={{
              position: 'absolute', top: 44, alignSelf: 'center',
              opacity: burst.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 1, 0] }),
              transform: [{ translateY: burst.interpolate({ inputRange: [0, 1], outputRange: [0, -30] }) }],
            }}
          >
            <Text style={{ fontFamily: F.display, fontSize: 16, color: C.orange }}>+10 acorns</Text>
          </Animated.View>
        )}
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[C.orange]} />
        }
      >
        <Text style={{ fontFamily: F.body, fontSize: 14, color: C.brown, textAlign: 'center', marginBottom: 12 }}>
          Most hangouts finished in {month || 'this month'}, you and your friends.
        </Text>
        {rows.length === 0 && (
          <Text style={{ fontFamily: F.body, fontSize: 14, color: C.brown, textAlign: 'center' }}>
            Add friends to start a leaderboard.
          </Text>
        )}
        {rows.map((r, i) => (
          <DoodleCard
            key={r.username}
            seed={i * 3 + 5}
            bg={r.isMe ? C.yellow : C.cream}
            style={{ marginBottom: 10, flexDirection: 'row', alignItems: 'center', paddingVertical: 10 }}
          >
            <Text style={{ fontFamily: F.display, fontSize: 20, color: C.brown, width: 34 }}>
              {i + 1}
            </Text>
            <Avatar color={r.color} species={r.species} equipped={r.equipped} size={44} />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={{ fontFamily: F.display, fontSize: 15, color: C.darkInk }}>
                {r.isMe ? 'You' : r.name}
              </Text>
              <Text style={{ fontFamily: F.body, fontSize: 12, color: C.fadedInk }}>@{r.username}</Text>
            </View>
            <Text style={{ fontFamily: F.display, fontSize: 18, color: C.darkInk }}>
              {r.count}
            </Text>
          </DoodleCard>
        ))}
      </ScrollView>
    </View>
  );
}
