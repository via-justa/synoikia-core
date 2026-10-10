import { createHmac } from 'node:crypto';
import { and, eq, gt, lt, ne } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
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
  /** When each MCP-port session last proved TOTP (design §5.3); in memory, so a restart asks again. */
  private readonly totpProofs = new Map<string, number>();

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
    // The current limit applies too, so lowering it shortens sessions that already exist.
    const tooOld = now - row.session.createdAt.getTime() > limits.absoluteMs;
    if (row.user.disabled || idleExpired || tooOld || row.session.expiresAt.getTime() <= now) {
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

  /** A user's unexpired sessions of one kind (the Profile page lists approval browsers, design §5.3). */
  listKind(userId: string, kind: SessionKind) {
    return this.db
      .select({ createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, userAgent: sessions.userAgent })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.kind, kind), gt(sessions.expiresAt, this.now())))
      .all();
  }

  revokeKind(userId: string, kind: SessionKind): number {
    return this.db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.kind, kind)))
      .run().changes;
  }

  /** The user signs out every approval browser at once (Profile page, design §5.3). */
  revokeApprovalBrowsers(userId: string): number {
    return this.db.transaction((tx) => {
      const count = tx
        .delete(sessions)
        .where(and(eq(sessions.userId, userId), eq(sessions.kind, 'approval_ui')))
        .run().changes;
      writeAudit(tx, {
        kind: 'auth',
        decision: 'approval_sessions_revoked',
        actorKind: 'user',
        actorId: userId,
        detail: { count },
      });
      return count;
    });
  }

  /** Proofs older than `maxAgeMs` are dropped on the way. */
  recordTotpProof(idHash: string, maxAgeMs: number) {
    const now = this.now().getTime();
    for (const [k, at] of this.totpProofs) if (now - at > maxAgeMs) this.totpProofs.delete(k);
    this.totpProofs.set(idHash, now);
  }

  /** Milliseconds since this session last proved TOTP, or Infinity if it never did. */
  sinceTotpProof(idHash: string): number {
    const at = this.totpProofs.get(idHash);
    return at === undefined ? Infinity : this.now().getTime() - at;
  }

  purgeExpired(): number {
    return this.db.delete(sessions).where(lt(sessions.expiresAt, this.now())).run().changes;
  }
}
