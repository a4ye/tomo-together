import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useUnifold } from '@unifold/connect-react-native';
import { errMsg, formatUsdc, toUnits, CASHOUT_THRESHOLD_UNITS, DESTINATIONS } from '../constants';
import { adjust, getTreasury, getUser, refreshDeposits, registerUser } from '../api';
import { getOrCreateUserId, resetUser } from '../user';

export default function HomeScreen({
  onWithdraw,
  onEvents,
}: {
  onWithdraw: () => void;
  onEvents: () => void;
}) {
  const { beginDeposit } = useUnifold();
  const [userId, setUserId] = useState<string>('');
  const [balanceUnits, setBalanceUnits] = useState<string>('0');
  const [amount, setAmount] = useState<string>('4');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>('');

  const load = useCallback(async () => {
    const id = await getOrCreateUserId();
    setUserId(id);
    await registerUser(id);
    const u = await getUser(id);
    setBalanceUnits(u.balanceUnits);
    return id;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await load();
      } catch (e: any) {
        setStatus('Init error: ' + errMsg(e));
      }
    })();
  }, [load]);

  // External-input monthly adjustment: sign +1 credits, -1 debits. Floors at 0.
  const onAdjust = useCallback(
    async (sign: 1 | -1) => {
      if (!userId) return;
      const parsed = parseFloat(amount);
      if (!isFinite(parsed) || parsed <= 0) {
        setStatus('Enter a valid amount.');
        return;
      }
      const deltaUnits = String(sign * Number(toUnits(amount)));
      setBusy(true);
      setStatus(sign > 0 ? 'Crediting…' : 'Debiting…');
      try {
        const r = await adjust(userId, deltaUnits);
        setBalanceUnits(r.balanceUnits);
        setStatus(
          `Applied ${formatUsdc(r.appliedUnits)} USDC${r.clamped ? ' (clamped at $0)' : ''}.`
        );
      } catch (e: any) {
        setStatus('Adjust error: ' + errMsg(e));
      } finally {
        setBusy(false);
      }
    },
    [userId, amount]
  );

  // Fund via Unifold's client Deposit SDK — multi-chain, gas-sponsored, connect-exchange.
  // Funds route to the treasury (tagged with externalUserId); we credit on success.
  const onFund = useCallback(async () => {
    if (!userId) return;
    setBusy(true);
    setStatus('Opening Unifold deposit…');
    try {
      const t = await getTreasury();
      if (!t.address) {
        setStatus('Treasury unavailable: ' + (t.error ?? 'no address'));
        setBusy(false);
        return;
      }
      const dest = DESTINATIONS[0]; // USDC on Base
      await beginDeposit({
        externalUserId: userId,
        destinationChainType: dest.chain_type,
        destinationChainId: dest.chain_id,
        destinationTokenAddress: dest.token_address,
        destinationTokenSymbol: 'USDC',
        recipientAddress: t.address,
        showBalance: true, // show the destination balance in the modal
        initialScreen: 'main', // open the deposit menu (set 'card'/'transfer' to jump straight in)
        onSuccess: async () => {
          const r = await refreshDeposits(userId);
          setBalanceUnits(r.balanceUnits);
          setStatus(`Deposit complete — credited +$${formatUsdc(r.creditedUnits)} ✓`);
        },
        onError: (e: any) => setStatus('Deposit error: ' + errMsg(e)),
      });
    } catch {
      // beginDeposit rejects when the user closes the modal — that's normal.
      setStatus('Deposit closed. Tap “Refresh balance” if funds already sent.');
    } finally {
      setBusy(false);
    }
  }, [userId, beginDeposit]);

  const onCheckDeposit = useCallback(async () => {
    if (!userId) return;
    setBusy(true);
    setStatus('Checking for deposits…');
    try {
      const r = await refreshDeposits(userId);
      setBalanceUnits(r.balanceUnits);
      setStatus(
        Number(r.creditedUnits) > 0
          ? `Deposit credited: +$${formatUsdc(r.creditedUnits)} ✓`
          : 'No new deposits yet — send USDC on Base, then check again.'
      );
    } catch (e: any) {
      setStatus('Check error: ' + errMsg(e));
    } finally {
      setBusy(false);
    }
  }, [userId]);

  const onReset = useCallback(async () => {
    setBusy(true);
    setStatus('Resetting user…');
    setBalanceUnits('0');
    try {
      await resetUser();
      await load();
      setStatus('Fresh user created.');
    } catch (e: any) {
      setStatus('Reset error: ' + errMsg(e));
    } finally {
      setBusy(false);
    }
  }, [load]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Unifold Bank</Text>
      <Text style={styles.subtitle}>Balance held in Unifold treasury</Text>

      {(() => {
        const n = BigInt(balanceUnits || '0');
        const negative = n < 0n;
        const abs = (negative ? -n : n).toString();
        const ready = n >= BigInt(CASHOUT_THRESHOLD_UNITS);
        return (
          <View style={styles.balanceBox}>
            <Text style={[styles.balanceNum, negative && styles.owe]}>
              {negative ? '−' : ''}${formatUsdc(abs)}
            </Text>
            <Text style={styles.balanceLabel}>{negative ? 'you owe' : 'USDC available'}</Text>
            <Text style={styles.caption}>
              {ready
                ? '✓ Ready to cash out (owed $20+)'
                : 'Settles on-chain at $20 — no fees until then'}
            </Text>
          </View>
        );
      })()}

      <Text style={styles.userId}>{userId || 'Loading…'}</Text>

      <Text style={styles.section}>Monthly adjustment (external input)</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="USDC"
          editable={!busy}
        />
        <TouchableOpacity
          style={[styles.smallBtn, styles.creditBtn, busy && styles.btnDisabled]}
          onPress={() => onAdjust(1)}
          disabled={busy}
        >
          <Text style={styles.smallBtnText}>Credit +</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.smallBtn, styles.debitBtn, busy && styles.btnDisabled]}
          onPress={() => onAdjust(-1)}
          disabled={busy}
        >
          <Text style={styles.smallBtnText}>Debit −</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[styles.btn, styles.btnOutline, busy && styles.btnDisabled]}
        onPress={onFund}
        disabled={busy}
      >
        <Text style={styles.btnOutlineText}>＋ Add funds — Unifold Deposit</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.btn, styles.btnOutline, busy && styles.btnDisabled]}
        onPress={onCheckDeposit}
        disabled={busy}
      >
        <Text style={styles.btnOutlineText}>Refresh balance</Text>
      </TouchableOpacity>

      <TouchableOpacity style={[styles.btn, styles.btnPurple]} onPress={onEvents}>
        <Text style={styles.btnText}>Hangouts (stake & flake-tax)</Text>
      </TouchableOpacity>

      <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={onWithdraw}>
        <Text style={styles.btnText}>Cash out</Text>
      </TouchableOpacity>

      {busy && <ActivityIndicator style={{ marginTop: 8 }} />}
      {!!status && <Text style={styles.status}>{status}</Text>}

      <TouchableOpacity
        style={[styles.btn, styles.btnReset, busy && styles.btnDisabled]}
        onPress={onReset}
        disabled={busy}
      >
        <Text style={styles.btnResetText}>Reset user (dev)</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 80, gap: 12 },
  title: { fontSize: 32, fontWeight: '700' },
  subtitle: { fontSize: 14, color: '#666', marginBottom: 8 },
  balanceBox: {
    backgroundColor: '#f2f2f7',
    borderRadius: 16,
    padding: 28,
    alignItems: 'center',
    marginVertical: 12,
  },
  balanceNum: { fontSize: 48, fontWeight: '700', color: '#0a58ca' },
  balanceLabel: { fontSize: 13, color: '#666', marginTop: 6 },
  owe: { color: '#c0392b' },
  caption: { fontSize: 11, color: '#888', marginTop: 8 },
  userId: { fontSize: 11, color: '#999', fontFamily: 'Courier', marginBottom: 8 },
  section: { fontSize: 12, color: '#666', marginTop: 4 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    backgroundColor: '#fff',
  },
  smallBtn: { borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, alignItems: 'center' },
  creditBtn: { backgroundColor: '#1a7f37' },
  debitBtn: { backgroundColor: '#c0392b' },
  smallBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  btn: { backgroundColor: '#0a58ca', borderRadius: 12, padding: 16, alignItems: 'center' },
  btnSecondary: { backgroundColor: '#1a7f37', marginTop: 8 },
  btnPurple: { backgroundColor: '#7a3ff2', marginTop: 8 },
  btnOutline: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#0a58ca', marginTop: 8 },
  btnOutlineText: { color: '#0a58ca', fontWeight: '600', fontSize: 16 },
  btnReset: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#999', marginTop: 24 },
  btnResetText: { color: '#666', fontWeight: '600', fontSize: 14 },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  status: { marginTop: 12, fontSize: 13, color: '#333' },
});
