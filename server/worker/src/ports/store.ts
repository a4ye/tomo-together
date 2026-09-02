// D1 adapter. This is the only module that knows SQL; every route above it
// works on the plain row shapes declared here.
//
// The Mongo build leaned on single-document atomic updates ($push with a
// negative filter, positional array updates, $inc). Each of those maps onto a
// conditional statement whose effect is visible in `meta.changes`:
//
//   updateOne({_id, 'stakes.user_id': {$ne: u}}, {$push:{stakes:…}})
//     -> INSERT OR IGNORE INTO hangout_stakes …            (changes 0 = already there)
//   updateOne({_id, confirms:{$not:{$elemMatch:{u1,u2}}}}, {$push:{confirms:…}})
//     -> INSERT OR IGNORE INTO confirms …                  (changes 1 = we inserted it)
//   updateOne({_id, owned:{$ne:item}, acorns:{$gte:price}}, {$inc, $push})
//     -> UPDATE … WHERE … AND acorns >= ?                  (one statement, one row)
//
// so the concurrency guarantees survive without needing interactive transactions,
// which D1 does not offer.

import { ACTIVITY_IDS } from '../domain/catalog';

export interface UserRow {
  id: number;
  username: string;
  name: string;
  birthday: string;
  pass_hash: string;
  salt: string;
  token: string;
  auth0_sub: string | null;
  acorns: number;
  color: string;
  species: string;
  owned: string[];
  equipped: string[];
  interests: string[];
  pos_x: number | null;
  pos_y: number | null;
  created_at: string;
}

export interface FriendshipRow {
  id: number;
  a_id: number;
  b_id: number;
  status: string;
  requested_by: number;
  vibe: number;
  created_at: string;
}

export interface HangoutRow {
  id: number;
  creator_id: number;
  activity: string;
  activity_label: string;
  date: string;
  place: string;
  bonus_mult: number;
  bonus_reason: string | null;
  photo: string | null;
  photo_by: number | null;
  completed_at: string | null;
  created_at: string;
  stake_units: string | null;
  crypto_event_id: string | null;
  settled_at: string | null;
  member_ids: number[];
  confirms: Array<{ u1: number; u2: number; confirmed_at: string }>;
  stakes: Array<{ user_id: number; staked_at: string }>;
  settlements: Array<{ user_id: number; status: string; payout_units: string }>;
  nfc_tokens: Array<{ user_id: number; token: string; expires_at: number }>;
}

export class DuplicateKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateKeyError';
  }
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed|constraint failed: users/i.test(message);
}

const parseJsonArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value as string[];
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

function hydrateUser(row: Record<string, unknown>): UserRow {
  return {
    id: Number(row.id),
    username: row.username as string,
    name: row.name as string,
    birthday: row.birthday as string,
    pass_hash: row.pass_hash as string,
    salt: row.salt as string,
    token: row.token as string,
    auth0_sub: (row.auth0_sub as string | null) ?? null,
    acorns: Number(row.acorns),
    color: row.color as string,
    species: row.species as string,
    owned: parseJsonArray(row.owned),
    equipped: parseJsonArray(row.equipped),
    interests: parseJsonArray(row.interests),
    pos_x: row.pos_x === null || row.pos_x === undefined ? null : Number(row.pos_x),
    pos_y: row.pos_y === null || row.pos_y === undefined ? null : Number(row.pos_y),
    created_at: row.created_at as string,
  };
}

/** LIKE wildcards are not regex metacharacters, so they must be escaped here. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export class Store {
  constructor(private readonly db: D1Database) {}

  // -------------------------------------------------------------- counters --

  /** Mongo's counters.findOneAndUpdate({_id:name},{$inc:{seq:1}},{upsert:true}). */
  async nextId(name: string): Promise<number> {
    const row = await this.db
      .prepare(
        `INSERT INTO counters (name, seq) VALUES (?1, 1)
         ON CONFLICT(name) DO UPDATE SET seq = seq + 1
         RETURNING seq`,
      )
      .bind(name)
      .first<{ seq: number }>();
    if (!row) throw new Error(`counter ${name} did not return a sequence`);
    return Number(row.seq);
  }

  // ----------------------------------------------------------------- users --

  async userByToken(token: string): Promise<UserRow | null> {
    const row = await this.db.prepare('SELECT * FROM users WHERE token = ?1').bind(token).first();
    return row ? hydrateUser(row) : null;
  }

  async userById(id: number): Promise<UserRow | null> {
    const row = await this.db.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first();
    return row ? hydrateUser(row) : null;
  }

  async userByUsername(username: string): Promise<UserRow | null> {
    const row = await this.db
      .prepare('SELECT * FROM users WHERE username = ?1')
      .bind(username)
      .first();
    return row ? hydrateUser(row) : null;
  }

  async usersByIds(ids: number[]): Promise<UserRow[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(',');
    const { results } = await this.db
      .prepare(`SELECT * FROM users WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all();
    return (results ?? []).map(hydrateUser);
  }

  /**
   * GET /users/search. Mongo used an anchored, case-SENSITIVE regex on username
   * and a case-INSENSITIVE one on name; `name_folded` carries the Unicode-aware
   * lowercase so the second half is an exact literal match, not SQLite's
   * ASCII-only LIKE folding.
   */
  async searchUsers(excludeId: number, q: string): Promise<UserRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM users
          WHERE id != ?1
            AND (substr(username, 1, ?2) = ?3 OR name_folded LIKE ?4 ESCAPE '\\')
          LIMIT 6`,
      )
      .bind(excludeId, q.length, q, `%${escapeLike(q)}%`)
      .all();
    return (results ?? []).map(hydrateUser);
  }

  async insertUser(doc: Omit<UserRow, 'owned' | 'equipped' | 'interests'> & {
    owned: string[];
    equipped: string[];
    interests: string[];
  }): Promise<void> {
    try {
      await this.db
        .prepare(
          `INSERT INTO users
             (id, username, name, name_folded, birthday, pass_hash, salt, token, auth0_sub,
              acorns, color, species, owned, equipped, interests, pos_x, pos_y, created_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)`,
        )
        .bind(
          doc.id, doc.username, doc.name, doc.name.toLowerCase(), doc.birthday, doc.pass_hash,
          doc.salt, doc.token, doc.auth0_sub, doc.acorns, doc.color, doc.species,
          JSON.stringify(doc.owned), JSON.stringify(doc.equipped), JSON.stringify(doc.interests),
          doc.pos_x, doc.pos_y, doc.created_at,
        )
        .run();
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateKeyError('E11000 duplicate key');
      throw error;
    }
  }

  async setInterests(id: number, interests: string[]): Promise<void> {
    await this.db
      .prepare('UPDATE users SET interests = ?2 WHERE id = ?1')
      .bind(id, JSON.stringify(interests))
      .run();
  }

  async setAvatar(id: number, color: string, equipped: string[], species: string): Promise<void> {
    await this.db
      .prepare('UPDATE users SET color = ?2, equipped = ?3, species = ?4 WHERE id = ?1')
      .bind(id, color, JSON.stringify(equipped), species)
      .run();
  }

  /** First self-hosted login for an `auth0-disabled:` placeholder row. */
  async claimAuth0Account(id: number, passHash: string, salt: string, token: string): Promise<void> {
    await this.db
      .prepare('UPDATE users SET pass_hash = ?2, salt = ?3, token = ?4, auth0_sub = NULL WHERE id = ?1')
      .bind(id, passHash, salt, token)
      .run();
  }

  async incAcorns(ids: number[], delta: number): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map((_, i) => `?${i + 2}`).join(',');
    await this.db
      .prepare(`UPDATE users SET acorns = acorns + ?1 WHERE id IN (${placeholders})`)
      .bind(delta, ...ids)
      .run();
  }

  /** users.updateOne({_id, owned:{$ne:item}, acorns:{$gte:price}}, {$inc,$push}) */
  async buyItem(id: number, itemId: string, price: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE users
            SET acorns = acorns - ?3,
                owned  = json_insert(owned, '$[#]', ?2)
          WHERE id = ?1
            AND acorns >= ?3
            AND NOT EXISTS (SELECT 1 FROM json_each(users.owned) WHERE value = ?2)`,
      )
      .bind(id, itemId, price)
      .run();
  }

  async setPosition(id: number, x: number, y: number): Promise<void> {
    await this.db.prepare('UPDATE users SET pos_x = ?2, pos_y = ?3 WHERE id = ?1').bind(id, x, y).run();
  }

  async usersWithPosition(): Promise<UserRow[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM users WHERE pos_x IS NOT NULL')
      .all();
    return (results ?? []).map(hydrateUser);
  }

  // --------------------------------------------------------------- weights --

  async weightsFor(userIds: number[]): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const placeholders = userIds.map((_, i) => `?${i + 1}`).join(',');
    const { results } = await this.db
      .prepare(`SELECT user_id, activity, weight FROM weights WHERE user_id IN (${placeholders})`)
      .bind(...userIds)
      .all<{ user_id: number; activity: string; weight: number }>();
    return new Map((results ?? []).map((r) => [`${r.user_id}:${r.activity}`, Number(r.weight)]));
  }

  async upsertWeight(userId: number, activity: string, weight: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO weights (user_id, activity, weight) VALUES (?1, ?2, ?3)
         ON CONFLICT(user_id, activity) DO UPDATE SET weight = ?3`,
      )
      .bind(userId, activity, weight)
      .run();
  }

  /** weights.find({user_id, weight:{$gt|$lt:…}}).sort({weight: ±1}) */
  async rankedActivities(userId: number, bound: number, direction: 'gt' | 'lt'): Promise<string[]> {
    const sql =
      direction === 'gt'
        ? 'SELECT activity FROM weights WHERE user_id = ?1 AND weight > ?2 ORDER BY weight DESC'
        : 'SELECT activity FROM weights WHERE user_id = ?1 AND weight < ?2 ORDER BY weight ASC';
    const { results } = await this.db.prepare(sql).bind(userId, bound).all<{ activity: string }>();
    return (results ?? []).map((r) => r.activity).filter((a) => ACTIVITY_IDS.has(a));
  }

  // ----------------------------------------------------------- friendships --

  async friendship(aId: number, bId: number): Promise<FriendshipRow | null> {
    const [a, b] = aId < bId ? [aId, bId] : [bId, aId];
    const row = await this.db
      .prepare('SELECT * FROM friendships WHERE a_id = ?1 AND b_id = ?2')
      .bind(a, b)
      .first<FriendshipRow>();
    return row ?? null;
  }

  async friendshipsForUser(userId: number, acceptedOnly = false): Promise<FriendshipRow[]> {
    const sql = acceptedOnly
      ? "SELECT * FROM friendships WHERE (a_id = ?1 OR b_id = ?1) AND status = 'accepted'"
      : 'SELECT * FROM friendships WHERE a_id = ?1 OR b_id = ?1';
    const { results } = await this.db.prepare(sql).bind(userId).all<FriendshipRow>();
    return results ?? [];
  }

  async insertFriendship(row: FriendshipRow): Promise<void> {
    try {
      await this.db
        .prepare(
          `INSERT INTO friendships (id, a_id, b_id, status, requested_by, vibe, created_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7)`,
        )
        .bind(row.id, row.a_id, row.b_id, row.status, row.requested_by, row.vibe, row.created_at)
        .run();
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateKeyError('E11000 duplicate key');
      throw error;
    }
  }

  async acceptFriendship(id: number): Promise<void> {
    await this.db.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?1").bind(id).run();
  }

  async incVibe(id: number, delta: number): Promise<void> {
    await this.db.prepare('UPDATE friendships SET vibe = vibe + ?2 WHERE id = ?1').bind(id, delta).run();
  }

  // -------------------------------------------------------------- hangouts --

  private async hydrateHangouts(rows: Record<string, unknown>[]): Promise<HangoutRow[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => Number(r.id));
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(',');
    const [members, confirms, stakes, settlements, nfc] = await this.db.batch([
      this.db.prepare(`SELECT * FROM hangout_members WHERE hangout_id IN (${placeholders}) ORDER BY hangout_id, position`).bind(...ids),
      this.db.prepare(`SELECT * FROM confirms WHERE hangout_id IN (${placeholders}) ORDER BY hangout_id, position`).bind(...ids),
      this.db.prepare(`SELECT * FROM hangout_stakes WHERE hangout_id IN (${placeholders}) ORDER BY hangout_id, position`).bind(...ids),
      this.db.prepare(`SELECT * FROM hangout_settlements WHERE hangout_id IN (${placeholders}) ORDER BY hangout_id, position`).bind(...ids),
      this.db.prepare(`SELECT * FROM nfc_tokens WHERE hangout_id IN (${placeholders}) ORDER BY hangout_id, position`).bind(...ids),
    ]);

    const bucket = <T>(result: D1Result, map: (row: any) => T): Map<number, T[]> => {
      const out = new Map<number, T[]>();
      for (const row of (result.results ?? []) as any[]) {
        const key = Number(row.hangout_id);
        const list = out.get(key) ?? [];
        list.push(map(row));
        out.set(key, list);
      }
      return out;
    };
    const byMember = bucket(members, (r) => Number(r.user_id));
    const byConfirm = bucket(confirms, (r) => ({ u1: Number(r.u1), u2: Number(r.u2), confirmed_at: r.confirmed_at as string }));
    const byStake = bucket(stakes, (r) => ({ user_id: Number(r.user_id), staked_at: r.staked_at as string }));
    const bySettlement = bucket(settlements, (r) => ({ user_id: Number(r.user_id), status: r.status as string, payout_units: r.payout_units as string }));
    const byNfc = bucket(nfc, (r) => ({ user_id: Number(r.user_id), token: r.token as string, expires_at: Number(r.expires_at) }));

    return rows.map((r) => {
      const id = Number(r.id);
      return {
        id,
        creator_id: Number(r.creator_id),
        activity: r.activity as string,
        activity_label: r.activity_label as string,
        date: r.date as string,
        place: r.place as string,
        bonus_mult: Number(r.bonus_mult),
        bonus_reason: (r.bonus_reason as string | null) ?? null,
        photo: (r.photo as string | null) ?? null,
        photo_by: r.photo_by === null || r.photo_by === undefined ? null : Number(r.photo_by),
        completed_at: (r.completed_at as string | null) ?? null,
        created_at: r.created_at as string,
        stake_units: (r.stake_units as string | null) ?? null,
        crypto_event_id: (r.crypto_event_id as string | null) ?? null,
        settled_at: (r.settled_at as string | null) ?? null,
        member_ids: byMember.get(id) ?? [],
        confirms: byConfirm.get(id) ?? [],
        stakes: byStake.get(id) ?? [],
        settlements: bySettlement.get(id) ?? [],
        nfc_tokens: byNfc.get(id) ?? [],
      };
    });
  }

  async hangoutById(id: number | null): Promise<HangoutRow | null> {
    if (id === null) return null;
    const { results } = await this.db.prepare('SELECT * FROM hangouts WHERE id = ?1').bind(id).all();
    const hydrated = await this.hydrateHangouts(results ?? []);
    return hydrated[0] ?? null;
  }

  /** hangouts.find({member_ids: me}).sort({date: -1}) */
  async hangoutsForUser(userId: number): Promise<HangoutRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT h.* FROM hangouts h
          JOIN hangout_members m ON m.hangout_id = h.id AND m.user_id = ?1
          ORDER BY h.date DESC`,
      )
      .bind(userId)
      .all();
    return this.hydrateHangouts(results ?? []);
  }

  async completedHangoutsForUser(userId: number): Promise<HangoutRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT h.* FROM hangouts h
          JOIN hangout_members m ON m.hangout_id = h.id AND m.user_id = ?1
          WHERE h.completed_at IS NOT NULL
          ORDER BY h.date DESC`,
      )
      .bind(userId)
      .all();
    return this.hydrateHangouts(results ?? []);
  }

  /** hangouts.find({member_ids:{$all:[a,b]}}).sort({date:-1}) */
  async hangoutsForPair(a: number, b: number): Promise<HangoutRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT h.* FROM hangouts h
          WHERE EXISTS (SELECT 1 FROM hangout_members m WHERE m.hangout_id = h.id AND m.user_id = ?1)
            AND EXISTS (SELECT 1 FROM hangout_members m WHERE m.hangout_id = h.id AND m.user_id = ?2)
          ORDER BY h.date DESC`,
      )
      .bind(a, b)
      .all();
    return this.hydrateHangouts(results ?? []);
  }

  /** Just the completed_at column, for hangoutStats(). */
  async completedAtForPair(a: number, b: number): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT h.completed_at AS completed_at FROM hangouts h
          WHERE h.completed_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM hangout_members m WHERE m.hangout_id = h.id AND m.user_id = ?1)
            AND EXISTS (SELECT 1 FROM hangout_members m WHERE m.hangout_id = h.id AND m.user_id = ?2)`,
      )
      .bind(a, b)
      .all<{ completed_at: string }>();
    return (results ?? []).map((r) => r.completed_at);
  }

  async countOpenForPair(a: number, b: number): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM hangouts h
          WHERE h.completed_at IS NULL
            AND EXISTS (SELECT 1 FROM hangout_members m WHERE m.hangout_id = h.id AND m.user_id = ?1)
            AND EXISTS (SELECT 1 FROM hangout_members m WHERE m.hangout_id = h.id AND m.user_id = ?2)`,
      )
      .bind(a, b)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  async countCompletedSince(userId: number, sinceIso: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM hangouts h
          JOIN hangout_members m ON m.hangout_id = h.id AND m.user_id = ?1
          WHERE h.completed_at IS NOT NULL AND h.date >= ?2`,
      )
      .bind(userId, sinceIso)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  async insertHangout(row: Omit<HangoutRow, 'confirms' | 'stakes' | 'settlements' | 'nfc_tokens'>): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO hangouts
             (id, creator_id, activity, activity_label, date, place, bonus_mult, bonus_reason,
              photo, photo_by, completed_at, created_at, stake_units, crypto_event_id, settled_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`,
        )
        .bind(
          row.id, row.creator_id, row.activity, row.activity_label, row.date, row.place,
          row.bonus_mult, row.bonus_reason, row.photo, row.photo_by, row.completed_at,
          row.created_at, row.stake_units, row.crypto_event_id, row.settled_at,
        ),
    ];
    row.member_ids.forEach((userId, position) => {
      statements.push(
        this.db
          .prepare('INSERT INTO hangout_members (hangout_id, user_id, position) VALUES (?1,?2,?3)')
          .bind(row.id, userId, position),
      );
    });
    await this.db.batch(statements);
  }

  async setPhoto(hangoutId: number, photo: string, photoBy: number): Promise<void> {
    await this.db
      .prepare('UPDATE hangouts SET photo = ?2, photo_by = ?3 WHERE id = ?1')
      .bind(hangoutId, photo, photoBy)
      .run();
  }

  /** hangouts.updateOne({_id, completed_at:null},{$set:{completed_at:now}}) */
  async completeIfOpen(hangoutId: number, at: string): Promise<void> {
    await this.db
      .prepare('UPDATE hangouts SET completed_at = ?2 WHERE id = ?1 AND completed_at IS NULL')
      .bind(hangoutId, at)
      .run();
  }

  /** Returns true when this call is the one that recorded the confirmation. */
  async pushConfirm(hangoutId: number, u1: number, u2: number, at: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO confirms (hangout_id, u1, u2, confirmed_at, position)
         VALUES (?1, ?2, ?3, ?4,
                 (SELECT COALESCE(MAX(position) + 1, 0) FROM confirms WHERE hangout_id = ?1))`,
      )
      .bind(hangoutId, u1, u2, at)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async upsertNfcToken(hangoutId: number, userId: number, token: string, expiresAt: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO nfc_tokens (hangout_id, user_id, token, expires_at, position)
         VALUES (?1, ?2, ?3, ?4,
                 (SELECT COALESCE(MAX(position) + 1, 0) FROM nfc_tokens WHERE hangout_id = ?1))
         ON CONFLICT(hangout_id, user_id) DO UPDATE SET token = ?3, expires_at = ?4`,
      )
      .bind(hangoutId, userId, token, expiresAt)
      .run();
  }

  async pushStake(hangoutId: number, userId: number, at: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO hangout_stakes (hangout_id, user_id, staked_at, position)
         VALUES (?1, ?2, ?3,
                 (SELECT COALESCE(MAX(position) + 1, 0) FROM hangout_stakes WHERE hangout_id = ?1))`,
      )
      .bind(hangoutId, userId, at)
      .run();
  }

  /** $pull: {stakes: {user_id: {$nin: keep}}} */
  async pruneStakes(hangoutId: number, keep: number[]): Promise<void> {
    if (keep.length === 0) {
      await this.db.prepare('DELETE FROM hangout_stakes WHERE hangout_id = ?1').bind(hangoutId).run();
      return;
    }
    const placeholders = keep.map((_, i) => `?${i + 2}`).join(',');
    await this.db
      .prepare(`DELETE FROM hangout_stakes WHERE hangout_id = ?1 AND user_id NOT IN (${placeholders})`)
      .bind(hangoutId, ...keep)
      .run();
  }

  /**
   * The Mongo build published settlements, settled_at and (optionally)
   * completed_at in ONE document update so a reader never saw a half-settled
   * hangout. D1's batch() runs the equivalent statements inside one implicit
   * transaction, which gives the same all-or-nothing visibility.
   */
  async publishSettlement(
    hangoutId: number,
    settlements: Array<{ user_id: number; status: string; payout_units: string }>,
    timestamp: string,
    complete: boolean,
  ): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db.prepare('DELETE FROM hangout_settlements WHERE hangout_id = ?1').bind(hangoutId),
    ];
    settlements.forEach((s, position) => {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO hangout_settlements (hangout_id, user_id, status, payout_units, position)
             VALUES (?1,?2,?3,?4,?5)`,
          )
          .bind(hangoutId, s.user_id, s.status, s.payout_units, position),
      );
    });
    statements.push(
      this.db
        .prepare('UPDATE hangouts SET settled_at = COALESCE(settled_at, ?2) WHERE id = ?1')
        .bind(hangoutId, timestamp),
    );
    if (complete) {
      statements.push(
        this.db
          .prepare('UPDATE hangouts SET completed_at = COALESCE(completed_at, ?2) WHERE id = ?1')
          .bind(hangoutId, timestamp),
      );
    }
    await this.db.batch(statements);
  }
}
