import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import OutlinedText from '../components/OutlinedText';
import YardBackground from '../components/YardBackground';
import Polaroid from '../components/Polaroid';
import TopBar from '../components/TopBar';
import { useNav } from '../state/nav';
import { useSession } from '../state/session';
import { C, F } from '../theme';
import { Hangout } from '../types';

const PER_PAGE = 6;

export default function MemoryBookScreen() {
  const { api, me, serverUrl } = useSession();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const [memories, setMemories] = useState<Hangout[]>([]);
  const [page, setPage] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    return api.memories().then((r) => setMemories(r.memories)).catch(() => {});
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const pages = Math.max(1, Math.ceil(memories.length / PER_PAGE));
  const shown = memories.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);

  return (
    <View style={{ flex: 1 }}>
      <YardBackground bg={C.tan} tint={C.tanPaw} seed={51} />
      <View style={{ paddingTop: insets.top }}>
        <TopBar title="Memory Book" />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 14 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[C.orange]} />
        }
      >
        {memories.length === 0 ? (
          <View style={{ alignItems: 'center', marginTop: 60 }}>
            <Text style={{ fontFamily: F.body, fontSize: 15, color: C.brown, textAlign: 'center' }}>
              No memories yet.{'\n'}Hang out, take the photo, confirm together.
            </Text>
          </View>
        ) : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
            {shown.map((m, i) => {
              const others = m.members.filter((x) => x.username !== me?.username).map((x) => x.name);
              return (
                <Pressable
                  key={m.id}
                  onPress={() => nav.push({ name: 'hangoutDetail', hangoutId: m.id })}
                  style={{ width: '48%', marginBottom: 16 }}
                >
                  <Polaroid
                    seed={page * 11 + i * 3 + 2}
                    width="100%"
                    photoUri={m.photoUrl ? `${serverUrl}${m.photoUrl}` : undefined}
                    caption={`${m.activityLabel} with ${others.join(', ')}`}
                  />
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>

      <View
        style={{
          flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center',
          paddingHorizontal: 20, paddingBottom: insets.bottom + 16,
        }}
      >
        <Pressable onPress={() => setPage((p) => Math.max(0, p - 1))} hitSlop={10}>
          <OutlinedText size={34} color={C.white} outline={C.darkInk} thickness={2.5} style={{ marginRight: 14 }}>
            {'<'}
          </OutlinedText>
        </Pressable>
        <OutlinedText size={26} color={C.yellow} outline={C.white} thickness={2.5}>
          {`Page ${page + 1} / ${pages}`}
        </OutlinedText>
        <Pressable onPress={() => setPage((p) => Math.min(pages - 1, p + 1))} hitSlop={10}>
          <OutlinedText size={34} color={C.white} outline={C.darkInk} thickness={2.5} style={{ marginLeft: 14 }}>
            {'>'}
          </OutlinedText>
        </Pressable>
      </View>
    </View>
  );
}
