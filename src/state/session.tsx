import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from 'react';
import { Api, makeApi } from '../api';
import { Me } from '../types';

const KEY = 'ty:session:v1';
export const DEFAULT_SERVER = 'http://100.66.193.176:4000';

type Session = {
  ready: boolean;
  serverUrl: string;
  token: string | null;
  me: Me | null;
  api: Api;
  signIn: (serverUrl: string, token: string, me: Me) => void;
  signOut: () => void;
  setMe: (me: Me) => void;
  refreshMe: () => Promise<void>;
};

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER);
  const [token, setToken] = useState<string | null>(null);
  const [me, setMeState] = useState<Me | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (raw) {
          const s = JSON.parse(raw);
          if (s.serverUrl) setServerUrl(s.serverUrl);
          if (s.token) setToken(s.token);
          if (s.me) setMeState(s.me);
        }
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  const persist = useCallback((s: { serverUrl: string; token: string | null; me: Me | null }) => {
    AsyncStorage.setItem(KEY, JSON.stringify(s)).catch(() => {});
  }, []);

  const signIn = useCallback((url: string, t: string, m: Me) => {
    setServerUrl(url);
    setToken(t);
    setMeState(m);
    persist({ serverUrl: url, token: t, me: m });
  }, [persist]);

  const signOut = useCallback(() => {
    setToken(null);
    setMeState(null);
    persist({ serverUrl, token: null, me: null });
  }, [persist, serverUrl]);

  const setMe = useCallback((m: Me) => {
    setMeState(m);
    persist({ serverUrl, token, me: m });
  }, [persist, serverUrl, token]);

  const api = useMemo(() => makeApi(serverUrl, token), [serverUrl, token]);

  const refreshMe = useCallback(async () => {
    if (!token) return;
    try {
      const { me: m } = await api.me();
      setMe(m);
    } catch {
      // offline or bad token: keep cached profile
    }
  }, [api, token, setMe]);

  const value = useMemo<Session>(
    () => ({ ready, serverUrl, token, me, api, signIn, signOut, setMe, refreshMe }),
    [ready, serverUrl, token, me, api, signIn, signOut, setMe, refreshMe]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
