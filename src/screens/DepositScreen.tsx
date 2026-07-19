import React, { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DoodleButton, DoodleCard } from '../components/Doodle';
import OutlinedText from '../components/OutlinedText';
import YardBackground from '../components/YardBackground';
import TopBar from '../components/TopBar';
import { fmtUsd } from '../money';
import { ApiError } from '../api';
import { useSession } from '../state/session';
import { C, F } from '../theme';
import { Wallet, WithdrawalDestination } from '../types';

const QUOTAS = [2, 4, 6, 8];
// USDC on Base (matches the treasury's source chain).
const BASE_USDC = {
  chain_type: 'ethereum',
  chain_id: '8453',
  token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};

type WithdrawalIntent = {
  version: 1;
  key: string;
  amountUnits: string;
  destination: WithdrawalDestination;
  createdAt: string;
  state: 'sending' | 'reconciling';
};

const WITHDRAWAL_INTENT_PREFIX = '@tomoyard:withdrawal-intent:v1:';

function newWithdrawalKey(): string {
  const random = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `withdraw-${Date.now().toString(36)}-${random}`.slice(0, 128);
}

function isWithdrawalIntent(value: unknown): value is WithdrawalIntent {
  const intent = value as Partial<WithdrawalIntent> | null;
  return !!intent &&
    intent.version === 1 &&
    typeof intent.key === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(intent.key) &&
    typeof intent.amountUnits === 'string' &&
    /^[1-9]\d*$/.test(intent.amountUnits) &&
    !!intent.destination &&
    typeof intent.destination.chain_type === 'string' &&
    typeof intent.destination.chain_id === 'string' &&
    typeof intent.destination.token_address === 'string' &&
    typeof intent.destination.recipient_address === 'string' &&
    typeof intent.createdAt === 'string' &&
    (intent.state === 'sending' || intent.state === 'reconciling');
}

export default function DepositScreen() {
  const { api, me } = useSession();
  const insets = useSafeAreaInsets();
  const [quota, setQuota] = useState(4);
  const [thisMonth, setThisMonth] = useState<number | null>(null);

  // real USDC wallet
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [depositAddr, setDepositAddr] = useState<string | null>(null);
  const [cashOutAddr, setCashOutAddr] = useState('');
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletMsg, setWalletMsg] = useState<string | null>(null);
  const [withdrawalIntent, setWithdrawalIntent] = useState<WithdrawalIntent | null>(null);
  const withdrawalStorageKey = me ? `${WITHDRAWAL_INTENT_PREFIX}${me.username}` : null;

  const loadWallet = () => api.wallet().then(setWallet).catch(() => setWallet({ enabled: false }));
  useEffect(() => { loadWallet(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let active = true;
    setWithdrawalIntent(null);
    setCashOutAddr('');
    if (!withdrawalStorageKey) return () => { active = false; };
    AsyncStorage.getItem(withdrawalStorageKey).then((raw) => {
      if (!active || !raw) return;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isWithdrawalIntent(parsed)) {
          AsyncStorage.removeItem(withdrawalStorageKey).catch(() => {});
          return;
        }
        const intent = { ...parsed, state: 'reconciling' as const };
        setWithdrawalIntent(intent);
        setCashOutAddr(intent.destination.recipient_address);
        setWalletMsg("Your last cash-out didn't finish sending. Tap the button below to safely finish it.");
      } catch {
        AsyncStorage.removeItem(withdrawalStorageKey).catch(() => {});
      }
    }).catch(() => {});
    return () => { active = false; };
  }, [withdrawalStorageKey]);

  const addFunds = async () => {
    setWalletBusy(true); setWalletMsg(null);
    try {
      const r = await api.addFunds();
      // Unifold returns one deposit address per supported source chain, with no
      // guaranteed order. The user is sending USDC ON BASE, so pick the EVM
      // address (chain_type 'ethereum' — the same 0x wallet receives on any EVM
      // source chain, Base included). is_primary is only the tuple's primary
      // wallet on SOME source chain (it can be e.g. a Solana address), so it is
      // not a safe key for a Base send. Never fall back to a non-EVM address or
      // to treasuryAddress — a Base transfer there would be stranded.
      const list = r.depositAddresses as
        { address?: string; chain_type?: string }[] | undefined;
      const addr =
        list?.find((a) => a.chain_type === 'ethereum' && typeof a.address === 'string')?.address
        ?? null;
      if (!addr) { setWalletMsg('Could not get a Base deposit address. Please try again.'); return; }
      setDepositAddr(addr);
    } catch (e) {
      setWalletMsg(e instanceof Error ? e.message : 'Could not get a deposit address');
    } finally { setWalletBusy(false); }
  };

  const refresh = async () => {
    setWalletBusy(true); setWalletMsg(null);
    try {
      const r = await api.refreshDeposits();
      await loadWallet();
      setWalletMsg(r.creditedUnits && r.creditedUnits !== '0'
        ? `Added ${fmtUsd(r.creditedUnits)} from your deposit` : 'No new deposits found yet');
    } catch (e) {
      setWalletMsg(e instanceof Error ? e.message : 'Could not refresh');
    } finally { setWalletBusy(false); }
  };

  const cashOut = async () => {
    if (!withdrawalStorageKey) { setWalletMsg('Sign in before cashing out'); return; }
    if (!withdrawalIntent && !cashOutAddr.trim()) { setWalletMsg('Enter a wallet address'); return; }
    if (!withdrawalIntent && !/^0x[0-9a-fA-F]{40}$/.test(cashOutAddr.trim())) {
      setWalletMsg("That doesn't look like a wallet address — it should start with 0x and be 42 characters.");
      return;
    }
    setWalletBusy(true); setWalletMsg(null);
    let intent = withdrawalIntent;
    try {
      if (!intent) {
        const amountUnits = String(wallet?.balanceUnits ?? '0');
        if (!/^[1-9]\d*$/.test(amountUnits)) throw new Error('There is no balance to cash out');
        intent = {
          version: 1,
          key: newWithdrawalKey(),
          amountUnits,
          destination: { ...BASE_USDC, recipient_address: cashOutAddr.trim() },
          createdAt: new Date().toISOString(),
          state: 'sending',
        };
        // Persist the exact operation before the first network request. If the
        // response is lost, every retry uses this key and payload byte-for-byte.
        await AsyncStorage.setItem(withdrawalStorageKey, JSON.stringify(intent));
        setWithdrawalIntent(intent);
      }
      const result = await api.withdraw(intent.amountUnits, intent.destination, intent.key);
      // ok:true can still carry a terminal failure — the transfer failed and the
      // balance was refunded. Never report that as "sent".
      if (result.ok && (result.status === 'failed' || result.status === 'refunded')) {
        await AsyncStorage.removeItem(withdrawalStorageKey).catch(() => {});
        setWithdrawalIntent(null);
        await loadWallet();
        setWalletMsg('Cash-out could not be sent — your balance was refunded.');
        return;
      }
      if (result.pending || !result.ok) {
        const pendingIntent = { ...intent, state: 'reconciling' as const };
        // The original durable record already has the exact key and payload;
        // updating its presentation state is best-effort.
        await AsyncStorage.setItem(withdrawalStorageKey, JSON.stringify(pendingIntent)).catch(() => {});
        setWithdrawalIntent(pendingIntent);
        setWalletMsg("Your cash-out hasn't finished sending yet. Tap the button again in a moment to safely finish it.");
        return;
      }
      const cleared = await AsyncStorage.removeItem(withdrawalStorageKey)
        .then(() => true)
        .catch(() => false);
      await loadWallet();
      if (cleared) {
        setWithdrawalIntent(null);
        setWalletMsg('Cash-out sent! It arrives on Base shortly.');
      } else {
        const completedIntent = { ...intent, state: 'reconciling' as const };
        setWithdrawalIntent(completedIntent);
        setWalletMsg('Cash-out succeeded. The saved request could not be cleared yet; retrying it is safe.');
      }
    } catch (e) {
      const ambiguous = e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.status === 409);
      if (intent && ambiguous) {
        const pendingIntent = { ...intent, state: 'reconciling' as const };
        await AsyncStorage.setItem(withdrawalStorageKey, JSON.stringify(pendingIntent)).catch(() => {});
        setWithdrawalIntent(pendingIntent);
        setWalletMsg("We couldn't confirm your cash-out went through. Tap the button again to safely finish it.");
      } else {
        if (intent) {
          await AsyncStorage.removeItem(withdrawalStorageKey).catch(() => {});
          setWithdrawalIntent(null);
        }
        setWalletMsg(e instanceof Error ? e.message : 'Cash-out failed');
      }
    } finally { setWalletBusy(false); }
  };

  useEffect(() => {
    api.leaderboard().then((r) => {
      const meRow = r.leaderboard.find((x) => x.isMe);
      setThisMonth(meRow ? meRow.count : 0);
    }).catch(() => {});
  }, [api]);

  return (
    <View style={{ flex: 1 }}>
      <YardBackground bg={C.tan} tint={C.tanPaw} seed={41} />
      <View style={{ paddingTop: insets.top }}>
        <TopBar title="Deposit" />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30 }}>
        {wallet?.enabled && (
          <DoodleCard seed={2} bg={C.card} style={{ marginBottom: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ fontFamily: F.display, fontSize: 15, color: C.brown }}>Your USDC</Text>
              <Text style={{ fontFamily: F.display, fontSize: 26, color: C.darkInk }}>
                {fmtUsd(wallet.balanceUnits)}
              </Text>
            </View>
            <Text style={{ fontFamily: F.body, fontSize: 12, color: C.fadedInk, marginTop: 2 }}>
              Real USDC on Base, held in the Tomo treasury. Stake it on hangouts, cash out anytime.
            </Text>
            <View style={{ flexDirection: 'row', marginTop: 10 }}>
              <DoodleButton label="Add funds" size={13} seed={3} onPress={addFunds}
                disabled={walletBusy} style={{ marginRight: 8 }} />
              <DoodleButton label="Refresh" size={13} seed={4} onPress={refresh} disabled={walletBusy} />
            </View>
            {depositAddr && (
              <View style={{ marginTop: 10 }}>
                <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.brown }}>
                  Send USDC (Base) to this address, then tap Refresh:
                </Text>
                <View style={{ alignItems: 'center', marginTop: 8 }}>
                  <QRCode value={depositAddr} size={160} color={C.darkInk} backgroundColor={C.white} />
                </View>
                <Text selectable style={{ fontFamily: F.body, fontSize: 12, color: C.darkInk, marginTop: 8 }}>
                  {depositAddr}
                </Text>
                <Text style={{ fontFamily: F.body, fontSize: 12, color: C.labelOrange, marginTop: 4 }}>
                  Only USDC on the Base network — any other token or network will be lost.
                </Text>
              </View>
            )}
            <View style={{ marginTop: 12 }}>
              <Text style={{ fontFamily: F.display, fontSize: 13, color: C.brown, marginBottom: 4 }}>
                Cash out to a wallet
              </Text>
              <TextInput
                value={cashOutAddr}
                onChangeText={setCashOutAddr}
                editable={!withdrawalIntent}
                autoCapitalize="none"
                placeholder="0x… (USDC on Base)"
                placeholderTextColor={C.fadedInk}
                style={{
                  backgroundColor: C.white, borderWidth: 2.5, borderColor: '#C89A62', borderRadius: 6,
                  paddingHorizontal: 12, paddingVertical: 9, fontFamily: F.body, fontSize: 13, color: C.darkInk,
                }}
              />
              <View style={{ marginTop: 8 }}>
                <DoodleButton
                  label={walletBusy
                    ? 'Working'
                    : withdrawalIntent
                      ? `Finish ${fmtUsd(withdrawalIntent.amountUnits)} cash-out`
                      : `Cash out ${fmtUsd(wallet.balanceUnits)}`}
                  seed={5} disabled={walletBusy || (!withdrawalIntent && !wallet.readyToCashOut)}
                  onPress={cashOut}
                />
              </View>
              {withdrawalIntent && (
                <Text style={{ fontFamily: F.body, fontSize: 11.5, color: C.labelOrange, marginTop: 4 }}>
                  This saved request keeps the same safety key and amount until its outcome is final.
                </Text>
              )}
              {!withdrawalIntent && !wallet.readyToCashOut && (
                <Text style={{ fontFamily: F.body, fontSize: 11.5, color: C.fadedInk, marginTop: 4 }}>
                  Cash out unlocks at {fmtUsd(wallet.cashoutThresholdUnits)} (batches the on-chain fee).
                </Text>
              )}
              {!!wallet.withdrawals?.length && (
                <View style={{ marginTop: 8 }}>
                  <Text style={{ fontFamily: F.display, fontSize: 12.5, color: C.brown }}>Past cash-outs</Text>
                  {wallet.withdrawals.map((w) => (
                    <Text key={w.id} style={{ fontFamily: F.body, fontSize: 12, color: C.fadedInk, marginTop: 2 }}>
                      {fmtUsd(w.amountUnits)} — {w.status}
                    </Text>
                  ))}
                </View>
              )}
            </View>
            {walletMsg && (
              <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.brown, marginTop: 8 }}>{walletMsg}</Text>
            )}
          </DoodleCard>
        )}

        {wallet && !wallet.enabled && (
          <DoodleCard seed={2} bg={C.card} style={{ marginBottom: 12 }}>
            <Text style={{ fontFamily: F.body, fontSize: 13, color: C.brown }}>
              Your USDC wallet is unavailable right now.
            </Text>
            <View style={{ marginTop: 10 }}>
              <DoodleButton label="Try again" size={13} seed={3} onPress={loadWallet} />
            </View>
          </DoodleCard>
        )}

        <DoodleCard seed={3}>
          <Text style={{ fontFamily: F.display, fontSize: 16, color: C.darkInk }}>
            Put money where your friends are
          </Text>
          <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.brown, marginTop: 6 }}>
            Stake USDC when you plan a hangout. Everyone who shows up gets their stake back;
            whoever flakes loses theirs to the friends who came. Add funds or cash out
            anytime.
          </Text>
        </DoodleCard>

        <View style={{ marginTop: 14, marginBottom: 6 }}>
          <OutlinedText size={20} color={C.labelGreen} outline={C.white} thickness={2}>
            Monthly goal
          </OutlinedText>
        </View>
        <DoodleCard seed={7}>
          <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.fadedInk, marginBottom: 8 }}>
            Coming soon: lock a deposit against a monthly hangout goal. For now, here is your pace.
          </Text>
          <View style={{ flexDirection: 'row' }}>
            {QUOTAS.map((q) => (
              <Pressable key={q} onPress={() => setQuota(q)} style={{ flex: 1 }}>
                <View
                  style={{
                    alignItems: 'center', marginHorizontal: 3, paddingVertical: 10, borderRadius: 6,
                    backgroundColor: quota === q ? C.yellow : C.white,
                    borderWidth: 2.5, borderColor: quota === q ? C.brown : '#C89A62',
                  }}
                >
                  <Text style={{ fontFamily: F.display, fontSize: 17, color: C.darkInk }}>{q}</Text>
                </View>
              </Pressable>
            ))}
          </View>
          <Text style={{ fontFamily: F.body, fontSize: 13, color: C.brown, marginTop: 8 }}>
            hangouts per month
          </Text>
          {thisMonth != null && (
            <Text style={{ fontFamily: F.display, fontSize: 13.5, color: C.labelBlue, marginTop: 4 }}>
              So far this month: {thisMonth} of {quota}
            </Text>
          )}
        </DoodleCard>
      </ScrollView>
    </View>
  );
}
