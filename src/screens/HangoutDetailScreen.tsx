import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Avatar from '../components/Avatar';
import { DoodleButton, DoodleCard } from '../components/Doodle';
import OutlinedText from '../components/OutlinedText';
import YardBackground from '../components/YardBackground';
import Polaroid from '../components/Polaroid';
import TopBar from '../components/TopBar';
import { fmtUsd } from '../money';
import { useNav } from '../state/nav';
import { useSession } from '../state/session';
import { C, F } from '../theme';
import { Hangout } from '../types';
import { fmtDate } from './HangoutsScreen';

export default function HangoutDetailScreen({ hangoutId }: { hangoutId: number }) {
  const { api, me, serverUrl } = useSession();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const [h, setH] = useState<Hangout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stakeMsg, setStakeMsg] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [endMsg, setEndMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    return api.hangout(hangoutId).then((r) => setH(r.hangout)).catch((e) => setError(e.message));
  }, [api, hangoutId]);

  const doStake = useCallback(async () => {
    setBusy(true);
    setStakeMsg(null);
    try {
      const r = await api.stakeHangout(hangoutId);
      setH(r.hangout);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not stake';
      setStakeMsg(/insufficient balance/i.test(msg)
        ? "You don't have enough USDC for this stake. Add funds on the Deposit screen, then try again."
        : msg);
    } finally {
      setBusy(false);
    }
  }, [api, hangoutId]);

  const doEnd = useCallback(async () => {
    setBusy(true);
    setEndMsg(null);
    try {
      const r = await api.endHangout(hangoutId);
      setH(r.hangout);
      setConfirmEnd(false);
    } catch (e) {
      setEndMsg(e instanceof Error ? e.message : 'Could not end the hangout');
    } finally {
      setBusy(false);
    }
  }, [api, hangoutId]);

  // reload when returning from the photo or confirm screens
  useEffect(() => { load(); }, [load, nav.route]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (!h) {
    return (
      <View style={{ flex: 1 }}>
        <YardBackground bg={C.tan} tint={C.tanPaw} seed={21} />
        <View style={{ paddingTop: insets.top }}>
          <TopBar title="Hangout" />
        </View>
        {error && (
          <Text style={{ fontFamily: F.body, fontSize: 14, color: C.redPin, textAlign: 'center', marginTop: 30 }}>
            {error}
          </Text>
        )}
      </View>
    );
  }

  const started = new Date(h.date).getTime() < Date.now();
  const isPairConfirmed = (a: string, b: string) =>
    h.confirmedPairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

  const pairs: { a: typeof h.members[number]; b: typeof h.members[number] }[] = [];
  for (let i = 0; i < h.members.length; i++)
    for (let j = i + 1; j < h.members.length; j++)
      pairs.push({ a: h.members[i], b: h.members[j] });

  return (
    <View style={{ flex: 1 }}>
      <YardBackground bg={C.tan} tint={C.tanPaw} seed={21} />
      <View style={{ paddingTop: insets.top }}>
        <TopBar title="Hangout" />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[C.orange]} />
        }
      >
        <DoodleCard seed={6} style={{ alignItems: 'center' }}>
          <Text style={{ fontFamily: F.display, fontSize: 24, color: C.darkInk, textAlign: 'center' }}>
            {h.activityLabel}
          </Text>
          <Text style={{ fontFamily: F.body, fontSize: 14, color: C.brown, marginTop: 2 }}>
            {fmtDate(h.date)} at {h.place}
          </Text>
          {h.bonusReason && (
            <Text style={{ fontFamily: F.display, fontSize: 13, color: C.labelGreen, marginTop: 4 }}>
              {h.bonusReason}: vibe x2
            </Text>
          )}
          <View style={{ flexDirection: 'row', marginTop: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
            {h.members.map((m) => {
              const noShow = !!h.completedAt && !m.attended;
              return (
                <View key={m.username} style={{ alignItems: 'center', marginHorizontal: 8, marginBottom: 4, opacity: noShow ? 0.5 : 1 }}>
                  <Avatar color={m.color} species={m.species} equipped={m.equipped} size={52} />
                  <Text style={{ fontFamily: F.body, fontSize: 12, color: C.darkInk }}>
                    {m.username === me?.username ? 'You' : m.name}
                  </Text>
                  {noShow && (
                    <Text style={{ fontFamily: F.display, fontSize: 10, color: C.redPin }}>no-show</Text>
                  )}
                </View>
              );
            })}
          </View>
        </DoodleCard>

        {/* stake pool */}
        {h.stake && (
          <>
            <View style={{ marginTop: 16, marginBottom: 6 }}>
              <OutlinedText size={20} color={C.labelOrange} outline={C.white} thickness={2}>
                {h.stake.settled ? 'Payout' : 'The pool'}
              </OutlinedText>
            </View>
            <DoodleCard seed={4}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ fontFamily: F.display, fontSize: 15, color: C.darkInk }}>
                  {fmtUsd(h.stake.stakeUnits)} each
                </Text>
                <Text style={{ fontFamily: F.display, fontSize: 18, color: C.labelGreen }}>
                  {fmtUsd(h.stake.poolUnits)} pool
                </Text>
              </View>
              <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.brown, marginTop: 2, marginBottom: 6 }}>
                {h.stake.settled
                  ? 'Flakers lost their stake to the friends who showed.'
                  : 'Show up to get your stake back. Flake and it goes to the others.'}
              </Text>
              {h.stake.members.map((sm) => {
                const mem = h.members.find((m) => m.username === sm.username);
                const label = sm.username === me?.username ? 'You' : mem?.name ?? sm.username;
                let right: React.ReactNode;
                if (h.stake!.settled) {
                  const color = sm.settleStatus === 'flaked' ? C.redPin : C.labelGreen;
                  right = (
                    <Text style={{ fontFamily: F.display, fontSize: 13, color }}>
                      {sm.settleStatus === 'flaked' ? `flaked -${fmtUsd(h.stake!.stakeUnits)}` : `+${fmtUsd(sm.payoutUnits)}`}
                    </Text>
                  );
                } else {
                  right = (
                    <Text style={{ fontFamily: F.display, fontSize: 13, color: sm.staked ? C.labelGreen : C.fadedInk }}>
                      {sm.staked ? 'staked' : 'not in yet'}
                    </Text>
                  );
                }
                return (
                  <View key={sm.username}
                    style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6,
                      borderTopWidth: 1.5, borderTopColor: '#DCC49A' }}>
                    <Text style={{ flex: 1, fontFamily: F.body, fontSize: 14, color: C.darkInk }}>{label}</Text>
                    {right}
                  </View>
                );
              })}
              {!h.stake.settled && !h.stake.iStaked && (
                <View style={{ marginTop: 10 }}>
                  <DoodleButton
                    label={busy ? 'Staking' : `Stake ${fmtUsd(h.stake.stakeUnits)} to join`}
                    bg={C.yellow} border={C.brown} seed={8} disabled={busy}
                    onPress={doStake}
                  />
                </View>
              )}
              {stakeMsg && (
                <Text style={{ fontFamily: F.body, fontSize: 13, color: C.redPin, marginTop: 8 }}>{stakeMsg}</Text>
              )}
            </DoodleCard>
          </>
        )}

        {/* photo */}
        <View style={{ marginTop: 16, marginBottom: 6 }}>
          <OutlinedText size={20} color={C.labelPink} outline={C.white} thickness={2}>
            The photo
          </OutlinedText>
        </View>
        <View style={{ alignItems: 'center' }}>
          <Polaroid
            seed={h.id * 7 + 2}
            width={220}
            photoUri={h.photoUrl ? `${serverUrl}${h.photoUrl}` : undefined}
            caption={h.photoUrl ? h.activityLabel : undefined}
          />
          {started && !h.completedAt && (
            <View style={{ marginTop: 10 }}>
              <DoodleButton
                label={h.photoUrl ? 'Retake photo' : 'Take the photo'}
                seed={9} bg={C.yellow} border={C.brown}
                onPress={() => nav.push({ name: 'photo', hangoutId: h.id })}
              />
            </View>
          )}
          {!started && (
            <Text style={{ fontFamily: F.body, fontSize: 13, color: C.brown, marginTop: 8, textAlign: 'center' }}>
              The photo and confirmations unlock once the hangout starts.
            </Text>
          )}
        </View>

        {/* pair confirmations */}
        <View style={{ marginTop: 16, marginBottom: 6 }}>
          <OutlinedText size={20} color={C.labelBlue} outline={C.white} thickness={2}>
            Confirmations
          </OutlinedText>
        </View>
        <DoodleCard seed={13}>
          <Text style={{ fontFamily: F.body, fontSize: 13, color: C.brown, marginBottom: 8 }}>
            Every pair confirms once to prove you were all really there.
            Tap phones or scan each other's code.
          </Text>
          {pairs.map(({ a, b }) => {
            const doneP = isPairConfirmed(a.username, b.username);
            const mine = me && (a.username === me.username || b.username === me.username);
            const other = a.username === me?.username ? b : a;
            return (
              <View
                key={`${a.username}-${b.username}`}
                style={{
                  flexDirection: 'row', alignItems: 'center', paddingVertical: 7,
                  borderTopWidth: 1.5, borderTopColor: '#DCC49A',
                }}
              >
                <Text style={{ flex: 1, fontFamily: F.body, fontSize: 14, color: C.darkInk }}>
                  {a.username === me?.username ? 'You' : a.name}
                  {'  +  '}
                  {b.username === me?.username ? 'You' : b.name}
                </Text>
                {doneP ? (
                  <Text style={{ fontFamily: F.display, fontSize: 13, color: C.labelGreen }}>Confirmed</Text>
                ) : mine && started && !h.completedAt ? (
                  <DoodleButton
                    label="Confirm"
                    size={12}
                    seed={a.username.length + b.username.length}
                    onPress={() =>
                      nav.push({
                        name: 'confirm', hangoutId: h.id,
                        otherUsername: other.username, otherName: other.name,
                      })
                    }
                  />
                ) : (
                  <Text style={{ fontFamily: F.body, fontSize: 13, color: C.fadedInk }}>Waiting</Text>
                )}
              </View>
            );
          })}
        </DoodleCard>

        {/* end early for no-shows */}
        {h.canEnd && (
          <>
            <View style={{ marginTop: 16, marginBottom: 6 }}>
              <OutlinedText size={20} color={C.labelOrange} outline={C.white} thickness={2}>
                Wrap it up & pay out
              </OutlinedText>
            </View>
            <DoodleCard seed={19}>
              <Text style={{ fontFamily: F.body, fontSize: 13, color: C.brown, marginBottom: 8 }}>
                When you're done, end the hangout{h.stake
                  ? " to pay everyone out. Anyone who came gets their stake back; a no-show's stake is split among the friends who showed"
                  : ' and it wraps up with whoever showed up'}. A friend
                counts as here once they've taken the photo or confirmed with someone.
              </Text>
              {h.members.map((m) => (
                <View
                  key={m.username}
                  style={{
                    flexDirection: 'row', alignItems: 'center', paddingVertical: 6,
                    borderTopWidth: 1.5, borderTopColor: '#DCC49A',
                  }}
                >
                  <Text style={{ flex: 1, fontFamily: F.body, fontSize: 14, color: C.darkInk }}>
                    {m.username === me?.username ? 'You' : m.name}
                  </Text>
                  <Text style={{ fontFamily: F.display, fontSize: 13, color: m.attended ? C.labelGreen : C.fadedInk }}>
                    {m.attended ? 'here' : 'no sign yet'}
                  </Text>
                </View>
              ))}
              {!confirmEnd ? (
                <View style={{ marginTop: 10 }}>
                  <DoodleButton
                    label="End the hangout"
                    bg={C.yellow} border={C.brown} seed={15} disabled={busy}
                    onPress={() => { setEndMsg(null); setConfirmEnd(true); }}
                  />
                </View>
              ) : (
                <View style={{ marginTop: 10 }}>
                  <Text style={{ fontFamily: F.body, fontSize: 13, color: C.redPin, marginBottom: 8 }}>
                    End now with the friends marked "here"?
                    {h.stake ? ' This settles the pool and no-shows lose their stake.' : ''}
                    {' '}This can't be undone.
                  </Text>
                  <DoodleButton
                    label={busy ? 'Ending' : 'Yes, end it now'}
                    bg={C.redPin} border={C.brown} seed={16} disabled={busy}
                    onPress={doEnd}
                  />
                  <View style={{ marginTop: 8 }}>
                    <DoodleButton label="Keep waiting" seed={18} disabled={busy} onPress={() => setConfirmEnd(false)} />
                  </View>
                </View>
              )}
              {endMsg && (
                <Text style={{ fontFamily: F.body, fontSize: 13, color: C.redPin, marginTop: 8 }}>{endMsg}</Text>
              )}
            </DoodleCard>
          </>
        )}

        {h.completedAt && (
          <View style={{ alignItems: 'center', marginTop: 16 }}>
            <OutlinedText size={22} color={C.labelGreen} outline={C.white} thickness={2}>
              In your Memory Book
            </OutlinedText>
            <View style={{ marginTop: 8 }}>
              <DoodleButton label="Open Memory Book" seed={17} onPress={() => nav.push({ name: 'memoryBook' })} />
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
