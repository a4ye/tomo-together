import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { BackHandler } from 'react-native';
import { Route } from '../types';

type Nav = {
  route: Route;
  push: (r: Route) => void;
  back: () => void;
  home: () => void;
  replace: (r: Route) => void;
};

const NavCtx = createContext<Nav | null>(null);

export function NavProvider({ children }: { children: React.ReactNode }) {
  const [stack, setStack] = useState<Route[]>([{ name: 'yard' }]);

  const push = useCallback((r: Route) => setStack((s) => [...s, r]), []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const home = useCallback(() => setStack([{ name: 'yard' }]), []);
  const replace = useCallback((r: Route) => setStack((s) => [...s.slice(0, -1), r]), []);

  // Hardware back pops our stack instead of leaving the app.
  const depthRef = useRef(1);
  depthRef.current = stack.length;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (depthRef.current > 1) {
        setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

  const value = useMemo<Nav>(
    () => ({ route: stack[stack.length - 1], push, back, home, replace }),
    [stack, push, back, home, replace]
  );
  return <NavCtx.Provider value={value}>{children}</NavCtx.Provider>;
}

export function useNav(): Nav {
  const v = useContext(NavCtx);
  if (!v) throw new Error('useNav outside NavProvider');
  return v;
}
