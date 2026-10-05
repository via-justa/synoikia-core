import { createHmac } from 'node:crypto';
import { and, eq, lt, ne } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions, users } from '../db/schema.js';
import { randomToken } from './tokens.js';
import type { UserRow } from './users.js';

/** Server-side sessions (design §6.1): the cookie holds a random id, the DB only its HMAC under a
 * master-key-derived pepper. */

export type SessionKind = 'admin' | 'oauth_ui' | 'approval_ui';

export interface SessionLimits {
  idleMs: number;
  absoluteMs: number;
}

export interface ValidSession {
  idHash: string;
  kind: SessionKind;
  user: UserRow;
  createdAt: Date;
}

const TOUCH_EVERY_MS = 60_000;

export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly pepper: Buffer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  hashId(raw: string): string {
    return createHmac('sha256', this.pepper).update(raw).digest('hex');
  }

  create(
    userId: string,
    kind: SessionKind,
    limits: SessionLimits,
    meta: { ip?: string; userAgent?: string } = {},
  ): string {
    const raw = randomToken(32);
    const now = this.now();
    this.db
      .insert(sessions)
      .values({
        idHash: this.hashId(raw),
        userId,
        kind,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + limits.absoluteMs),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 256) ?? null,
      })
      .run();
    return raw;
  }

  /** Returns the session if it is of `kind`, unexpired (idle and absolute), and its user is enabled. */
  validate(raw: string | undefined, kind: SessionKind, limits: SessionLimits): ValidSession | null {
    if (!raw || raw.length > 128) return null;
    const idHash = this.hashId(raw);
    const row = this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.idHash, idHash), eq(sessions.kind, kind)))
      .get();
    if (!row) return null;
    const now = this.now().getTime();
    const idleExpired = now - row.session.lastSeenAt.getTime() > limits.idleMs;
    if (row.user.disabled || idleExpired || row.session.expiresAt.getTime() <= now) {
      this.db.delete(sessions).where(eq(sessions.idHash, idHash)).run();
      return null;
    }
    if (now - row.session.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
      this.db
        .update(sessions)
        .set({ lastSeenAt: new Date(now) })
        .where(eq(sessions.idHash, idHash))
        .run();
    }
    return { idHash, kind: row.session.kind, user: row.user, createdAt: row.session.createdAt };
  }

  revoke(raw: string | undefined) {
    if (raw)
      this.db
        .delete(sessions)
        .where(eq(sessions.idHash, this.hashId(raw)))
        .run();
  }

  /** Signs a user out everywhere (e.g. after a password change), optionally keeping the current session. */
  revokeUser(userId: string, keepRaw?: string) {
    const keep = keepRaw ? this.hashId(keepRaw) : '';
    this.db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.idHash, keep)))
      .run();
  }

  purgeExpired(): number {
    return this.db.delete(sessions).where(lt(sessions.expiresAt, this.now())).run().changes;
  }
}
