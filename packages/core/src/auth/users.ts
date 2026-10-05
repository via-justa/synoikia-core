import { randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, asc, count, eq } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import { aad } from '../crypto/index.js';
import type { SecretBox } from '../crypto/index.js';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { randomToken, sha256 } from './tokens.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';

/** Portal accounts (design §6.1): argon2id passwords, optional TOTP with recovery codes and OIDC link;
 * no roles. */

// argon2id, m = 64 MiB, t = 3, p = 1 (design §6.1). @node-rs/argon2 defaults to argon2id.
const ARGON = { memoryCost: 65536, timeCost: 3, parallelism: 1 };
const USERNAME = /^[a-zA-Z0-9._@-]{2,64}$/;
const RECOVERY_CODES = 10;

export type UserRow = typeof users.$inferSelect;

export interface PublicUser {
  id: string;
  username: string;
  totpEnabled: boolean;
  oidcLinked: boolean;
  hasPassword: boolean;
  disabled: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export const toPublicUser = (u: UserRow): PublicUser => ({
  id: u.id,
  username: u.username,
  totpEnabled: u.totpEnabled,
  oidcLinked: !!u.oidcSubject,
  hasPassword: !!u.passwordHash,
  disabled: u.disabled,
  createdAt: u.createdAt,
  lastLoginAt: u.lastLoginAt,
});

function checkPasswordPolicy(password: string) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new ValidationError('weak_password', 'Passwords must be at least 12 characters');
  }
  if (password.length > 1024) throw new ValidationError('weak_password', 'Password is too long');
}

// Verified when the username doesn't exist, so response timing doesn't reveal which usernames exist.
let dummyHash: Promise<string> | undefined;

export class UserService {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
  ) {}

  count(): number {
    return this.db.select({ n: count() }).from(users).get()?.n ?? 0;
  }

  list(): PublicUser[] {
    return this.db.select().from(users).orderBy(asc(users.username)).all().map(toPublicUser);
  }

  get(id: string): UserRow {
    const u = this.db.select().from(users).where(eq(users.id, id)).get();
    if (!u) throw new NotFoundError('user_not_found', 'No such user');
    return u;
  }

  byUsername(username: string): UserRow | undefined {
    return this.db.select().from(users).where(eq(users.username, username)).get();
  }

  byOidc(issuer: string, subject: string): UserRow | undefined {
    return this.db
      .select()
      .from(users)
      .where(and(eq(users.oidcIssuer, issuer), eq(users.oidcSubject, subject)))
      .get();
  }

  async create(
    input: { username: string; password?: string },
    actor: { userId?: string } = {},
    opts: { onlyIfFirst?: boolean } = {},
  ): Promise<PublicUser> {
    const username = input.username.trim();
    if (!USERNAME.test(username)) {
      throw new ValidationError(
        'invalid_username',
        'Usernames are 2–64 letters, digits, dots, dashes, underscores or @',
      );
    }
    if (this.byUsername(username)) throw new ConflictError('username_taken', 'That username is taken');
    if (input.password !== undefined) checkPasswordPolicy(input.password);
    const row = {
      id: randomUUID(),
      username,
      passwordHash: input.password ? await hash(input.password, ARGON) : null,
      createdAt: new Date(),
    };
    this.db.transaction((tx) => {
      // Re-checked after the (slow) hash, in the same transaction as the insert: of two concurrent
      // first-run setups only one creates a user.
      if (opts.onlyIfFirst && (tx.select({ n: count() }).from(users).get()?.n ?? 0) > 0)
        throw new ConflictError('setup_done', 'Setup has already been completed');
      if (tx.select({ id: users.id }).from(users).where(eq(users.username, username)).get())
        throw new ConflictError('username_taken', 'That username is taken');
      tx.insert(users).values(row).run();
      writeAudit(tx, {
        kind: 'auth',
        decision: 'user_created',
        actorKind: actor.userId ? 'user' : 'system',
        actorId: actor.userId,
        detail: { username },
      });
    });
    return toPublicUser(this.get(row.id));
  }

  /** First-run setup: only while no users exist (design §6.1). */
  async setupFirstUser(username: string, password: string): Promise<PublicUser> {
    if (this.count() > 0) throw new ConflictError('setup_done', 'Setup has already been completed');
    return this.create({ username, password }, {}, { onlyIfFirst: true });
  }

  /** `ADMIN_BOOTSTRAP_*`: create the first user on boot if none exist; ignored afterwards. */
  async bootstrap(username?: string, password?: string): Promise<'created' | 'ignored' | 'not_configured'> {
    if (!username || !password) return 'not_configured';
    if (this.count() > 0) return 'ignored';
    await this.create({ username, password }, {}, { onlyIfFirst: true });
    return 'created';
  }

  async verifyPassword(username: string, password: string): Promise<UserRow | null> {
    const user = this.byUsername(username);
    if (!user?.passwordHash || user.disabled) {
      dummyHash ??= hash(randomToken(), ARGON);
      await verify(await dummyHash, password).catch(() => false);
      return null;
    }
    return (await verify(user.passwordHash, password).catch(() => false)) ? user : null;
  }

  async setPassword(userId: string, password: string, opts: { currentPassword?: string; actorId?: string } = {}) {
    const user = this.get(userId);
    if (opts.currentPassword !== undefined && user.passwordHash) {
      if (!(await verify(user.passwordHash, opts.currentPassword).catch(() => false))) {
        throw new ValidationError('wrong_password', 'Current password is incorrect');
      }
    }
    checkPasswordPolicy(password);
    const passwordHash = await hash(password, ARGON);
    this.db.transaction((tx) => {
      tx.update(users).set({ passwordHash }).where(eq(users.id, userId)).run();
      writeAudit(tx, {
        kind: 'auth',
        decision: 'password_changed',
        actorKind: 'user',
        actorId: opts.actorId ?? userId,
        detail: { username: user.username },
      });
    });
  }

  setDisabled(userId: string, disabled: boolean, actor: { userId?: string } = {}) {
    const user = this.get(userId);
    if (disabled) {
      const active = this.db.select().from(users).where(eq(users.disabled, false)).all();
      if (active.length === 1 && active[0]!.id === userId) {
        throw new ConflictError('last_user', 'You cannot disable the last active user');
      }
    }
    this.db.transaction((tx) => {
      tx.update(users).set({ disabled }).where(eq(users.id, userId)).run();
      writeAudit(tx, {
        kind: 'auth',
        decision: disabled ? 'user_disabled' : 'user_enabled',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { username: user.username },
      });
    });
  }

  markLogin(userId: string) {
    this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId)).run();
  }

  // ── TOTP ─────────────────────────────────────────────────────────────────────────────────────────

  private totpSecret(user: UserRow): string | null {
    if (!user.totpSecretEnc) return null;
    return this.box.decrypt(user.totpSecretEnc, aad('users', 'totp_secret_enc', user.id)).toString('utf8');
  }

  /** Starts (or restarts) enrollment. TOTP stays off until `confirmTotp` succeeds. */
  beginTotp(userId: string): { secret: string; uri: string } {
    const user = this.get(userId);
    if (user.totpEnabled) throw new ConflictError('totp_enabled', 'TOTP is already enabled; reset it first');
    const secret = generateTotpSecret();
    this.db
      .update(users)
      .set({ totpSecretEnc: this.box.encrypt(secret, aad('users', 'totp_secret_enc', userId)), totpLastStep: null })
      .where(eq(users.id, userId))
      .run();
    return { secret, uri: otpauthUri(secret, user.username) };
  }

  /** Confirms enrollment with a first code; returns the recovery codes, which are shown only once. */
  confirmTotp(userId: string, code: string): string[] {
    const user = this.get(userId);
    const secret = this.totpSecret(user);
    if (!secret || user.totpEnabled) throw new ConflictError('totp_not_pending', 'Start TOTP enrollment first');
    const step = verifyTotp(secret, code);
    if (step === null) throw new ValidationError('invalid_code', 'That code is not valid');
    const codes = Array.from({ length: RECOVERY_CODES }, () =>
      randomToken(8).replace(/[-_]/g, '').slice(0, 10).toLowerCase(),
    );
    this.db.transaction((tx) => {
      tx.update(users)
        .set({ totpEnabled: true, totpLastStep: step, recoveryCodesHash: codes.map(sha256) })
        .where(eq(users.id, userId))
        .run();
      writeAudit(tx, {
        kind: 'auth',
        decision: 'totp_enabled',
        actorKind: 'user',
        actorId: userId,
        detail: { username: user.username },
      });
    });
    return codes;
  }

  resetTotp(userId: string, actor: { userId?: string } = {}) {
    const user = this.get(userId);
    this.db.transaction((tx) => {
      tx.update(users)
        .set({ totpEnabled: false, totpSecretEnc: null, totpLastStep: null, recoveryCodesHash: null })
        .where(eq(users.id, userId))
        .run();
      writeAudit(tx, {
        kind: 'auth',
        decision: 'totp_reset',
        actorKind: 'user',
        actorId: actor.userId ?? userId,
        detail: { username: user.username },
      });
    });
  }

  /** A TOTP code only, replay-protected, for checks that must not take a recovery code (the approval page). */
  verifyTotpCode(userId: string, code: string): boolean {
    const user = this.get(userId);
    const secret = this.totpSecret(user);
    if (!user.totpEnabled || !secret) return false;
    const step = verifyTotp(secret, code, { lastStep: user.totpLastStep });
    if (step === null) return false;
    this.db.update(users).set({ totpLastStep: step }).where(eq(users.id, userId)).run();
    return true;
  }

  /** Second factor: a TOTP code (replay-protected) or a single-use recovery code. */
  verifySecondFactor(userId: string, code: string): 'totp' | 'recovery' | null {
    const user = this.get(userId);
    if (!user.totpEnabled || !this.totpSecret(user)) return null;
    if (this.verifyTotpCode(userId, code)) return 'totp';
    const hashed = sha256(code.trim().toLowerCase());
    const remaining = user.recoveryCodesHash ?? [];
    if (remaining.includes(hashed)) {
      this.db
        .update(users)
        .set({ recoveryCodesHash: remaining.filter((h) => h !== hashed) })
        .where(eq(users.id, userId))
        .run();
      writeAudit(this.db, {
        kind: 'auth',
        decision: 'recovery_code_used',
        actorKind: 'user',
        actorId: userId,
        detail: { remaining: remaining.length - 1 },
      });
      return 'recovery';
    }
    return null;
  }

  // ── OIDC links ───────────────────────────────────────────────────────────────────────────────────

  linkOidc(userId: string, issuer: string, subject: string) {
    const existing = this.byOidc(issuer, subject);
    if (existing && existing.id !== userId)
      throw new ConflictError('oidc_taken', 'That identity is linked to another user');
    this.db.transaction((tx) => {
      tx.update(users).set({ oidcIssuer: issuer, oidcSubject: subject }).where(eq(users.id, userId)).run();
      writeAudit(tx, {
        kind: 'auth',
        decision: 'oidc_linked',
        actorKind: 'user',
        actorId: userId,
        detail: { issuer, subject },
      });
    });
  }

  unlinkOidc(userId: string, actor: { userId?: string } = {}) {
    this.db.transaction((tx) => {
      tx.update(users).set({ oidcIssuer: null, oidcSubject: null }).where(eq(users.id, userId)).run();
      writeAudit(tx, { kind: 'auth', decision: 'oidc_unlinked', actorKind: 'user', actorId: actor.userId ?? userId });
    });
  }

  hasOidcLinkedUser(except?: string): boolean {
    return this.db
      .select()
      .from(users)
      .all()
      .some((u) => !!u.oidcSubject && !u.disabled && u.id !== except);
  }
}
