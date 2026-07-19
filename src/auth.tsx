import React, {
  createContext, useCallback, useContext, useMemo, useRef, useState,
} from 'react';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';
import type { User } from 'react-native-auth0';

export const AUTH0_CUSTOM_SCHEME = 'tomoyard';
export const AUTH0_SCOPE = 'openid profile email offline_access';

function normalizeDomain(value: string | undefined): string {
  return (value ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

const domain = normalizeDomain(process.env.EXPO_PUBLIC_AUTH0_DOMAIN);
const nativeClientId = (process.env.EXPO_PUBLIC_AUTH0_CLIENT_ID ?? '').trim();
const webClientId = (process.env.EXPO_PUBLIC_AUTH0_WEB_CLIENT_ID ?? '').trim();
export const auth0Audience = (process.env.EXPO_PUBLIC_AUTH0_AUDIENCE ?? '').trim();
const clientId = Platform.OS === 'web' ? webClientId : nativeClientId;
const isExpoGo = Platform.OS !== 'web'
  && Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

type Auth = {
  ready: boolean;
  authenticated: boolean;
  subject: string | null;
  user: User | null;
  configurationError: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  getAccessToken: () => Promise<string>;
};

const notConfigured = async (): Promise<never> => {
  throw new Error('Auth0 is not configured for this build.');
};

const fallback: Auth = {
  ready: true,
  authenticated: false,
  subject: null,
  user: null,
  configurationError: 'Auth0 is not configured for this build.',
  signIn: notConfigured,
  signOut: async () => {},
  getAccessToken: notConfigured,
};

const AuthContext = createContext<Auth>(fallback);

type Auth0Sdk = typeof import('react-native-auth0');
let auth0Sdk: Auth0Sdk | null = null;
let sdkLoadError: unknown = null;

// react-native-auth0 contains native code which Expo Go does not ship. Keeping
// the require guarded lets an accidentally opened Expo Go build show a useful
// setup message instead of crashing before React mounts.
if (domain && clientId && auth0Audience && !isExpoGo) {
  try {
    auth0Sdk = require('react-native-auth0') as Auth0Sdk;
  } catch (error) {
    sdkLoadError = error;
  }
}

function unavailableMessage(): string | null {
  if (!domain || !clientId || !auth0Audience) {
    return 'Auth0 is not configured for this build. Add the public Auth0 environment variables and rebuild.';
  }
  if (isExpoGo) {
    return 'Auth0 needs a Tomo Yard development or production build; it is not available in Expo Go.';
  }
  if (sdkLoadError || !auth0Sdk) {
    return 'Auth0 needs a Tomo Yard development or production build; it is not available in Expo Go.';
  }
  return null;
}

type Auth0CredentialError = {
  type?: unknown;
  code?: unknown;
  name?: unknown;
  status?: unknown;
  json?: unknown;
};

function errorCodes(error: Auth0CredentialError): string[] {
  const json = error.json && typeof error.json === 'object'
    ? error.json as Record<string, unknown>
    : null;
  return [error.type, error.code, error.name, json?.error, json?.code]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase());
}

/** Classifies credential failures that require a fresh interactive login. */
export function isTerminalCredentialError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const candidate = error as Auth0CredentialError;
  const codes = errorCodes(candidate);
  const transientCodes = new Set([
    'no_network', 'network_error', 'timeout_error', 'temporarily_unavailable', 'server_error',
  ]);
  if (codes.some((code) => transientCodes.has(code))) return false;

  const terminalCodes = new Set([
    'invalid_credentials', 'no_credentials', 'no_refresh_token', 'renew_failed',
    'login_required', 'invalid_grant', 'invalid_refresh_token', 'missing_refresh_token',
    'revoked', 'dpop_key_missing', 'dpop_not_configured', 'dpop_key_mismatch',
  ]);
  return codes.some((code) => terminalCodes.has(code));
}

function AuthBridge({ children }: { children: React.ReactNode }) {
  // This component is rendered only after the SDK was loaded successfully.
  const sdk = auth0Sdk as Auth0Sdk;
  const {
    authorize, clearCredentials, clearSession, getCredentials, isLoading, user,
  } = sdk.useAuth0();
  const [credentialsInvalid, setCredentialsInvalid] = useState(false);
  const credentialCleanup = useRef<Promise<void> | null>(null);

  const signIn = useCallback(async () => {
    await authorize(
      {
        audience: auth0Audience,
        scope: AUTH0_SCOPE,
        redirectUrl: Platform.OS === 'web' && typeof window !== 'undefined'
          ? window.location.origin
          : undefined,
      },
      { customScheme: AUTH0_CUSTOM_SCHEME },
    );
    setCredentialsInvalid(false);
  }, [authorize]);

  const signOut = useCallback(async () => {
    await clearSession(
      Platform.OS === 'web' && typeof window !== 'undefined'
        ? { returnToUrl: window.location.origin }
        : undefined,
      { customScheme: AUTH0_CUSTOM_SCHEME },
    );
  }, [clearSession]);

  const getAccessToken = useCallback(async () => {
    try {
      const credentials = await getCredentials(AUTH0_SCOPE, 60);
      if (!credentials.accessToken) {
        throw Object.assign(
          new Error('Auth0 did not return an API access token.'),
          { type: 'INVALID_CREDENTIALS' },
        );
      }
      return credentials.accessToken;
    } catch (error) {
      if (isTerminalCredentialError(error)) {
        // Fail the UI closed immediately. clearCredentials also updates the
        // SDK user state; a local flag covers the rare case where that cleanup
        // itself cannot access the platform credential store.
        setCredentialsInvalid(true);
        if (!credentialCleanup.current) {
          credentialCleanup.current = clearCredentials()
            .catch(() => {})
            .finally(() => { credentialCleanup.current = null; });
        }
        await credentialCleanup.current;
      }
      // Explicit network/transient failures leave the current session intact.
      throw error;
    }
  }, [clearCredentials, getCredentials]);

  const visibleUser = credentialsInvalid ? null : user;

  const value = useMemo<Auth>(() => ({
    ready: !isLoading,
    authenticated: Boolean(visibleUser),
    subject: visibleUser?.sub ?? null,
    user: visibleUser,
    configurationError: null,
    signIn,
    signOut,
    getAccessToken,
  }), [getAccessToken, isLoading, signIn, signOut, visibleUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const error = unavailableMessage();
  if (error || !auth0Sdk) {
    return (
      <AuthContext.Provider value={{ ...fallback, configurationError: error }}>
        {children}
      </AuthContext.Provider>
    );
  }

  const Provider = auth0Sdk.Auth0Provider as React.ComponentType<React.PropsWithChildren<{
    domain: string;
    clientId: string;
    useDPoP: boolean;
    audience: string;
    scope: string;
    cacheLocation: 'memory';
    useRefreshTokens: boolean;
    useRefreshTokensFallback: boolean;
  }>>;

  return (
    <Provider
      domain={domain}
      clientId={clientId}
      useDPoP={false}
      audience={auth0Audience}
      scope={AUTH0_SCOPE}
      cacheLocation="memory"
      useRefreshTokens
      useRefreshTokensFallback
    >
      <AuthBridge>{children}</AuthBridge>
    </Provider>
  );
}

export function useAuth(): Auth {
  return useContext(AuthContext);
}
