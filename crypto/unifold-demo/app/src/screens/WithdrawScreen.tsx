import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  DESTINATIONS,
  Destination,
  MIN_WITHDRAW_UNITS,
  errMsg,
  formatUsdc,
  toUnits,
} from '../constants';
import { getCatalog, getUser, getWithdrawal, withdraw } from '../api';
import { getOrCreateUserId } from '../user';

// NOTE: the destination list is fetched LIVE from Unifold's supported-tokens
// catalog (falls back to built-in presets if unavailable) — so we only ever offer
// chains/tokens Unifold actually supports. Cross-chain routing AND gas are handled
// entirely by Unifold's outbound transfer; the user needs no wallet, ETH, or gas.

type Phase = 'idle' | 'submitting' | 'polling' | 'done' | 'error';

export default function WithdrawScreen({ onBack }: { onBack: () => void }) {
  const [userId, setUserId] = useState<string>('');
  const [balanceUnits, setBalanceUnits] = useState<string>('0');
  const [amount, setAmount] = useState<string>('');
  const [dests, setDests] = useState<Destination[]>(DESTINATIONS);
  const [dest, setDest] = useState<Destination>(DESTINATIONS[0]);
  const [recipient, setRecipient] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState<string>('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const id = await getOrCreateUserId();
        setUserId(id);
        const u = await getUser(id);
        setBalanceUnits(u.balanceUnits);
        // Default the amount field to the full balance as a decimal.
        setAmount(formatUsdc(u.balanceUnits));
      } catch (e: any) {
        setError('Load error: ' + errMsg(e));
      }
      // Pull the live supported-token catalog from Unifold (fallback: presets).
      try {
        const cat = await getCatalog();
        const stable = cat.destinations.filter((d) => d.is_stablecoin);
        const rows: Destination[] = (stable.length ? stable : cat.destinations)
          .slice(0, 16)
          .map((d) => ({
            label: `${d.symbol} · ${d.chain_name}`,
            chain_type: d.chain_type,
            chain_id: d.chain_id,
            token_address: d.token_address,
          }));
        if (rows.length) {
          setDests(rows);
          setDest(rows[0]);
        }
      } catch {
        /* keep built-in presets */
      }
    })();
    return () => clearTimer();
  }, [clearTimer]);

  const onCashOut = useCallback(async () => {
    setError('');
    const parsed = parseFloat(amount);
    if (!isFinite(parsed) || parsed <= 0) {
      setError('Enter a valid amount.');
      return;
    }
    const amountUnits = toUnits(amount);
    if (Number(amountUnits) < MIN_WITHDRAW_UNITS) {
      setError(`Minimum withdrawal is ${MIN_WITHDRAW_UNITS / 1e6} USDC.`);
      return;
    }
    if (!recipient.trim()) {
      setError('Enter a recipient address.');
      return;
    }

    clearTimer();
    setPhase('submitting');
    setStatus('Submitting withdrawal…');
    try {
      const r = await withdraw(userId, amountUnits, {
        chain_type: dest.chain_type,
        chain_id: dest.chain_id,
        token_address: dest.token_address,
        recipient_address: recipient.trim(),
      });
      setBalanceUnits(r.balanceUnits);
      setPhase('polling');
      setStatus(`Status: ${r.status}`);

      const poll = async () => {
        try {
          const w = await getWithdrawal(r.withdrawalId);
          setStatus(`Status: ${w.status}`);
          setBalanceUnits(w.balanceUnits);
          if (w.status === 'completed') {
            clearTimer();
            setPhase('done');
            setStatus('Withdrawal completed.');
          } else if (w.status === 'failed') {
            clearTimer();
            setPhase('error');
            setError('Withdrawal failed. Your balance has been refunded.');
          }
        } catch (e: any) {
          // Keep polling on transient errors.
          setStatus('Polling… (' + errMsg(e) + ')');
        }
      };

      timerRef.current = setInterval(poll, 3000);
      poll();
    } catch (e: any) {
      setPhase('error');
      setError('Withdraw error: ' + errMsg(e));
    }
  }, [amount, recipient, dest, userId, clearTimer]);

  const busy = phase === 'submitting' || phase === 'polling';

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <TouchableOpacity onPress={onBack}>
        <Text style={styles.back}>‹ Back</Text>
      </TouchableOpacity>

      <Text style={styles.title}>Cash out</Text>
      <Text style={styles.subtitle}>
        Available: ${formatUsdc(balanceUnits)} USDC
      </Text>

      <Text style={styles.label}>Amount (USDC)</Text>
      <TextInput
        style={styles.input}
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        placeholder="0.00"
        editable={!busy}
      />

      <Text style={styles.label}>Destination — any chain/token Unifold supports</Text>
      <View style={styles.segments}>
        {dests.map((d) => {
          const selected = d.chain_id === dest.chain_id && d.token_address === dest.token_address;
          return (
            <TouchableOpacity
              key={`${d.chain_id}-${d.token_address}`}
              style={[styles.segment, selected && styles.segmentSelected]}
              onPress={() => !busy && setDest(d)}
            >
              <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
                {d.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <Text style={styles.label}>Recipient address</Text>
      <TextInput
        style={styles.input}
        value={recipient}
        onChangeText={setRecipient}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="0x…"
        editable={!busy}
      />

      {!!error && <Text style={styles.error}>{error}</Text>}

      <TouchableOpacity
        style={[styles.btn, busy && styles.btnDisabled]}
        onPress={onCashOut}
        disabled={busy}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Cash out</Text>}
      </TouchableOpacity>

      {!!status && <Text style={styles.status}>{status}</Text>}
      {phase === 'done' && <Text style={styles.success}>✓ Sent via Unifold — no gas, no wallet needed.</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 72, gap: 10 },
  back: { fontSize: 16, color: '#0a58ca', marginBottom: 8 },
  title: { fontSize: 28, fontWeight: '700' },
  subtitle: { fontSize: 14, color: '#666', marginBottom: 12 },
  label: { fontSize: 12, color: '#666', marginTop: 12 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 10,
    padding: 14,
    fontSize: 16,
    backgroundColor: '#fff',
  },
  segments: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  segment: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#fff',
  },
  segmentSelected: { backgroundColor: '#0a58ca', borderColor: '#0a58ca' },
  segmentText: { fontSize: 13, color: '#333' },
  segmentTextSelected: { color: '#fff', fontWeight: '600' },
  error: { color: '#c0392b', fontSize: 13, marginTop: 8 },
  btn: {
    backgroundColor: '#1a7f37',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginTop: 20,
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  status: { marginTop: 14, fontSize: 14, color: '#333' },
  success: { marginTop: 8, fontSize: 14, color: '#1a7f37', fontWeight: '600' },
});
