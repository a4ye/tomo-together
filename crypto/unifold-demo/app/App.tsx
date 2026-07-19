import 'react-native-gesture-handler';
import React, { useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { UnifoldProvider } from '@unifold/connect-react-native';
import { UNIFOLD_PK } from './src/constants';
import HomeScreen from './src/screens/HomeScreen';
import WithdrawScreen from './src/screens/WithdrawScreen';
import EventsScreen from './src/screens/EventsScreen';

// Unifold's client Deposit SDK powers "Add funds" (beginDeposit) — multi-chain,
// gas-sponsored, connect-exchange. Requires an Expo DEV BUILD (native modules);
// Expo Go will NOT work. Run: npx expo run:ios (or run:android).
type Screen = 'home' | 'withdraw' | 'events';

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <UnifoldProvider
        publishableKey={UNIFOLD_PK}
        config={{
          appearance: 'auto',
          modalTitle: 'Fund your stake',
          accentColor: '#7a3ff2', // brand the deposit modal to match the app
          // Curated deposit methods (not just defaults):
          enableTransferCrypto: true, // send USDC from any chain / Coinbase
          enableFiatOnramp: true, // buy with card
          enableCoinbaseApplePay: true, // iOS — Coinbase-backed Apple Pay
          enableStripeLink: false, // skip extra native Stripe setup for the demo
        }}
      >
        {screen === 'withdraw' ? (
          <WithdrawScreen onBack={() => setScreen('home')} />
        ) : screen === 'events' ? (
          <EventsScreen onBack={() => setScreen('home')} />
        ) : (
          <HomeScreen onWithdraw={() => setScreen('withdraw')} onEvents={() => setScreen('events')} />
        )}
      </UnifoldProvider>
    </GestureHandlerRootView>
  );
}
