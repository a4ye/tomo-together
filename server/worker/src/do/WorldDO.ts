// The walkable world. Replaces the `ws` WebSocketServer plus the two in-process
// maps it depended on (`worldTickets` and `live`) with one Durable Object.
//
// A single named instance ("world") is the right shape because the Express build
// was only ever correct as a single process: one shared `live` map, one shared
// ticket table, and a broadcast that assumed every socket was local. The DO
// gives that back, exactly, across isolates.
//
// Two deliberate strengthenings, both invisible on the wire:
//  * tickets are written to DO storage instead of a Map, because a DO may be
//    evicted mid-flight far more often than an App Service restarts, and losing
//    a ticket would turn a valid handshake into a 401;
//  * hibernation is used, so an idle world costs nothing. Per-socket state
//    (username, position, persist throttle) rides in the socket attachment
//    rather than a closure, since closures do not survive hibernation.

import type { Env } from '../env';
import { Store, type UserRow } from '../ports/store';
import { clampPos, spawnPoint, worldPlayer } from '../domain/logic';
import { WORLD_H, WORLD_W } from '../domain/catalog';

const DEFAULT_WORLD_TICKET_TTL_MS = 45_000;

interface Ticket {
  userId: number;
  expiresAt: number;
}

interface Attachment {
  userId: number;
  username: string;
  x: number;
  y: number;
  lastPersist: number;
}

export class WorldDO implements DurableObject {
  private readonly store: Store;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.store = new Store(env.DB);
  }

  /**
   * Production is deliberately fixed inside the required 30-60 second window.
   * Tests may shorten it to make expiry coverage deterministic and fast.
   */
  private ticketTtlMs(): number {
    if (this.env.NODE_ENV !== 'test') return DEFAULT_WORLD_TICKET_TTL_MS;
    const override = Number(this.env.WORLD_WS_TICKET_TTL_MS);
    return Number.isInteger(override) && override > 0 && override <= 60_000
      ? override
      : DEFAULT_WORLD_TICKET_TTL_MS;
  }

  private async pruneTickets(now = Date.now()): Promise<void> {
    const all = await this.state.storage.list<Ticket>({ prefix: 'ticket:' });
    const dead: string[] = [];
    for (const [key, entry] of all) if (!entry || entry.expiresAt <= now) dead.push(key);
    if (dead.length) await this.state.storage.delete(dead);
  }

  private async issueTicket(userId: number): Promise<string> {
    await this.pruneTickets();
    // Keep at most one live ticket per identity, so an abandoned ticket does
    // not stay useful until its expiry.
    const all = await this.state.storage.list<Ticket>({ prefix: 'ticket:' });
    const mine: string[] = [];
    for (const [key, entry] of all) if (entry.userId === userId) mine.push(key);
    if (mine.length) await this.state.storage.delete(mine);

    const raw = new Uint8Array(32);
    crypto.getRandomValues(raw);
    const ticket = btoa(String.fromCharCode(...raw))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    await this.state.storage.put(`ticket:${ticket}`, {
      userId,
      expiresAt: Date.now() + this.ticketTtlMs(),
    });
    return ticket;
  }

  /**
   * Delete before checking expiry or touching the database: every recognized
   * ticket gets exactly one connection attempt, including an expired one.
   */
  private async consumeTicket(ticket: string, now = Date.now()): Promise<Ticket | null> {
    if (typeof ticket !== 'string' || ticket.length === 0) return null;
    const key = `ticket:${ticket}`;
    const entry = await this.state.storage.get<Ticket>(key);
    if (!entry) return null;
    await this.state.storage.delete(key);
    if (entry.expiresAt <= now) return null;
    return entry;
  }

  // ------------------------------------------------------------- broadcast --

  private sockets(): Array<{ ws: WebSocket; attachment: Attachment }> {
    const out: Array<{ ws: WebSocket; attachment: Attachment }> = [];
    for (const ws of this.state.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment) out.push({ ws, attachment });
    }
    return out;
  }

  private broadcast(message: unknown, exceptUsername?: string): void {
    const text = JSON.stringify(message);
    for (const { ws, attachment } of this.sockets()) {
      if (attachment.username === exceptUsername) continue;
      if (ws.readyState === 1) {
        try {
          ws.send(text);
        } catch {
          /* a closing socket is not an error worth surfacing */
        }
      }
    }
  }

  // ----------------------------------------------------------------- fetch --

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/issue-ticket') {
      const { userId } = (await request.json()) as { userId: number };
      return Response.json({ ticket: await this.issueTicket(userId) });
    }

    if (url.pathname === '/connect') {
      const entry = await this.consumeTicket(url.searchParams.get('ticket') ?? '');
      if (!entry) return new Response(null, { status: 401 });
      let user: UserRow | null;
      try {
        user = await this.store.userById(entry.userId);
      } catch {
        return new Response(null, { status: 401 });
      }
      if (!user) return new Response(null, { status: 401 });
      return this.accept(user);
    }

    return new Response(null, { status: 401 });
  }

  private async accept(user: UserRow): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();

    // Position is saved, or a fresh spawn is persisted immediately.
    let x = user.pos_x;
    let y = user.pos_y;
    let spawnPersisted: Promise<unknown> = Promise.resolve();
    if (x == null || y == null) {
      const spawn = spawnPoint();
      x = spawn.x;
      y = spawn.y;
      spawnPersisted = this.store.setPosition(user.id, x, y);
      user.pos_x = x;
      user.pos_y = y;
    }

    const previous = this.sockets().filter((s) => s.attachment.username === user.username);
    this.state.acceptWebSocket(server, [user.username]);
    server.serializeAttachment({
      userId: user.id,
      username: user.username,
      x,
      y,
      lastPersist: 0,
    } satisfies Attachment);
    for (const stale of previous) {
      if (stale.ws !== server && stale.ws.readyState < 2) stale.ws.close(4002, 'replaced');
    }

    // A fresh spawn must be durable before the snapshot is taken, so this player
    // appears in their own init payload.
    const online = new Set(this.sockets().map((s) => s.attachment.username));
    this.state.waitUntil(
      spawnPersisted
        .then(() => this.store.usersWithPosition())
        .then((all) => {
          if (server.readyState !== 1) return;
          server.send(
            JSON.stringify({
              type: 'init',
              world: { w: WORLD_W, h: WORLD_H },
              me: user.username,
              players: all.map((candidate) => worldPlayer(candidate, online.has(candidate.username))),
            }),
          );
        })
        .catch(() => server.close(1011, 'init failed')),
    );

    this.broadcast({ type: 'join', player: worldPlayer(user, true) }, user.username);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ------------------------------------------------------- socket handlers --

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;
    let msg: any;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch {
      return;
    }
    if (!msg || msg.type !== 'move') return;
    const nx = clampPos(msg.x, WORLD_W);
    const ny = clampPos(msg.y, WORLD_H);
    if (nx == null || ny == null) return;

    const next: Attachment = { ...attachment, x: nx, y: ny };
    this.broadcast({ type: 'pos', username: attachment.username, x: nx, y: ny }, attachment.username);

    const timestamp = Date.now();
    if (timestamp - attachment.lastPersist > 1500) {
      next.lastPersist = timestamp;
      this.state.waitUntil(this.store.setPosition(attachment.userId, nx, ny).catch(() => {}));
    }
    ws.serializeAttachment(next);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;
    ws.serializeAttachment(null);
    this.state.waitUntil(
      this.store.setPosition(attachment.userId, attachment.x, attachment.y).catch(() => {}),
    );
    this.broadcast({ type: 'offline', username: attachment.username });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}
