import { FileSystemUploadType, uploadAsync } from 'expo-file-system/legacy';
import {
  Activity, FriendCard, FriendProfile, FriendView, Hangout, Holiday, Me, PublicUser,
  Suggestion, Wallet, WardrobeItem, WithdrawalDestination, WithdrawalResult,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type AccessTokenSource = string | null | (() => Promise<string | null>);

async function resolveAccessToken(source: AccessTokenSource): Promise<string | null> {
  return typeof source === 'function' ? source() : source;
}

async function call<T>(
  serverUrl: string,
  tokenSource: AccessTokenSource,
  method: string,
  path: string,
  body?: unknown,
  requestHeaders: Record<string, string> = {},
): Promise<T> {
  const headers: Record<string, string> = { ...requestHeaders };
  const token = await resolveAccessToken(tokenSource);
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
  if (!res.ok) {
    const error = json as { error?: string; message?: string };
    throw new ApiError(res.status, error.message || error.error || 'Request failed');
  }
  return json as T;
}

export type AuthProfileInput = {
  username: string;
  name: string;
  birthday: string;
  color: string;
  species: string;
};

export function makeApi(serverUrl: string, tokenSource: AccessTokenSource) {
  return {
    register: (b: {
      username: string; name: string; birthday: string; password: string;
      color: string; species: string;
    }) =>
      call<{ token: string; me: Me }>(serverUrl, null, 'POST', '/auth/register', b),
    login: (b: { username: string; password: string }) =>
      call<{ token: string; me: Me }>(serverUrl, null, 'POST', '/auth/login', b),
    authProfile: () => call<{ me: Me | null }>(serverUrl, tokenSource, 'GET', '/auth/profile'),
    saveAuthProfile: (body: AuthProfileInput) =>
      call<{ me: Me }>(serverUrl, tokenSource, 'PUT', '/auth/profile', body),
    me: () => call<{ me: Me }>(serverUrl, tokenSource, 'GET', '/me'),
    setAvatar: (b: { color: string; equipped: string[]; species: string }) =>
      call<{ me: Me }>(serverUrl, tokenSource, 'PUT', '/me/avatar', b),
    catalog: () =>
      call<{ activities: Activity[]; items: WardrobeItem[]; holidays: Holiday[] }>(
        serverUrl, null, 'GET', '/catalog'),
    searchUsers: (q: string) =>
      call<{ users: PublicUser[] }>(serverUrl, tokenSource, 'GET', `/users/search?q=${encodeURIComponent(q)}`),
    friends: () =>
      call<{ friends: FriendView[]; incoming: FriendView[]; outgoing: FriendView[] }>(
        serverUrl, tokenSource, 'GET', '/friends'),
    friendProfile: (username: string) =>
      call<{ friend: FriendProfile }>(
        serverUrl, tokenSource, 'GET', `/friends/${encodeURIComponent(username)}`),
    requestFriend: (username: string) =>
      call<{ ok: boolean; accepted: boolean }>(serverUrl, tokenSource, 'POST', '/friends/request', { username }),
    acceptFriend: (username: string) =>
      call<{ ok: boolean }>(serverUrl, tokenSource, 'POST', '/friends/accept', { username }),
    friendCard: (username: string) =>
      call<{ card: FriendCard }>(serverUrl, tokenSource, 'GET', `/friends/${encodeURIComponent(username)}/card`),
    suggestion: () =>
      call<{ suggestion: Suggestion | null }>(serverUrl, tokenSource, 'GET', '/suggestions'),
    rankedActivities: (withUsernames: string[]) =>
      call<{ activities: Activity[] }>(
        serverUrl, tokenSource, 'GET', `/activities/ranked?with=${withUsernames.join(',')}`),
    duel: (winner: string, loser: string) =>
      call<{ ok: boolean }>(serverUrl, tokenSource, 'POST', '/duels', { winner, loser }),
    createHangout: (b: {
      activity: string; date: string; place: string; friendUsernames: string[];
      stakeUnits?: string;
    }) =>
      call<{ hangout: Hangout }>(serverUrl, tokenSource, 'POST', '/hangouts', b),
    hangouts: () => call<{ hangouts: Hangout[] }>(serverUrl, tokenSource, 'GET', '/hangouts'),
    hangout: (id: number) => call<{ hangout: Hangout }>(serverUrl, tokenSource, 'GET', `/hangouts/${id}`),
    stakeHangout: (id: number) =>
      call<{ hangout: Hangout }>(serverUrl, tokenSource, 'POST', `/hangouts/${id}/stake`),
    settleHangout: (id: number) =>
      call<{ hangout: Hangout }>(serverUrl, tokenSource, 'POST', `/hangouts/${id}/settle`),
    wallet: () => call<Wallet>(serverUrl, tokenSource, 'GET', '/wallet'),
    addFunds: () =>
      call<{ treasuryAddress?: string; depositAddresses?: unknown }>(
        serverUrl, tokenSource, 'POST', '/wallet/add-funds'),
    refreshDeposits: () =>
      call<{ creditedUnits?: string; balanceUnits?: string }>(serverUrl, tokenSource, 'POST', '/wallet/refresh'),
    withdraw: (amountUnits: string, destination: WithdrawalDestination, idempotencyKey: string) =>
      call<WithdrawalResult>(
        serverUrl,
        tokenSource,
        'POST',
        '/wallet/withdraw',
        { amountUnits, destination },
        { 'Idempotency-Key': idempotencyKey },
      ),
    uploadPhoto: async (id: number, uri: string) => {
      let res;
      try {
        const token = await resolveAccessToken(tokenSource);
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
      call<{ payload: string }>(serverUrl, tokenSource, 'GET', `/hangouts/${id}/nfc-token`),
    confirm: (id: number, username: string, nfcToken: string) =>
      call<{ hangout: Hangout; vibeGain: number; acornGain: number; bonusReason: string | null }>(
        serverUrl, tokenSource, 'POST', `/hangouts/${id}/confirm`, { username, token: nfcToken }),
    memories: () => call<{ memories: Hangout[] }>(serverUrl, tokenSource, 'GET', '/memories'),
    leaderboard: () =>
      call<{ leaderboard: (PublicUser & { count: number; isMe: boolean })[]; month: string }>(
        serverUrl, tokenSource, 'GET', '/leaderboard'),
    buyItem: (itemId: string) => call<{ me: Me }>(serverUrl, tokenSource, 'POST', '/shop/buy', { itemId }),
    secretAcorns: () => call<{ me: Me }>(serverUrl, tokenSource, 'POST', '/secret/acorns'),
  };
}

export type Api = ReturnType<typeof makeApi>;
