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
import { errMsg, formatUsdc, toUnits } from '../constants';
import {
  createEvent,
  listEvents,
  rsvpEvent,
  checkinEvent,
  settleEvent,
  type EventItem,
} from '../api';
import { getOrCreateUserId } from '../user';

const short = (id: string) => id.slice(0, 6) + '…' + id.slice(-4);

export default function EventsScreen({ onBack }: { onBack: () => void }) {
  const [me, setMe] = useState('');
  const [events, setEvents] = useState<EventItem[]>([]);
  const [title, setTitle] = useState('Coffee');
  const [stake, setStake] = useState('3');
  const [holiday, setHoliday] = useState(false);
  const [friends, setFriends] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const load = useCallback(async (id?: string) => {
    const uid = id ?? me;
    if (!uid) return;
    const r = await listEvents(uid);
    setEvents(r.events);
  }, [me]);

  useEffect(() => {
    (async () => {
      const id = await getOrCreateUserId();
      setMe(id);
      await load(id);
    })().catch((e) => setStatus('Load error: ' + errMsg(e)));
  }, [load]);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(true);
      setStatus(label);
      try {
        await fn();
        await load();
        setStatus(label + ' ✓');
      } catch (e: any) {
        setStatus(label + ' — error: ' + errMsg(e));
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  const onCreate = () =>
    run('Creating event', () =>
      createEvent(me, title, toUnits(stake), holiday ? 15000 : undefined)
    );

  const onSettle = (id: string) =>
    run('Settling', async () => {
      const r = await settleEvent(id);
      setStatus(`Settled — flake pool $${formatUsdc(r.forfeitPoolUnits)} redistributed ✓`);
    });

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <TouchableOpacity onPress={onBack}>
        <Text style={styles.back}>‹ Back</Text>
      </TouchableOpacity>
      <Text style={styles.title}>Hangouts</Text>
      <Text style={styles.subtitle}>Stake to RSVP. Flake → your stake pays the friends who showed.</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>New hangout</Text>
        <Text style={styles.label}>Title</Text>
        <TextInput style={styles.input} value={title} onChangeText={setTitle} editable={!busy} />
        <Text style={styles.label}>Stake (USDC)</Text>
        <TextInput
          style={styles.input}
          value={stake}
          onChangeText={setStake}
          keyboardType="decimal-pad"
          editable={!busy}
        />
        <TouchableOpacity
          style={[styles.toggle, holiday && styles.toggleOn]}
          onPress={() => setHoliday((h) => !h)}
          disabled={busy}
        >
          <Text style={holiday ? styles.toggleOnText : styles.toggleText}>
            {holiday ? '🎉 Holiday 1.5× — ON' : 'Holiday 1.5× — off'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, busy && styles.dim]} onPress={onCreate} disabled={busy}>
          <Text style={styles.btnText}>Create hangout</Text>
        </TouchableOpacity>
      </View>

      {events.map((ev) => (
        <View key={ev.id} style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.cardTitle}>{ev.title}</Text>
            <Text style={ev.status === 'settled' ? styles.settled : styles.open}>{ev.status}</Text>
          </View>
          <Text style={styles.meta}>Stake ${formatUsdc(ev.stakeUnits)}
            {ev.multiplierBps > 10000 ? `  ·  ${(ev.multiplierBps / 10000).toFixed(1)}× holiday` : ''}
          </Text>

          {ev.rsvps.map((r) => (
            <View key={r.userId} style={styles.rsvpRow}>
              <Text style={styles.rsvpName}>
                {r.userId === me ? 'you' : short(r.userId)}
              </Text>
              <Text style={[styles.rsvpStatus, statusColor(r.status)]}>{r.status}</Text>
              {r.status !== 'staked' || ev.status === 'settled' ? (
                <Text style={styles.payout}>
                  {r.status === 'flaked' ? '−' : '+'}${formatUsdc(
                    r.status === 'flaked' ? r.stakedUnits : r.payoutUnits
                  )}
                </Text>
              ) : ev.status === 'open' ? (
                <TouchableOpacity
                  style={styles.miniBtn}
                  onPress={() => run('Checking in', () => checkinEvent(ev.id, r.userId))}
                  disabled={busy}
                >
                  <Text style={styles.miniBtnText}>Check in</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ))}

          {ev.status === 'open' && (
            <>
              {!ev.rsvps.some((r) => r.userId === me) && (
                <TouchableOpacity
                  style={[styles.btn, styles.green, busy && styles.dim]}
                  onPress={() => run('RSVP', () => rsvpEvent(ev.id, me))}
                  disabled={busy}
                >
                  <Text style={styles.btnText}>RSVP + stake (you)</Text>
                </TouchableOpacity>
              )}
              <View style={styles.rowBetween}>
                <TextInput
                  style={[styles.input, { flex: 1, marginRight: 8 }]}
                  value={friends[ev.id] ?? ''}
                  onChangeText={(t) => setFriends((f) => ({ ...f, [ev.id]: t }))}
                  placeholder="friend user id"
                  autoCapitalize="none"
                  editable={!busy}
                />
                <TouchableOpacity
                  style={[styles.miniBtn, busy && styles.dim]}
                  onPress={() =>
                    run('Staking friend', () => rsvpEvent(ev.id, (friends[ev.id] ?? '').trim()))
                  }
                  disabled={busy}
                >
                  <Text style={styles.miniBtnText}>Stake friend</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                style={[styles.btn, styles.settle, busy && styles.dim]}
                onPress={() => onSettle(ev.id)}
                disabled={busy}
              >
                <Text style={styles.btnText}>Settle (pay the show-ups)</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      ))}

      {busy && <ActivityIndicator style={{ marginTop: 8 }} />}
      {!!status && <Text style={styles.status}>{status}</Text>}
    </ScrollView>
  );
}

function statusColor(s: string) {
  if (s === 'attended') return { color: '#1a7f37' };
  if (s === 'flaked') return { color: '#c0392b' };
  if (s === 'refunded') return { color: '#8a6d3b' };
  return { color: '#666' };
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingTop: 64, gap: 10 },
  back: { fontSize: 16, color: '#0a58ca' },
  title: { fontSize: 28, fontWeight: '700' },
  subtitle: { fontSize: 13, color: '#666', marginBottom: 8 },
  card: { backgroundColor: '#f7f7fa', borderRadius: 14, padding: 16, gap: 8 },
  cardTitle: { fontSize: 17, fontWeight: '700' },
  meta: { fontSize: 13, color: '#555' },
  label: { fontSize: 12, color: '#666' },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    backgroundColor: '#fff',
  },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  open: { color: '#0a58ca', fontWeight: '600', fontSize: 12 },
  settled: { color: '#1a7f37', fontWeight: '600', fontSize: 12 },
  rsvpRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  rsvpName: { flex: 1, fontSize: 13, fontFamily: 'Courier' },
  rsvpStatus: { fontSize: 12, fontWeight: '600' },
  payout: { fontSize: 13, fontWeight: '700', minWidth: 56, textAlign: 'right' },
  btn: { backgroundColor: '#0a58ca', borderRadius: 10, padding: 13, alignItems: 'center', marginTop: 4 },
  green: { backgroundColor: '#1a7f37' },
  settle: { backgroundColor: '#7a3ff2' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  toggle: {
    borderWidth: 1,
    borderColor: '#e0a800',
    borderRadius: 10,
    padding: 11,
    alignItems: 'center',
    marginTop: 4,
  },
  toggleOn: { backgroundColor: '#fff3cd', borderColor: '#e0a800' },
  toggleText: { color: '#8a6d3b', fontWeight: '600', fontSize: 14 },
  toggleOnText: { color: '#8a6d3b', fontWeight: '700', fontSize: 14 },
  miniBtn: { backgroundColor: '#0a58ca', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12 },
  miniBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  dim: { opacity: 0.6 },
  status: { marginTop: 10, fontSize: 13, color: '#333' },
});
