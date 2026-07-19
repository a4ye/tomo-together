import React, { useState } from 'react';
import {
  KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Avatar, { SPECIES } from '../components/Avatar';
import { DoodleButton, DoodleCard } from '../components/Doodle';
import OutlinedText from '../components/OutlinedText';
import YardBackground from '../components/YardBackground';
import { useSession } from '../state/session';
import { C, F } from '../theme';

const COLORS = ['#A8D8C8', '#F5B8A0', '#C9B8E8', '#A0C8E8', '#F0D890', '#F0B8D0'];

const inputStyle = {
  backgroundColor: C.white,
  borderWidth: 2.5,
  borderColor: '#C89A62',
  borderRadius: 6,
  paddingHorizontal: 12,
  paddingVertical: 9,
  fontFamily: F.body,
  fontSize: 15,
  color: C.darkInk,
  // react-native-web renders a real <input> with ~180px intrinsic width that
  // refuses to flex-shrink; without this the birthday row overflows on phones.
  minWidth: 0,
  // RN-web TextInputs are statically positioned (unlike View/Text), so the
  // absolutely-positioned 9-slice panel sprites paint over them. No-op native.
  position: 'relative',
} as const;

function Label({ children }: { children: string }) {
  return (
    <Text style={{ fontFamily: F.display, fontSize: 14, color: C.brown, marginTop: 12, marginBottom: 4 }}>
      {children}
    </Text>
  );
}

function messageFor(error: unknown): string | null {
  const code = typeof error === 'object' && error && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';
  if (code.includes('user_cancelled') || code === 'cancelled') return null;
  return error instanceof Error ? error.message : 'Something went wrong';
}

export default function OnboardingScreen() {
  const {
    auth0Authenticated, authConfigurationError, completeProfile, signIn, signOut,
  } = useSession();
  const insets = useSafeAreaInsets();
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [bd, setBd] = useState({ y: '', m: '', d: '' });
  const [color, setColor] = useState(COLORS[0]);
  const [species, setSpecies] = useState<string>('cat');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const authenticate = async () => {
    setError(null);
    setBusy(true);
    try {
      await signIn();
    } catch (authError) {
      setError(messageFor(authError));
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = async () => {
    setError(null);
    setBusy(true);
    try {
      const birthday = `${bd.y.padStart(4, '0')}-${bd.m.padStart(2, '0')}-${bd.d.padStart(2, '0')}`;
      await completeProfile({
        username: username.trim().toLowerCase(),
        name: name.trim(),
        birthday,
        color,
        species,
      });
    } catch (profileError) {
      setError(messageFor(profileError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <YardBackground bg={C.tan} tint={C.tanPaw} seed={3} />
      <ScrollView
        contentContainerStyle={{
          padding: 20, paddingTop: insets.top + 30, paddingBottom: insets.bottom + 30,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ alignItems: 'center', marginBottom: 16 }}>
          <OutlinedText size={40} color={C.white} outline={C.brown} thickness={3}>
            Tomo Yard
          </OutlinedText>
          <Text style={{ fontFamily: F.body, fontSize: 15, color: C.brown, marginTop: 2 }}>
            Fill your yard with real hangouts
          </Text>
        </View>

        {!auth0Authenticated ? (
          <DoodleCard seed={4}>
            <Text style={{ fontFamily: F.display, fontSize: 20, color: C.darkInk, textAlign: 'center' }}>
              Welcome to the yard
            </Text>
            <Text
              style={{
                fontFamily: F.body, fontSize: 14.5, lineHeight: 21, color: C.brown,
                textAlign: 'center', marginTop: 8,
              }}
            >
              Sign in securely to keep your friends, memories, and acorns with you.
            </Text>

            {(error || authConfigurationError) && (
              <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.redPin, marginTop: 12 }}>
                {error || authConfigurationError}
              </Text>
            )}

            <View style={{ marginTop: 18 }}>
              <DoodleButton
                label={busy ? 'Opening secure sign-in' : 'Continue securely'}
                bg={C.yellow}
                border={C.brown}
                seed={9}
                disabled={busy || Boolean(authConfigurationError)}
                onPress={authenticate}
              />
            </View>
            <Text
              style={{
                fontFamily: F.body, fontSize: 11.5, color: C.fadedInk,
                textAlign: 'center', marginTop: 10,
              }}
            >
              Powered by Auth0 Universal Login
            </Text>
          </DoodleCard>
        ) : (
          <DoodleCard seed={4}>
            <Text style={{ fontFamily: F.display, fontSize: 19, color: C.darkInk, textAlign: 'center' }}>
              Make this yard yours
            </Text>
            <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.brown, textAlign: 'center', marginTop: 4 }}>
              Your secure account is ready. Pick the details your friends will see.
            </Text>

            <Label>Username</Label>
            <TextInput
              value={username} onChangeText={setUsername} autoCapitalize="none"
              autoCorrect={false} textContentType="username"
              placeholder="lowercase, letters and numbers" placeholderTextColor={C.fadedInk}
              style={inputStyle}
            />

            <Label>Your name</Label>
            <TextInput
              value={name} onChangeText={setName}
              placeholder="Shown to your friends" placeholderTextColor={C.fadedInk}
              style={inputStyle}
            />

            <Label>Birthday</Label>
            <View style={{ flexDirection: 'row' }}>
              <TextInput
                value={bd.y} onChangeText={(y) => setBd((state) => ({ ...state, y }))}
                placeholder="YYYY" placeholderTextColor={C.fadedInk} keyboardType="number-pad"
                maxLength={4} style={[inputStyle, { flex: 1.4, marginRight: 6 }]}
              />
              <TextInput
                value={bd.m} onChangeText={(m) => setBd((state) => ({ ...state, m }))}
                placeholder="MM" placeholderTextColor={C.fadedInk} keyboardType="number-pad"
                maxLength={2} style={[inputStyle, { flex: 1, marginRight: 6 }]}
              />
              <TextInput
                value={bd.d} onChangeText={(d) => setBd((state) => ({ ...state, d }))}
                placeholder="DD" placeholderTextColor={C.fadedInk} keyboardType="number-pad"
                maxLength={2} style={[inputStyle, { flex: 1 }]}
              />
            </View>

            <Label>Your look</Label>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' }}>
              {SPECIES.map((candidate) => (
                <Pressable key={candidate} onPress={() => setSpecies(candidate)}>
                  <View
                    style={{
                      alignItems: 'center', margin: 3, padding: 4, borderRadius: 6,
                      backgroundColor: species === candidate ? C.yellow : C.white,
                      borderWidth: 2.5, borderColor: species === candidate ? C.brown : '#C89A62',
                    }}
                  >
                    <Avatar color={color} species={candidate} size={52} />
                  </View>
                </Pressable>
              ))}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
              <Avatar color={color} species={species} size={74} />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', flex: 1, marginLeft: 10 }}>
                {COLORS.map((candidate) => (
                  <Pressable key={candidate} onPress={() => setColor(candidate)}>
                    <View
                      style={{
                        width: 34, height: 34, borderRadius: 6, margin: 4, backgroundColor: candidate,
                        borderWidth: 3, borderColor: color === candidate ? C.darkInk : '#C89A62',
                      }}
                    />
                  </Pressable>
                ))}
              </View>
            </View>

            {error && (
              <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.redPin, marginTop: 10 }}>
                {error}
              </Text>
            )}

            <View style={{ marginTop: 16 }}>
              <DoodleButton
                label={busy ? 'Planting your yard' : 'Start my yard'}
                bg={C.yellow} border={C.brown} seed={9} disabled={busy}
                onPress={saveProfile}
              />
            </View>
            <Pressable
              disabled={busy}
              onPress={() => { signOut().catch((signOutError) => setError(messageFor(signOutError))); }}
              style={{ alignItems: 'center', paddingTop: 14, paddingBottom: 2 }}
            >
              <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.fadedInk }}>
                Use a different account
              </Text>
            </Pressable>
          </DoodleCard>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
