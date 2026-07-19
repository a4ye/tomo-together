import { useCallback, useEffect, useRef, useState } from 'react';

export type WorldPlayer = {
  username: string;
  name: string;
  color: string;
  species: string;
  equipped: string[];
  x: number;
  y: number;
  online: boolean;
};

type State = {
  connected: boolean;
  world: { w: number; h: number } | null;
  me: string | null;
  players: Record<string, WorldPlayer>;
};

// Connects to the shared world at /ws, tracks everyone's live positions, and
// exposes sendMove (throttled). Reconnects on drop.
export function useWorldSocket(serverUrl: string, token: string | null) {
  const [state, setState] = useState<State>({
    connected: false, world: null, me: null, players: {},
  });
  const wsRef = useRef<WebSocket | null>(null);
  const lastSent = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (!token) return;
    const wsUrl = `${serverUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (!alive.current) return;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => setState((s) => ({ ...s, connected: true }));
      ws.onmessage = (ev) => {
        let m: any;
        try { m = JSON.parse(ev.data as string); } catch { return; }
        setState((s) => {
          if (m.type === 'init') {
            const players: Record<string, WorldPlayer> = {};
            for (const p of m.players) players[p.username] = p;
            return { ...s, world: m.world, me: m.me, players };
          }
          if (m.type === 'join') {
            return { ...s, players: { ...s.players, [m.player.username]: m.player } };
          }
          if (m.type === 'pos') {
            const cur = s.players[m.username];
            if (!cur) return s;
            return { ...s, players: { ...s.players, [m.username]: { ...cur, x: m.x, y: m.y, online: true } } };
          }
          if (m.type === 'offline') {
            const cur = s.players[m.username];
            if (!cur) return s;
            return { ...s, players: { ...s.players, [m.username]: { ...cur, online: false } } };
          }
          return s;
        });
      };
      const reconnect = () => {
        setState((s) => ({ ...s, connected: false }));
        if (alive.current && !retry) retry = setTimeout(() => { retry = null; connect(); }, 1500);
      };
      ws.onclose = reconnect;
      ws.onerror = () => { try { ws.close(); } catch {} };
    };
    connect();

    return () => {
      alive.current = false;
      if (retry) clearTimeout(retry);
      try { wsRef.current?.close(); } catch {}
    };
  }, [serverUrl, token]);

  // Stable across renders (uses only refs) so the movement loop's interval is
  // not torn down and recreated on every socket message.
  const sendMove = useCallback((x: number, y: number) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return;
    const now = Date.now();
    if (now - lastSent.current < 60) return; // ~16/s
    lastSent.current = now;
    ws.send(JSON.stringify({ type: 'move', x: Math.round(x), y: Math.round(y) }));
  }, []);

  return { ...state, sendMove };
}
