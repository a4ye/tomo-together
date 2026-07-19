import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DoodleButton, DoodleCard } from '../components/Doodle';
import OutlinedText from '../components/OutlinedText';
import YardBackground from '../components/YardBackground';
import TopBar from '../components/TopBar';
import { fmtUsd } from '../money';
import { useSession } from '../state/session';
import { C, F } from '../theme';
import { Wallet } from '../types';

const QUOTAS = [2, 4, 6, 8];
// USDC on Base (matches the treasury's source chain).
const BASE_USDC = {
  chain_type: 'ethereum',
  chain_id: '8453',
  token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};

export default function DepositScreen() {
  const { api } = useSession();
  const insets = useSafeAreaInsets();
  const [quota, setQuota] = useState(4);
  const [thisMonth, setThisMonth] = useState<number | null>(null);

  // real USDC wallet
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [depositAddr, setDepositAddr] = useState<string | null>(null);
  const [cashOutAddr, setCashOutAddr] = useState('');
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletMsg, setWalletMsg] = useState<string | null>(null);

  const loadWallet = () => api.wallet().then(setWallet).catch(() => {});
  useEffect(() => { loadWallet(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addFunds = async () => {
    setWalletBusy(true); setWalletMsg(null);
    try {
      const r = await api.addFunds();
      const addr = (r.depositAddresses as { address?: string }[] | undefined)?.[0]?.address
        || r.treasuryAddress || null;
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
    if (!cashOutAddr.trim()) { setWalletMsg('Enter a wallet address'); return; }
    setWalletBusy(true); setWalletMsg(null);
    try {
      await api.withdraw(String(wallet?.balanceUnits ?? '0'), {
        ...BASE_USDC, recipient_address: cashOutAddr.trim(),
      });
      await loadWallet();
      setWalletMsg('Cash-out sent! It arrives on Base shortly.');
    } catch (e) {
      setWalletMsg(e instanceof Error ? e.message : 'Cash-out failed');
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
                <Text selectable style={{ fontFamily: F.body, fontSize: 12, color: C.darkInk, marginTop: 2 }}>
                  {depositAddr}
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
                  label={walletBusy ? 'Working' : `Cash out ${fmtUsd(wallet.balanceUnits)}`}
                  seed={5} disabled={walletBusy || !wallet.readyToCashOut}
                  onPress={cashOut}
                />
              </View>
              {!wallet.readyToCashOut && (
                <Text style={{ fontFamily: F.body, fontSize: 11.5, color: C.fadedInk, marginTop: 4 }}>
                  Cash out unlocks at {fmtUsd(wallet.cashoutThresholdUnits)} (batches the on-chain fee).
                </Text>
              )}
            </View>
            {walletMsg && (
              <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.brown, marginTop: 8 }}>{walletMsg}</Text>
            )}
          </DoodleCard>
        )}

        <DoodleCard seed={3}>
          <Text style={{ fontFamily: F.display, fontSize: 16, color: C.darkInk }}>
            Put money where your friends are
          </Text>
          <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.brown, marginTop: 6 }}>
            Stake USDC when you plan a hangout. Everyone who shows up gets their stake back;
            whoever flakes loses theirs to the friends who came. Add funds or cash out above
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
