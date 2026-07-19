import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// Deliberately low so "you haven't hung out in a while" is easy to demo:
// a reminder fires ~90s after your last hangout with a friend (or after you
// added them, if you never have).
export const STALE_THRESHOLD_MS = 90 * 1000;
const FIRST_SEEN_KEY = 'ty:friendFirstSeen:v1';
const CHANNEL = 'stale-friends';

// Show the banner even when the app is in the foreground.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function ensureNotifPermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const current = await Notifications.getPermissionsAsync();
    let granted = current.granted;
    if (!granted && current.canAskAgain) {
      const asked = await Notifications.requestPermissionsAsync();
      granted = asked.granted;
    }
    if (granted && Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: 'Hangout reminders',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    return granted;
  } catch {
    return false;
  }
}

type StaleFriend = { username: string; name: string; lastHangoutAt: string | null };

// Reschedule one reminder per friend from fresh data. Idempotent: each friend's
// reminder uses a stable identifier, so re-calling just updates the fire time.
export async function syncStaleReminders(friends: StaleFriend[]): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    // For never-hung-out friends, anchor staleness to when we first saw them
    // (persisted) so the timer runs down instead of resetting every sync.
    let firstSeen: Record<string, number> = {};
    try {
      firstSeen = JSON.parse((await AsyncStorage.getItem(FIRST_SEEN_KEY)) || '{}');
    } catch {}
    const now = Date.now();
    let dirty = false;
    for (const f of friends) {
      if (!f.lastHangoutAt && firstSeen[f.username] == null) {
        firstSeen[f.username] = now;
        dirty = true;
      }
    }
    if (dirty) AsyncStorage.setItem(FIRST_SEEN_KEY, JSON.stringify(firstSeen)).catch(() => {});

    // Drop reminders for friends that are gone, then (re)schedule current ones.
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    const usernames = new Set(friends.map((f) => f.username));
    await Promise.all(
      scheduled
        .filter((n) => {
          const d = n.content.data as { kind?: string; username?: string } | undefined;
          return d?.kind === 'stale' && !usernames.has(d.username ?? '');
        })
        .map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier))
    );

    for (const f of friends) {
      const base = f.lastHangoutAt ? new Date(f.lastHangoutAt).getTime() : firstSeen[f.username];
      if (!base) continue;
      const seconds = Math.max(2, Math.round((base + STALE_THRESHOLD_MS - now) / 1000));
      if (seconds > 6 * 3600) continue; // nothing more than 6h out
      await Notifications.scheduleNotificationAsync({
        identifier: `stale:${f.username}`,
        content: {
          title: 'Miss hanging out?',
          body: `You and ${f.name} haven't hung out in a while`,
          data: { kind: 'stale', username: f.username },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds,
          channelId: CHANNEL,
        },
      });
    }
  } catch {
    // notifications are best-effort; never break the app over them
  }
}

// Username from a tapped stale reminder, or null.
export function staleUsernameFromResponse(
  resp: Notifications.NotificationResponse | null
): string | null {
  const d = resp?.notification.request.content.data as
    | { kind?: string; username?: string }
    | undefined;
  return d?.kind === 'stale' && d.username ? d.username : null;
}
