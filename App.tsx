import { Baloo2_700Bold, Baloo2_800ExtraBold } from '@expo-google-fonts/baloo-2';
import { Delius_400Regular } from '@expo-google-fonts/delius';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import YardBackground from './src/components/YardBackground';
import { NavProvider, useNav } from './src/state/nav';
import { SessionProvider, useSession } from './src/state/session';
import { C } from './src/theme';
import { Route } from './src/types';

import DepositScreen from './src/screens/DepositScreen';
import FriendCardScreen from './src/screens/FriendCardScreen';
import FriendProfileScreen from './src/screens/FriendProfileScreen';
import FriendsScreen from './src/screens/FriendsScreen';
import HangoutDetailScreen from './src/screens/HangoutDetailScreen';
import HangoutsScreen from './src/screens/HangoutsScreen';
import LeaderboardScreen from './src/screens/LeaderboardScreen';
import ConfirmScreen from './src/screens/ConfirmScreen';
import MemoryBookScreen from './src/screens/MemoryBookScreen';
import NewHangoutScreen from './src/screens/NewHangoutScreen';
import OnboardingScreen from './src/screens/OnboardingScreen';
import PhotoScreen from './src/screens/PhotoScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import WardrobeScreen from './src/screens/WardrobeScreen';
import YardScreen from './src/screens/YardScreen';

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case 'yard': return <YardScreen />;
    case 'friends': return <FriendsScreen />;
    case 'friendCard': return <FriendCardScreen username={route.username} />;
    case 'friendProfile': return <FriendProfileScreen username={route.username} />;
    case 'hangouts': return <HangoutsScreen />;
    case 'newHangout': return <NewHangoutScreen preselect={route.preselect} />;
    case 'hangoutDetail': return <HangoutDetailScreen hangoutId={route.hangoutId} />;
    case 'photo': return <PhotoScreen hangoutId={route.hangoutId} />;
    case 'confirm':
      return (
        <ConfirmScreen
          hangoutId={route.hangoutId}
          otherUsername={route.otherUsername}
          otherName={route.otherName}
        />
      );
    case 'memoryBook': return <MemoryBookScreen />;
    case 'leaderboard': return <LeaderboardScreen />;
    case 'wardrobe': return <WardrobeScreen />;
    case 'deposit': return <DepositScreen />;
    case 'profile': return <ProfileScreen />;
  }
}

function Navigator() {
  const nav = useNav();
  const { refreshMe } = useSession();
  const pop = useRef(new Animated.Value(1)).current;
  const key = JSON.stringify(nav.route);

  useEffect(() => {
    pop.setValue(0);
    Animated.spring(pop, { toValue: 1, useNativeDriver: true, speed: 26, bounciness: 7 }).start();
  }, [key, pop]);

  useEffect(() => {
    if (nav.route.name === 'yard') refreshMe();
  }, [nav.route, refreshMe]);

  return (
    <View style={{ flex: 1, backgroundColor: C.tan }}>
      <Animated.View
        key={key}
        style={{
          flex: 1,
          opacity: pop,
          transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }],
        }}
      >
        <Screen route={nav.route} />
      </Animated.View>
    </View>
  );
}

function Root() {
  const { ready, token, me } = useSession();
  if (!ready) {
    return <YardBackground bg={C.tan} tint={C.tanPaw} />;
  }
  if (!token || !me) {
    return <OnboardingScreen />;
  }
  return (
    <NavProvider>
      <Navigator />
    </NavProvider>
  );
}

export default function App() {
  const [fontsLoaded] = useFonts({
    Baloo2_800ExtraBold,
    Baloo2_700Bold,
    Delius_400Regular,
    SproutPixel: require('./assets/fonts/SproutPixel.ttf'),
  });

  if (!fontsLoaded) {
    return <View style={{ flex: 1, backgroundColor: C.tan }} />;
  }

  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="dark" />
        <Root />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
