import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DoodleButton, DoodleCard } from '../components/Doodle';
import { InterestPicker } from '../components/InterestChips';
import TopBar from '../components/TopBar';
import YardBackground from '../components/YardBackground';
import { useNav } from '../state/nav';
import { useSession } from '../state/session';
import { C, F } from '../theme';
import { Activity } from '../types';

export default function InterestsScreen() {
  const { api, me, setMe } = useSession();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const [activities, setActivities] = useState<Activity[]>([]);
  const [picked, setPicked] = useState<string[]>(me?.interests ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.catalog().then((r) => setActivities(r.activities)).catch(() => {});
  }, [api]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const { me: updated } = await api.updateInterests(picked);
      setMe(updated);
      nav.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your interests');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <YardBackground bg={C.pink} tint={C.pinkPaw} seed={44} />
      <View style={{ paddingTop: insets.top }}>
        <TopBar title="Your interests" />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30 }}>
        <DoodleCard seed={6}>
          <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.brown, marginBottom: 10 }}>
            Tap the things you're into. They show on your profile, and Tomo Yard
            suggests these kinds of hangouts to you first.
          </Text>
          <InterestPicker options={activities} value={picked} onChange={setPicked} />
          {error && (
            <Text style={{ fontFamily: F.body, fontSize: 13, color: C.redPin, marginTop: 10 }}>{error}</Text>
          )}
          <View style={{ marginTop: 16 }}>
            <DoodleButton
              label={busy ? 'Saving' : 'Save interests'}
              bg={C.yellow} border={C.brown} seed={9} disabled={busy}
              onPress={save}
            />
          </View>
        </DoodleCard>
      </ScrollView>
    </View>
  );
}
