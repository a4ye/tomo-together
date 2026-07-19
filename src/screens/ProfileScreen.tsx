import * as Application from 'expo-application';
import React, { useCallback, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AcornPill from '../components/Acorn';
import Avatar from '../components/Avatar';
import { DoodleButton, DoodleCard } from '../components/Doodle';
import YardBackground from '../components/YardBackground';
import TopBar from '../components/TopBar';
import { useNav } from '../state/nav';
import { useSession } from '../state/session';
import { C, F } from '../theme';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Format from the raw YYYY-MM-DD string; Date parsing would shift it by timezone.
function formatBirthday(birthday: string): string {
  const [, m, d] = birthday.split('-');
  return `${MONTHS[Number(m) - 1] ?? '?'} ${Number(d)}`;
}

export default function ProfileScreen() {
  const { me, signOut } = useSession();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const signOutInFlight = useRef(false);

  const handleSignOut = useCallback(async () => {
    if (signOutInFlight.current) return;
    signOutInFlight.current = true;
    setSigningOut(true);
    setSignOutError(null);
    try {
      await signOut();
      nav.home();
    } catch {
      setSignOutError('Could not sign out. Check your connection and try again.');
    } finally {
      signOutInFlight.current = false;
      setSigningOut(false);
    }
  }, [nav, signOut]);

  if (!me) return null;

  return (
    <View style={{ flex: 1 }}>
      <YardBackground bg={C.pink} tint={C.pinkPaw} seed={71} />
      <View style={{ paddingTop: insets.top }}>
        <TopBar title="You" />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30 }}>
        <DoodleCard seed={2} style={{ alignItems: 'center' }}>
          <Avatar color={me.color} species={me.species} equipped={me.equipped} size={140} />
          <Text style={{ fontFamily: F.display, fontSize: 22, color: C.darkInk, marginTop: 4 }}>
            {me.name}
          </Text>
          <Text style={{ fontFamily: F.body, fontSize: 14, color: C.fadedInk }}>@{me.username}</Text>
          <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.brown, marginTop: 4 }}>
            Birthday {formatBirthday(me.birthday)}
          </Text>
          <AcornPill amount={me.acorns} style={{ marginTop: 10 }} />
        </DoodleCard>

        <View style={{ marginTop: 12 }}>
          <DoodleButton label="Change my look" seed={5} onPress={() => nav.push({ name: 'wardrobe' })} />
        </View>

        <DoodleCard seed={9} style={{ marginTop: 16 }}>
          <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.fadedInk, marginTop: 2 }}>
            App version {Application.nativeApplicationVersion} (build {Application.nativeBuildVersion})
          </Text>
        </DoodleCard>

        <View style={{ marginTop: 16 }}>
          <DoodleButton
            label={signingOut ? 'Signing out…' : 'Sign out'}
            seed={13}
            border={C.redPin}
            color={C.redPin}
            disabled={signingOut}
            onPress={() => { void handleSignOut(); }}
          />
          {signOutError ? (
            <Text
              accessibilityLiveRegion="polite"
              style={{
                fontFamily: F.body,
                fontSize: 13.5,
                color: C.redPin,
                marginTop: 8,
                textAlign: 'center',
              }}
            >
              {signOutError}
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
