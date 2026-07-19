import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AcornPill, { AcornIcon } from '../components/Acorn';
import Avatar from '../components/Avatar';
import { DoodleCard } from '../components/Doodle';
import YardBackground from '../components/YardBackground';
import TopBar from '../components/TopBar';
import { useSession } from '../state/session';
import { C, F } from '../theme';
import { WardrobeItem } from '../types';

const COLORS = ['#A8D8C8', '#F5B8A0', '#C9B8E8', '#A0C8E8', '#F0D890', '#F0B8D0'];

export default function WardrobeScreen() {
  const { api, me, setMe } = useSession();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<WardrobeItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api.catalog().then((r) => setItems(r.items)).catch(() => {});
  }, [api]);

  if (!me) return null;

  const saveAvatar = async (color: string, equipped: string[]) => {
    try {
      const { me: m } = await api.setAvatar({ color, equipped });
      setMe(m);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not save');
    }
  };

  const toggleEquip = (id: string) => {
    const next = me.equipped.includes(id)
      ? me.equipped.filter((x) => x !== id)
      : [...me.equipped, id];
    saveAvatar(me.color, next);
  };

  const buy = async (item: WardrobeItem) => {
    setNotice(null);
    try {
      const { me: m } = await api.buyItem(item.id);
      setMe(m);
      setNotice(`${item.name} is yours`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not buy');
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <YardBackground bg={C.green} tint={C.greenPaw} seed={61} />
      <View style={{ paddingTop: insets.top }}>
        <TopBar title="Wardrobe" />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30 }}>
        <DoodleCard seed={2} style={{ alignItems: 'center' }}>
          <Avatar color={me.color} equipped={me.equipped} size={130} />
          <View style={{ flexDirection: 'row', marginTop: 6 }}>
            {COLORS.map((c) => (
              <Pressable key={c} onPress={() => saveAvatar(c, me.equipped)}>
                <View
                  style={{
                    width: 30, height: 30, borderRadius: 15, margin: 3, backgroundColor: c,
                    borderWidth: 3, borderColor: me.color === c ? C.darkInk : '#CBD8A0',
                  }}
                />
              </Pressable>
            ))}
          </View>
          <View style={{ position: 'absolute', top: 10, right: 10 }}>
            <AcornPill amount={me.acorns} />
          </View>
        </DoodleCard>

        {notice && (
          <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.brown, textAlign: 'center', marginTop: 8 }}>
            {notice}
          </Text>
        )}

        <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.brown, textAlign: 'center', marginTop: 8 }}>
          Earn acorns by leveling up your vibe with friends.
        </Text>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 10 }}>
          {items.map((item, i) => {
            const owned = me.owned.includes(item.id);
            const equipped = me.equipped.includes(item.id);
            return (
              <DoodleCard key={item.id} seed={i * 5 + 7} style={{ width: '48%', marginBottom: 12, alignItems: 'center' }}>
                <Avatar color="#EFE8D8" equipped={[item.id]} size={76} />
                <Text style={{ fontFamily: F.display, fontSize: 14, color: C.darkInk, marginTop: 2 }}>
                  {item.name}
                </Text>
                {owned ? (
                  <Pressable onPress={() => toggleEquip(item.id)} style={{ marginTop: 6 }}>
                    <View
                      style={{
                        backgroundColor: equipped ? C.yellow : C.white,
                        borderWidth: 2.5, borderColor: equipped ? C.brown : '#CBD8A0',
                        borderRadius: 12, paddingVertical: 6, paddingHorizontal: 16,
                      }}
                    >
                      <Text style={{ fontFamily: F.display, fontSize: 13, color: C.darkInk }}>
                        {equipped ? 'Wearing' : 'Wear it'}
                      </Text>
                    </View>
                  </Pressable>
                ) : (
                  <Pressable
                    onPress={() => buy(item)}
                    disabled={me.acorns < item.price}
                    style={{ marginTop: 6, opacity: me.acorns < item.price ? 0.45 : 1 }}
                  >
                    <View
                      style={{
                        flexDirection: 'row', alignItems: 'center',
                        backgroundColor: C.white, borderWidth: 2.5, borderColor: C.orange,
                        borderRadius: 12, paddingVertical: 6, paddingHorizontal: 14,
                      }}
                    >
                      <AcornIcon size={16} />
                      <Text style={{ fontFamily: F.display, fontSize: 13, color: C.brown, marginLeft: 5 }}>
                        {item.price}
                      </Text>
                    </View>
                  </Pressable>
                )}
              </DoodleCard>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
