import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DoodleButton, DoodleCard } from '../components/Doodle';
import OutlinedText from '../components/OutlinedText';
import YardBackground from '../components/YardBackground';
import TopBar from '../components/TopBar';
import { useSession } from '../state/session';
import { C, F } from '../theme';

const QUOTAS = [2, 4, 6, 8];
const DEPOSIT_KEY = 'tomo.deposit';

type Deposit = { amount: number; quota: number; lockedAt: string };

export default function DepositScreen() {
  const { api } = useSession();
  const insets = useSafeAreaInsets();
  const [amount, setAmount] = useState('');
  const [quota, setQuota] = useState(4);
  const [thisMonth, setThisMonth] = useState<number | null>(null);
  const [locked, setLocked] = useState<Deposit | null>(null);

  useEffect(() => {
    api.leaderboard().then((r) => {
      const meRow = r.leaderboard.find((x) => x.isMe);
      setThisMonth(meRow ? meRow.count : 0);
    }).catch(() => {});
  }, [api]);

  useEffect(() => {
    AsyncStorage.getItem(DEPOSIT_KEY).then((raw) => {
      if (!raw) return;
      try {
        const d = JSON.parse(raw) as Deposit;
        if (typeof d.amount === 'number' && typeof d.quota === 'number') {
          setLocked(d);
          setAmount(String(d.amount));
          setQuota(d.quota);
        }
      } catch {}
    }).catch(() => {});
  }, []);

  const parsedAmount = parseFloat(amount);
  const amountOk = Number.isFinite(parsedAmount) && parsedAmount > 0;

  const lock = () => {
    if (!amountOk) return;
    const d: Deposit = {
      amount: Math.round(parsedAmount * 100) / 100,
      quota,
      lockedAt: new Date().toISOString(),
    };
    AsyncStorage.setItem(DEPOSIT_KEY, JSON.stringify(d)).catch(() => {});
    setLocked(d);
  };

  const clear = () => {
    AsyncStorage.removeItem(DEPOSIT_KEY).catch(() => {});
    setLocked(null);
  };

  return (
    <View style={{ flex: 1 }}>
      <YardBackground bg={C.tan} tint={C.tanPaw} seed={41} />
      <View style={{ paddingTop: insets.top }}>
        <TopBar title="Deposit" />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30 }}>
        <DoodleCard seed={3}>
          <Text style={{ fontFamily: F.display, fontSize: 16, color: C.darkInk }}>
            Put money where your friends are
          </Text>
          <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.brown, marginTop: 6 }}>
            Deposit crypto and set a monthly hangout goal. Meet the goal to reclaim your deposit
            for the month. You never lose the money, it just stays locked until you show up enough.
          </Text>
        </DoodleCard>

        {locked && (
          <DoodleCard seed={4} bg={C.card} style={{ marginTop: 12 }}>
            <Text style={{ fontFamily: F.display, fontSize: 15, color: C.darkInk }}>
              Locked: ${locked.amount} USDC · goal {locked.quota} hangouts
            </Text>
            {thisMonth != null && (
              <Text style={{ fontFamily: F.body, fontSize: 13, color: C.brown, marginTop: 3 }}>
                {thisMonth} of {locked.quota} hangouts this month
              </Text>
            )}
            <Pressable onPress={clear} style={{ marginTop: 6, alignSelf: 'flex-start' }}>
              <Text
                style={{
                  fontFamily: F.body, fontSize: 12.5, color: C.fadedInk,
                  textDecorationLine: 'underline',
                }}
              >
                Unlock and clear (preview)
              </Text>
            </Pressable>
          </DoodleCard>
        )}

        <View style={{ marginTop: 14, marginBottom: 6 }}>
          <OutlinedText size={20} color={C.labelBlue} outline={C.white} thickness={2}>
            Deposit amount
          </OutlinedText>
        </View>
        <DoodleCard seed={5}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <TextInput
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={C.fadedInk}
              style={{
                flex: 1, backgroundColor: C.white, borderWidth: 2.5, borderColor: '#C89A62',
                borderRadius: 6, paddingHorizontal: 12, paddingVertical: 9,
                fontFamily: F.display, fontSize: 18, color: C.darkInk,
              }}
            />
            <Text style={{ fontFamily: F.display, fontSize: 16, color: C.brown, marginLeft: 10 }}>USDC</Text>
          </View>
        </DoodleCard>

        <View style={{ marginTop: 14, marginBottom: 6 }}>
          <OutlinedText size={20} color={C.labelGreen} outline={C.white} thickness={2}>
            Monthly goal
          </OutlinedText>
        </View>
        <DoodleCard seed={7}>
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

        <View style={{ marginTop: 18 }}>
          <DoodleButton
            label={locked ? 'Update deposit' : 'Deposit'}
            bg={C.yellow} border={C.brown} seed={11}
            disabled={!amountOk}
            onPress={lock}
          />
          <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.fadedInk, textAlign: 'center', marginTop: 8 }}>
            Deposits are not live yet. This is a preview of how it will work.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}
