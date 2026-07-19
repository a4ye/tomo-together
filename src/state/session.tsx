import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { Platform } from 'react-native';
import { Api, ApiError, AuthProfileInput, makeApi } from '../api';
import { useAuth } from '../auth';
import { Me } from '../types';

const PROFILE_KEY = 'ty:profile:v2';
const LEGACY_SESSION_KEY = 'ty:session:v1';
const LEGACY_SECURE_TOKEN_KEY = 'ty:legacy-token:v1';
const LEGACY_SUBJECT_PREFIX = 'legacy:';
export const DEFAULT_SERVER = 'https://ht6.icinoxis.net';

type CachedProfile = {
  subject: string;
  me: Me;
};

type Session = {
  ready: boolean;
  authenticated: boolean;
  auth0Authenticated: boolean;
  authConfigurationError: string | null;
  serverUrl: string;
  me: Me | null;
  api: Api;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  completeProfile: (profile: AuthProfileInput) => Promise<Me>;
  setMe: (me: Me) => void;
  refreshMe: () => Promise<void>;
};

const Ctx = createContext<Session | null>(null);

// The server is fixed: everyone talks to the hosted instance. Persisted
// serverUrl overrides from older builds are deliberately ignored so stale
// installs migrate to the public server automatically.
const serverUrl = DEFAULT_SERVER;

function isMe(value: unknown): value is Me {
  return Boolean(value && typeof value === 'object'
    && 'username' in value && typeof (value as { username?: unknown }).username === 'string');
}

function legacySubject(profile: Me): string {
  return `${LEGACY_SUBJECT_PREFIX}${profile.username}`;
}

type LegacySessionData = {
  understood: boolean;
  token: string | null;
  me: Me | null;
};

type SecureLegacyTokenStore = {
  read: () => Promise<string | null>;
  write: (token: string) => Promise<void>;
};

/**
 * Parses the old AsyncStorage session without treating malformed data as safe
 * to delete. Exported so the security-sensitive migration can be unit tested
 * without mounting the provider.
 */
export function parseLegacySession(raw: string | null): LegacySessionData {
  if (!raw) return { understood: true, token: null, me: null };

  try {
    const value = JSON.parse(raw) as { token?: unknown; me?: unknown };
    return {
      understood: true,
      token: typeof value.token === 'string' && value.token ? value.token : null,
      me: isMe(value.me) ? value.me : null,
    };
  } catch {
    return { understood: false, token: null, me: null };
  }
}

/**
 * Returns a token only after it has been read from SecureStore. A legacy
 * AsyncStorage bearer is never returned directly. A newly written token is
 * read back and compared so callers only delete the original after verified
 * secure persistence.
 */
export async function migrateLegacyTokenToSecureStore(
  legacyToken: string | null,
  store: SecureLegacyTokenStore,
): Promise<{ token: string | null; securelyPersisted: boolean }> {
  let secureToken: string | null;
  try {
    secureToken = await store.read();
  } catch {
    return { token: null, securelyPersisted: false };
  }

  if (secureToken) {
    return {
      token: secureToken,
      // If both copies exist, only the exact original value proves that this
      // particular AsyncStorage bearer completed migration.
      securelyPersisted: !legacyToken || secureToken === legacyToken,
    };
  }
  if (!legacyToken) return { token: null, securelyPersisted: false };

  try {
    await store.write(legacyToken);
    const verifiedToken = await store.read();
    if (verifiedToken === legacyToken) {
      return { token: verifiedToken, securelyPersisted: true };
    }
  } catch {
    // Retain the AsyncStorage record for a later retry, but fail closed.
  }
  return { token: null, securelyPersisted: false };
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const [cacheReady, setCacheReady] = useState(false);
  const [profileReady, setProfileReady] = useState(false);
  const [legacyToken, setLegacyToken] = useState<string | null>(null);
  const [me, setMeState] = useState<Me | null>(null);
  const cachedProfile = useRef<CachedProfile | null>(null);

  useEffect(() => {
    let active = true;
    const restore = async () => {
      const [profileRaw, legacyRaw] = await Promise.all([
        AsyncStorage.getItem(PROFILE_KEY),
        AsyncStorage.getItem(LEGACY_SESSION_KEY),
      ]);

      if (profileRaw) {
        try {
          const value = JSON.parse(profileRaw) as Partial<CachedProfile>;
          if (typeof value.subject === 'string' && isMe(value.me)) {
            cachedProfile.current = value as CachedProfile;
          }
        } catch {}
      }

      // One-time native migration for already signed-in users. Their legacy
      // token remains a legacy credential (never linked by username/email), but
      // leaves AsyncStorage for the OS keychain/keystore before it is reused.
      if (Platform.OS !== 'web') {
        const legacy = parseLegacySession(legacyRaw);
        let profileMigrated = !legacy.me;
        if (legacy.me) {
          const migrated = { subject: legacySubject(legacy.me), me: legacy.me };
          cachedProfile.current = migrated;
          try {
            await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(migrated));
            profileMigrated = true;
          } catch {
            // Keep the combined legacy record so its profile can be retried.
          }
        }

        const migratedToken = await migrateLegacyTokenToSecureStore(legacy.token, {
          read: () => SecureStore.getItemAsync(LEGACY_SECURE_TOKEN_KEY),
          write: (token) => SecureStore.setItemAsync(LEGACY_SECURE_TOKEN_KEY, token),
        });

        // Preserve any malformed record, and preserve a valid legacy bearer
        // until a SecureStore read has verified its persistence.
        if (legacyRaw && legacy.understood && profileMigrated
          && (!legacy.token || migratedToken.securelyPersisted)) {
          await AsyncStorage.removeItem(LEGACY_SESSION_KEY).catch(() => {});
        }
        if (active) setLegacyToken(migratedToken.token);
      } else {
        // Web has no OS secure store. Never continue persisting bearer tokens
        // in AsyncStorage/localStorage; web users authenticate through Auth0.
        await AsyncStorage.removeItem(LEGACY_SESSION_KEY);
      }
    };

    restore()
      .catch(() => {})
      .finally(() => { if (active) setCacheReady(true); });
    return () => { active = false; };
  }, []);

  const getAccessToken = useCallback(async () => {
    if (auth.authenticated) return auth.getAccessToken();
    if (legacyToken) return legacyToken;
    throw new Error('Sign in is required.');
  }, [auth.authenticated, auth.getAccessToken, legacyToken]);
  const api = useMemo(() => makeApi(serverUrl, getAccessToken), [getAccessToken]);

  const persistProfile = useCallback((profile: Me | null) => {
    if (!profile) {
      cachedProfile.current = null;
      AsyncStorage.removeItem(PROFILE_KEY).catch(() => {});
      return;
    }
    const subject = auth.subject ?? (legacyToken ? legacySubject(profile) : null);
    if (!subject) return;
    const value = { subject, me: profile };
    cachedProfile.current = value;
    AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(value)).catch(() => {});
  }, [auth.subject, legacyToken]);

  const setMe = useCallback((profile: Me) => {
    setMeState(profile);
    persistProfile(profile);
  }, [persistProfile]);

  const clearLegacyCredentials = useCallback(async () => {
    setLegacyToken(null);
    await AsyncStorage.removeItem(LEGACY_SESSION_KEY).catch(() => {});
    if (Platform.OS !== 'web') {
      await SecureStore.deleteItemAsync(LEGACY_SECURE_TOKEN_KEY).catch(() => {});
    }
  }, []);

  useEffect(() => {
    // An explicit Auth0 login supersedes (but never links to) the transitional
    // credential, so do not leave both identities stored on the device.
    if (auth.authenticated && legacyToken) clearLegacyCredentials().catch(() => {});
  }, [auth.authenticated, clearLegacyCredentials, legacyToken]);

  useEffect(() => {
    if (!auth.ready || !cacheReady) return;

    let active = true;
    if (auth.authenticated && auth.subject) {
      const cached = cachedProfile.current;
      if (cached?.subject === auth.subject) setMeState(cached.me);
      else setMeState(null);
      setProfileReady(false);

      api.authProfile()
        .then(({ me: profile }) => {
          if (!active) return;
          setMeState(profile);
          persistProfile(profile);
        })
        .catch((error) => {
          if (!active) return;
          if (error instanceof ApiError && error.status === 404) {
            setMeState(null);
            persistProfile(null);
          }
          // On network failure, retain only a same-sub cached profile.
        })
        .finally(() => { if (active) setProfileReady(true); });
      return () => { active = false; };
    }

    if (legacyToken) {
      const cached = cachedProfile.current;
      if (cached?.subject.startsWith(LEGACY_SUBJECT_PREFIX)) setMeState(cached.me);
      else setMeState(null);
      setProfileReady(false);

      // Validation also makes the migration self-expiring: once production
      // disables legacy auth, 401/403 removes the migrated credential locally.
      api.me()
        .then(({ me: profile }) => {
          if (!active) return;
          setMeState(profile);
          persistProfile(profile);
        })
        .catch(async (error) => {
          if (!active) return;
          if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
            setMeState(null);
            persistProfile(null);
            await clearLegacyCredentials();
          }
          // A network failure retains the securely backed legacy session.
        })
        .finally(() => { if (active) setProfileReady(true); });
      return () => { active = false; };
    }

    setMeState(null);
    persistProfile(null);
    setProfileReady(true);
    return () => { active = false; };
  }, [
    api, auth.authenticated, auth.ready, auth.subject, cacheReady,
    clearLegacyCredentials, legacyToken, persistProfile,
  ]);

  const signIn = useCallback(async () => auth.signIn(), [auth.signIn]);

  const signOut = useCallback(async () => {
    if (auth.authenticated) await auth.signOut();
    await clearLegacyCredentials();
    setMeState(null);
    persistProfile(null);
    setProfileReady(true);
  }, [auth.authenticated, auth.signOut, clearLegacyCredentials, persistProfile]);

  const completeProfile = useCallback(async (profile: AuthProfileInput) => {
    if (!auth.authenticated) throw new Error('Sign in with Auth0 before creating a profile.');
    const { me: saved } = await api.saveAuthProfile(profile);
    setMe(saved);
    return saved;
  }, [api, auth.authenticated, setMe]);

  const authenticated = auth.authenticated || Boolean(legacyToken);
  const refreshMe = useCallback(async () => {
    if (!authenticated) return;
    try {
      const { me: profile } = await api.me();
      setMe(profile);
    } catch {
      // Offline or temporarily unauthorized: keep the same-session profile.
    }
  }, [api, authenticated, setMe]);

  const ready = auth.ready && cacheReady && profileReady;
  const value = useMemo<Session>(() => ({
    ready,
    authenticated,
    auth0Authenticated: auth.authenticated,
    authConfigurationError: auth.configurationError,
    serverUrl,
    me,
    api,
    signIn,
    signOut,
    completeProfile,
    setMe,
    refreshMe,
  }), [
    api, auth.authenticated, auth.configurationError, authenticated, completeProfile, me, ready,
    refreshMe, setMe, signIn, signOut,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const value = useContext(Ctx);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}
