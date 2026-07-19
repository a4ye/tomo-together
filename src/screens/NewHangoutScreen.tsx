import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Avatar from '../components/Avatar';
import { DoodleButton, DoodleCard } from '../components/Doodle';
import OutlinedText from '../components/OutlinedText';
import YardBackground from '../components/YardBackground';
import TopBar from '../components/TopBar';
import { bonusPreview } from '../bonus';
import { fmtUsd, STAKE_PRESETS } from '../money';
import { useNav } from '../state/nav';
import { useSession } from '../state/session';
import { C, F } from '../theme';
import { Activity, FriendView, Holiday } from '../types';

const TOTAL_PICKS = 5;

const DAY_CHOICES = [0, 1, 2, 3, 5, 7];
const TIME_CHOICES = [
  { label: 'Morning', hour: 10 },
  { label: 'Afternoon', hour: 14 },
  { label: 'Evening', hour: 18 },
  { label: 'Night', hour: 21 },
];

// 24h hour + minute -> "6:05 PM"
function fmtClock(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  return `${h12}:${String(minute).padStart(2, '0')} ${ampm}`;
}

// Small up/down control for the custom time picker.
function Stepper({ label, onUp, onDown }: { label: string; onUp: () => void; onDown: () => void }) {
  const btn = {
    backgroundColor: C.white, borderWidth: 2.5, borderColor: '#C89A62', borderRadius: 6,
    width: 40, height: 34, alignItems: 'center' as const, justifyContent: 'center' as const,
  };
  return (
    <View style={{ alignItems: 'center' }}>
      <Pressable onPress={onUp}>
        <View style={btn}>
          <Text style={{ fontFamily: F.display, fontSize: 18, color: C.brown }}>+</Text>
        </View>
      </Pressable>
      <Text style={{ fontFamily: F.body, fontSize: 11, color: C.fadedInk, marginVertical: 2 }}>{label}</Text>
      <Pressable onPress={onDown}>
        <View style={btn}>
          <Text style={{ fontFamily: F.display, fontSize: 18, color: C.brown }}>-</Text>
        </View>
      </Pressable>
    </View>
  );
}

export default function NewHangoutScreen({ preselect }: { preselect?: string }) {
  const { api } = useSession();
  const nav = useNav();
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState<'who' | 'duel' | 'details'>('who');
  const [friends, setFriends] = useState<FriendView[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // duel state
  const [queue, setQueue] = useState<Activity[]>([]);
  const [champion, setChampion] = useState<Activity | null>(null);
  const [pickCount, setPickCount] = useState(0);

  // details state
  const [timeMode, setTimeMode] = useState<'now' | 'preset' | 'custom'>('preset');
  const [daysAhead, setDaysAhead] = useState(1);
  const [hour, setHour] = useState(18);
  const [minute, setMinute] = useState(0);
  const [place, setPlace] = useState('');
  const [stakeUnits, setStakeUnits] = useState<string | null>(null);
  const [cryptoOn, setCryptoOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.wallet().then((w) => setCryptoOn(!!w.enabled)).catch(() => {});
    api.friends().then((r) => {
      setFriends(r.friends);
      // start with the nudged friend selected, once verified against the list
      if (preselect && r.friends.some((f) => f.username === preselect)) {
        setPicked((p) => (p.includes(preselect) ? p : [...p, preselect]));
      }
    }).catch(() => {});
    api.catalog().then((r) => setHolidays(r.holidays)).catch(() => {});
  }, [api, preselect]);

  const toggle = (username: string) =>
    setPicked((p) => (p.includes(username) ? p.filter((x) => x !== username) : [...p, username]));

  const startDuel = async () => {
    setError(null);
    try {
      const { activities } = await api.rankedActivities(picked);
      const pool = activities.slice(0, 8);
      setChampion(pool[0]);
      setQueue(pool.slice(1));
      setPickCount(0);
      setStep('duel');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load activities');
    }
  };

  const pickDuel = (winner: Activity, loser: Activity) => {
    api.duel(winner.id, loser.id).catch(() => {});
    const nextCount = pickCount + 1;
    setChampion(winner);
    setQueue((q) => q.slice(1));
    setPickCount(nextCount);
    if (nextCount >= TOTAL_PICKS || queue.length <= 1) setStep('details');
  };

  // For "now" the preview just reflects the current minute; the exact instant
  // is re-read at create() so the hangout starts (and unlocks) immediately.
  const date = useMemo(() => {
    if (timeMode === 'now') return new Date();
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    d.setHours(hour, minute, 0, 0);
    return d;
  }, [timeMode, daysAhead, hour, minute]);

  const attendees = friends.filter((f) => picked.includes(f.username));
  const bonus = bonusPreview(date, holidays, attendees);

  const create = async () => {
    if (!champion) return;
    setBusy(true);
    setError(null);
    try {
      const when = timeMode === 'now' ? new Date() : date;
      const { hangout } = await api.createHangout({
        activity: champion.id,
        date: when.toISOString(),
        place: place.trim() || 'Somewhere',
        friendUsernames: picked,
        ...(stakeUnits ? { stakeUnits } : {}),
      });
      nav.replace({ name: 'hangoutDetail', hangoutId: hangout.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create hangout');
      setBusy(false);
    }
  };

  const challenger = queue[0];

  return (
    <View style={{ flex: 1 }}>
      <YardBackground bg={C.green} tint={C.greenPaw} seed={17} />
      <View style={{ paddingTop: insets.top }}>
        <TopBar title="New Hangout" />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30 }}>
        {step === 'who' && (
          <>
            <View style={{ marginBottom: 6 }}>
              <OutlinedText size={20} color={C.labelBlue} outline={C.white} thickness={2}>
                Who is coming?
              </OutlinedText>
            </View>
            {friends.length === 0 && (
              <DoodleCard seed={3}>
                <Text style={{ fontFamily: F.body, fontSize: 14, color: C.brown }}>
                  You need at least one friend first. Add friends by username on the Friends page.
                </Text>
                <View style={{ marginTop: 10 }}>
                  <DoodleButton label="Go to Friends" seed={4} onPress={() => nav.replace({ name: 'friends' })} />
                </View>
              </DoodleCard>
            )}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {friends.map((f) => {
                const on = picked.includes(f.username);
                return (
                  <Pressable key={f.username} onPress={() => toggle(f.username)}>
                    <View
                      style={{
                        alignItems: 'center', margin: 4, padding: 8, borderRadius: 6, width: 90,
                        backgroundColor: on ? C.yellow : C.cream,
                        borderWidth: 3, borderColor: on ? C.brown : '#C89A62',
                      }}
                    >
                      <Avatar color={f.color} species={f.species} equipped={f.equipped} size={50} />
                      <Text style={{ fontFamily: F.display, fontSize: 13, color: C.darkInk }} numberOfLines={1}>
                        {f.name}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
            {error && (
              <Text style={{ fontFamily: F.body, fontSize: 13, color: C.redPin, marginTop: 8 }}>{error}</Text>
            )}
            {friends.length > 0 && (
              <View style={{ marginTop: 14 }}>
                <DoodleButton
                  label="Next: pick the activity"
                  bg={C.yellow} border={C.brown} seed={6}
                  disabled={picked.length === 0}
                  onPress={startDuel}
                />
              </View>
            )}
          </>
        )}

        {step === 'duel' && champion && challenger && (
          <>
            <View style={{ alignItems: 'center', marginBottom: 4 }}>
              <OutlinedText size={20} color={C.labelPink} outline={C.white} thickness={2}>
                Which sounds better?
              </OutlinedText>
              <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.brown, marginTop: 4, textAlign: 'center' }}>
                Quick picks tune what you all like. Pick {pickCount + 1} of {TOTAL_PICKS}.
              </Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 14 }}>
              {[champion, challenger].map((a, side) => (
                <React.Fragment key={a.id}>
                  {side === 1 && (
                    <View style={{ marginHorizontal: 10 }}>
                      <OutlinedText size={20} color={C.yellow} outline={C.darkInk} thickness={2}>or</OutlinedText>
                    </View>
                  )}
                  <Pressable
                    style={{ flex: 1 }}
                    onPress={() => pickDuel(a, side === 0 ? challenger : champion)}
                  >
                    <DoodleCard seed={pickCount * 3 + side + 1} tilt={1.2} bg={C.white}
                      style={{ alignItems: 'center', paddingVertical: 34 }}>
                      <Text style={{ fontFamily: F.display, fontSize: 19, color: C.darkInk, textAlign: 'center' }}>
                        {a.label}
                      </Text>
                    </DoodleCard>
                  </Pressable>
                </React.Fragment>
              ))}
            </View>
            <View style={{ alignItems: 'center', marginTop: 18 }}>
              <DoodleButton label="Good enough, use the left one" size={13} seed={8}
                onPress={() => setStep('details')} />
            </View>
          </>
        )}

        {step === 'details' && champion && (
          <>
            <DoodleCard seed={5} style={{ alignItems: 'center' }}>
              <Text style={{ fontFamily: F.body, fontSize: 13, color: C.brown }}>You all landed on</Text>
              <Text style={{ fontFamily: F.display, fontSize: 24, color: C.darkInk, marginTop: 2 }}>
                {champion.label}
              </Text>
              <Text style={{ fontFamily: F.body, fontSize: 13, color: C.brown, marginTop: 2 }}>
                with {attendees.map((a) => a.name).join(', ')}
              </Text>
            </DoodleCard>

            <View style={{ marginTop: 14, marginBottom: 6 }}>
              <OutlinedText size={20} color={C.labelBlue} outline={C.white} thickness={2}>When?</OutlinedText>
            </View>

            {/* time mode */}
            <View style={{ flexDirection: 'row' }}>
              {([
                ['now', 'Right now'],
                ['preset', 'Pick a day'],
                ['custom', 'Custom time'],
              ] as const).map(([m, label]) => (
                <Pressable key={m} onPress={() => setTimeMode(m)} style={{ flex: 1 }}>
                  <View
                    style={{
                      alignItems: 'center', marginHorizontal: 3, paddingVertical: 8, borderRadius: 6,
                      backgroundColor: timeMode === m ? C.yellow : C.white,
                      borderWidth: 2.5, borderColor: timeMode === m ? C.brown : '#C89A62',
                    }}
                  >
                    <Text style={{ fontFamily: F.display, fontSize: 12.5, color: C.darkInk }}>{label}</Text>
                  </View>
                </Pressable>
              ))}
            </View>

            {timeMode === 'now' && (
              <Text style={{ fontFamily: F.body, fontSize: 13.5, color: C.brown, marginTop: 8 }}>
                Meeting up right now. You can take the photo and confirm as soon as you create it.
              </Text>
            )}

            {timeMode !== 'now' && (
              <>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 }}>
                  {DAY_CHOICES.map((d) => (
                    <Pressable key={d} onPress={() => setDaysAhead(d)}>
                      <View
                        style={{
                          paddingHorizontal: 12, paddingVertical: 7, borderRadius: 6, margin: 3,
                          backgroundColor: daysAhead === d ? C.yellow : C.white,
                          borderWidth: 2.5, borderColor: daysAhead === d ? C.brown : '#C89A62',
                        }}
                      >
                        <Text style={{ fontFamily: F.display, fontSize: 13, color: C.darkInk }}>
                          {d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : `In ${d} days`}
                        </Text>
                      </View>
                    </Pressable>
                  ))}
                </View>

                {timeMode === 'preset' && (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 }}>
                    {TIME_CHOICES.map((t) => (
                      <Pressable key={t.hour} onPress={() => { setHour(t.hour); setMinute(0); }}>
                        <View
                          style={{
                            paddingHorizontal: 12, paddingVertical: 7, borderRadius: 6, margin: 3,
                            backgroundColor: hour === t.hour && minute === 0 ? C.yellow : C.white,
                            borderWidth: 2.5, borderColor: hour === t.hour && minute === 0 ? C.brown : '#C89A62',
                          }}
                        >
                          <Text style={{ fontFamily: F.display, fontSize: 13, color: C.darkInk }}>{t.label}</Text>
                        </View>
                      </Pressable>
                    ))}
                  </View>
                )}

                {timeMode === 'custom' && (
                  <View
                    style={{
                      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                      marginTop: 10,
                    }}
                  >
                    <Stepper
                      label="hour"
                      onUp={() => setHour((h) => (h + 1) % 24)}
                      onDown={() => setHour((h) => (h + 23) % 24)}
                    />
                    <Text
                      style={{
                        fontFamily: F.display, fontSize: 28, color: C.darkInk,
                        minWidth: 150, textAlign: 'center',
                      }}
                    >
                      {fmtClock(hour, minute)}
                    </Text>
                    <Stepper
                      label="min"
                      onUp={() => setMinute((m) => (m + 5) % 60)}
                      onDown={() => setMinute((m) => (m + 55) % 60)}
                    />
                  </View>
                )}
              </>
            )}

            {bonus.reason && (
              <Text style={{ fontFamily: F.display, fontSize: 13, color: C.labelGreen, marginTop: 6 }}>
                {bonus.reason}: vibe x2 for this hangout
              </Text>
            )}

            <View style={{ marginTop: 12, marginBottom: 6 }}>
              <OutlinedText size={20} color={C.labelPurple} outline={C.white} thickness={2}>Where?</OutlinedText>
            </View>
            <TextInput
              value={place}
              onChangeText={setPlace}
              placeholder="Name a spot"
              placeholderTextColor={C.fadedInk}
              style={{
                position: 'relative', backgroundColor: C.white, borderWidth: 2.5, borderColor: '#C89A62', borderRadius: 6,
                paddingHorizontal: 12, paddingVertical: 9, fontFamily: F.body, fontSize: 15, color: C.darkInk,
              }}
            />

            {cryptoOn && (
              <>
                <View style={{ marginTop: 14, marginBottom: 6 }}>
                  <OutlinedText size={20} color={C.labelOrange} outline={C.white} thickness={2}>Stake?</OutlinedText>
                </View>
                <View style={{ flexDirection: 'row' }}>
                  {STAKE_PRESETS.map((s) => {
                    const on = stakeUnits === s.units;
                    return (
                      <Pressable key={s.label} onPress={() => setStakeUnits(s.units)} style={{ flex: 1 }}>
                        <View
                          style={{
                            alignItems: 'center', marginHorizontal: 3, paddingVertical: 9, borderRadius: 6,
                            backgroundColor: on ? C.yellow : C.white,
                            borderWidth: 2.5, borderColor: on ? C.brown : '#C89A62',
                          }}
                        >
                          <Text style={{ fontFamily: F.display, fontSize: 14, color: C.darkInk }}>{s.label}</Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
                {stakeUnits && (
                  <Text style={{ fontFamily: F.body, fontSize: 12.5, color: C.brown, marginTop: 6 }}>
                    Everyone puts in {fmtUsd(stakeUnits)}. After creating, tap Stake to fund your spot.
                    Show up to get it back — whoever flakes loses their stake to the friends who came.
                  </Text>
                )}
              </>
            )}

            <View style={{ alignItems: 'center', marginTop: 14 }}>
              <Text style={{ fontFamily: F.body, fontSize: 13, color: C.brown, textAlign: 'center' }}>
                {timeMode === 'now'
                  ? 'Starting right now'
                  : date.toLocaleDateString(undefined, {
                      weekday: 'short', month: 'short', day: 'numeric',
                    }) + ' at ' + fmtClock(date.getHours(), date.getMinutes())}
                {stakeUnits ? ` · ${fmtUsd(stakeUnits)} stake` : ''}
              </Text>
            </View>

            {error && (
              <Text style={{ fontFamily: F.body, fontSize: 13, color: C.redPin, marginTop: 8, textAlign: 'center' }}>{error}</Text>
            )}
            <View style={{ marginTop: 12 }}>
              <DoodleButton
                label={busy ? 'Creating' : 'Create hangout'}
                bg={C.yellow} border={C.brown} seed={12} disabled={busy}
                onPress={create}
              />
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}
