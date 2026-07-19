import { FileSystemUploadType, uploadAsync } from 'expo-file-system/legacy';
import {
  Activity, FriendCard, FriendProfile, FriendView, Hangout, Holiday, Me, PublicUser,
  Suggestion, Wallet, WardrobeItem,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(
  serverUrl: string,
  token: string | null,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 12000);
  try {
    res = await fetch(`${serverUrl}${path}`, { method, headers, body: payload, signal: abort.signal });
  } catch (e) {
    const timedOut = abort.signal.aborted;
    const detail = timedOut ? ' (timed out)' : e instanceof Error ? ` (${e.message})` : '';
    throw new ApiError(0, `Cannot reach the server. Check the server address and your connection.${detail}`);
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (json as { error?: string }).error || 'Request failed');
  return json as T;
}

export function makeApi(serverUrl: string, token: string | null) {
  return {
    register: (b: {
      username: string; name: string; birthday: string; password: string;
      color: string; species: string;
    }) =>
      call<{ token: string; me: Me }>(serverUrl, null, 'POST', '/auth/register', b),
    login: (b: { username: string; password: string }) =>
      call<{ token: string; me: Me }>(serverUrl, null, 'POST', '/auth/login', b),
    me: () => call<{ me: Me }>(serverUrl, token, 'GET', '/me'),
    setAvatar: (b: { color: string; equipped: string[]; species: string }) =>
      call<{ me: Me }>(serverUrl, token, 'PUT', '/me/avatar', b),
    catalog: () =>
      call<{ activities: Activity[]; items: WardrobeItem[]; holidays: Holiday[] }>(
        serverUrl, null, 'GET', '/catalog'),
    searchUsers: (q: string) =>
      call<{ users: PublicUser[] }>(serverUrl, token, 'GET', `/users/search?q=${encodeURIComponent(q)}`),
    friends: () =>
      call<{ friends: FriendView[]; incoming: FriendView[]; outgoing: FriendView[] }>(
        serverUrl, token, 'GET', '/friends'),
    friendProfile: (username: string) =>
      call<{ friend: FriendProfile }>(
        serverUrl, token, 'GET', `/friends/${encodeURIComponent(username)}`),
    requestFriend: (username: string) =>
      call<{ ok: boolean; accepted: boolean }>(serverUrl, token, 'POST', '/friends/request', { username }),
    acceptFriend: (username: string) =>
      call<{ ok: boolean }>(serverUrl, token, 'POST', '/friends/accept', { username }),
    friendCard: (username: string) =>
      call<{ card: FriendCard }>(serverUrl, token, 'GET', `/friends/${encodeURIComponent(username)}/card`),
    suggestion: () =>
      call<{ suggestion: Suggestion | null }>(serverUrl, token, 'GET', '/suggestions'),
    rankedActivities: (withUsernames: string[]) =>
      call<{ activities: Activity[] }>(
        serverUrl, token, 'GET', `/activities/ranked?with=${withUsernames.join(',')}`),
    duel: (winner: string, loser: string) =>
      call<{ ok: boolean }>(serverUrl, token, 'POST', '/duels', { winner, loser }),
    createHangout: (b: {
      activity: string; date: string; place: string; friendUsernames: string[];
      stakeUnits?: string;
    }) =>
      call<{ hangout: Hangout }>(serverUrl, token, 'POST', '/hangouts', b),
    hangouts: () => call<{ hangouts: Hangout[] }>(serverUrl, token, 'GET', '/hangouts'),
    hangout: (id: number) => call<{ hangout: Hangout }>(serverUrl, token, 'GET', `/hangouts/${id}`),
    stakeHangout: (id: number) =>
      call<{ hangout: Hangout }>(serverUrl, token, 'POST', `/hangouts/${id}/stake`),
    settleHangout: (id: number) =>
      call<{ hangout: Hangout }>(serverUrl, token, 'POST', `/hangouts/${id}/settle`),
    endHangout: (id: number) =>
      call<{ hangout: Hangout }>(serverUrl, token, 'POST', `/hangouts/${id}/end`),
    wallet: () => call<Wallet>(serverUrl, token, 'GET', '/wallet'),
    addFunds: () =>
      call<{ treasuryAddress?: string; depositAddresses?: unknown }>(
        serverUrl, token, 'POST', '/wallet/add-funds'),
    refreshDeposits: () =>
      call<{ creditedUnits?: string; balanceUnits?: string }>(serverUrl, token, 'POST', '/wallet/refresh'),
    withdraw: (amountUnits: string, destination: {
      chain_type: string; chain_id: string; token_address: string; recipient_address: string;
    }) => call<{ ok: boolean; status?: string; balanceUnits?: string }>(
      serverUrl, token, 'POST', '/wallet/withdraw', { amountUnits, destination }),
    uploadPhoto: async (id: number, uri: string) => {
      let res;
      try {
        res = await uploadAsync(`${serverUrl}/hangouts/${id}/photo`, uri, {
          httpMethod: 'POST',
          uploadType: FileSystemUploadType.MULTIPART,
          fieldName: 'photo',
          mimeType: 'image/jpeg',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
      } catch (e) {
        const detail = e instanceof Error ? ` (${e.message})` : '';
        throw new ApiError(0, `Could not upload the photo.${detail}`);
      }
      if (res.status >= 300) {
        let msg = 'Upload failed';
        try {
          msg = JSON.parse(res.body).error || msg;
        } catch {}
        throw new ApiError(res.status, msg);
      }
      return JSON.parse(res.body) as { hangout: Hangout };
    },
    nfcToken: (id: number) =>
      call<{ payload: string }>(serverUrl, token, 'GET', `/hangouts/${id}/nfc-token`),
    confirm: (id: number, username: string, nfcToken: string) =>
      call<{ hangout: Hangout; vibeGain: number; acornGain: number; bonusReason: string | null }>(
        serverUrl, token, 'POST', `/hangouts/${id}/confirm`, { username, token: nfcToken }),
    memories: () => call<{ memories: Hangout[] }>(serverUrl, token, 'GET', '/memories'),
    leaderboard: () =>
      call<{ leaderboard: (PublicUser & { count: number; isMe: boolean })[]; month: string }>(
        serverUrl, token, 'GET', '/leaderboard'),
    buyItem: (itemId: string) => call<{ me: Me }>(serverUrl, token, 'POST', '/shop/buy', { itemId }),
    secretAcorns: () => call<{ me: Me }>(serverUrl, token, 'POST', '/secret/acorns'),
  };
}

export type Api = ReturnType<typeof makeApi>;
