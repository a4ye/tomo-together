import React, { useState } from 'react';
import {
  KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { makeApi } from '../api';
import Avatar, { SPECIES } from '../components/Avatar';
import { DoodleButton, DoodleCard } from '../components/Doodle';
import OutlinedText from '../components/OutlinedText';
import YardBackground from '../components/YardBackground';
import { DEFAULT_SERVER, useSession } from '../state/session';
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

export default function OnboardingScreen() {
  const { signIn } = useSession();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<'register' | 'login'>('register');
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER);
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [bd, setBd] = useState({ y: '', m: '', d: '' });
  const [password, setPassword] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [species, setSpecies] = useState<string>('cat');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setBusy(true);
    const url = serverUrl.trim().replace(/\/$/, '');
    const api = makeApi(url, null);
    try {
      if (mode === 'register') {
        const birthday = `${bd.y.padStart(4, '0')}-${bd.m.padStart(2, '0')}-${bd.d.padStart(2, '0')}`;
        const res = await api.register({
          username: username.trim().toLowerCase(),
          name: name.trim(),
          birthday,
          password,
          color,
          species,
        });
        signIn(url, res.token, res.me);
      } else {
        const res = await api.login({ username: username.trim().toLowerCase(), password });
        signIn(url, res.token, res.me);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
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

        <DoodleCard seed={4}>
          {/* mode toggle */}
          <View style={{ flexDirection: 'row', marginBottom: 4 }}>
            {(['register', 'login'] as const).map((m) => (
              <Pressable key={m} onPress={() => setMode(m)} style={{ flex: 1 }}>
                <View
                  style={{
                    paddingVertical: 8, alignItems: 'center', borderRadius: 6,
                    marginHorizontal: 3,
                    backgroundColor: mode === m ? C.yellow : C.white,
                    borderWidth: 2.5, borderColor: mode === m ? C.brown : '#C89A62',
                  }}
                >
                  <Text style={{ fontFamily: F.display, fontSize: 14, color: C.darkInk }}>
                    {m === 'register' ? 'New here' : 'Sign in'}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>

          <Label>Username</Label>
          <TextInput
            value={username} onChangeText={setUsername} autoCapitalize="none"
            placeholder="lowercase, letters and numbers" placeholderTextColor={C.fadedInk}
            style={inputStyle}
          />

          {mode === 'register' && (
            <>
              <Label>Your name</Label>
              <TextInput
                value={name} onChangeText={setName}
                placeholder="Shown to your friends" placeholderTextColor={C.fadedInk}
                style={inputStyle}
              />
              <Label>Birthday</Label>
              <View style={{ flexDirection: 'row' }}>
                <TextInput
                  value={bd.y} onChangeText={(y) => setBd((s) => ({ ...s, y }))}
                  placeholder="YYYY" placeholderTextColor={C.fadedInk} keyboardType="number-pad"
                  maxLength={4} style={[inputStyle, { flex: 1.4, marginRight: 6 }]}
                />
                <TextInput
                  value={bd.m} onChangeText={(m) => setBd((s) => ({ ...s, m }))}
                  placeholder="MM" placeholderTextColor={C.fadedInk} keyboardType="number-pad"
                  maxLength={2} style={[inputStyle, { flex: 1, marginRight: 6 }]}
                />
                <TextInput
                  value={bd.d} onChangeText={(d) => setBd((s) => ({ ...s, d }))}
                  placeholder="DD" placeholderTextColor={C.fadedInk} keyboardType="number-pad"
                  maxLength={2} style={[inputStyle, { flex: 1 }]}
                />
              </View>
            </>
          )}

          <Label>Password</Label>
          <TextInput
            value={password} onChangeText={setPassword} secureTextEntry
            placeholder="At least 6 characters" placeholderTextColor={C.fadedInk}
            style={inputStyle}
          />

          {mode === 'register' && (
            <>
              <Label>Your look</Label>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' }}>
                {SPECIES.map((s) => (
                  <Pressable key={s} onPress={() => setSpecies(s)}>
                    <View
                      style={{
                        alignItems: 'center', margin: 3, padding: 4, borderRadius: 6,
                        backgroundColor: species === s ? C.yellow : C.white,
                        borderWidth: 2.5, borderColor: species === s ? C.brown : '#C89A62',
                      }}
                    >
                      <Avatar color={color} species={s} size={52} />
                    </View>
                  </Pressable>
                ))}
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
                <Avatar color={color} species={species} size={74} />
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', flex: 1, marginLeft: 10 }}>
                  {COLORS.map((c) => (
                    <Pressable key={c} onPress={() => setColor(c)}>
                      <View
                        style={{
                          width: 34, height: 34, borderRadius: 6, margin: 4, backgroundColor: c,
                          borderWidth: 3, borderColor: color === c ? C.darkInk : '#C89A62',
                        }}
                      />
                    </Pressable>
                  ))}
                </View>
              </View>
            </>
          )}

          <Label>Server</Label>
          <TextInput
            value={serverUrl} onChangeText={setServerUrl} autoCapitalize="none"
            placeholder="https://ht6.icinoxis.net" placeholderTextColor={C.fadedInk}
            style={inputStyle}
          />

          {error && (
            <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.redPin, marginTop: 10 }}>
              {error}
            </Text>
          )}

          <View style={{ marginTop: 16 }}>
            <DoodleButton
              label={busy ? 'One moment' : mode === 'register' ? 'Start my yard' : 'Sign in'}
              bg={C.yellow} border={C.brown} seed={9} disabled={busy}
              onPress={submit}
            />
          </View>
        </DoodleCard>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
