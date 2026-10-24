import { randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import { levelView, roleEndpointSwitches, roleHasInstance, setOwnLevel } from '../catalog/role-levels.js';
import type { LevelTarget, LevelView } from '../catalog/role-levels.js';
import { aad } from '../crypto/index.js';
import type { SecretBox } from '../crypto/index.js';
import type { Db } from '../db/index.js';
import {
  mcpTokens,
  operationGroups,
  operations,
  pendingApprovals,
  preApprovalRules,
  roles,
  users,
} from '../db/schema.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { ADMIN_ROLE_ID } from '../gate/access.js';
import type { AccessLevel } from '../gate/access.js';
import { getSettings } from '../settings.js';
import { toPublicRole } from './roles.js';
import type { PublicRole } from './roles.js';
import { randomToken, sha256 } from './tokens.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';

/** Portal accounts (ADR-0008): argon2id passwords, optional TOTP with recovery codes and OIDC link,
 * and one role each (ADR-0010). */

// argon2id, m = 64 MiB, t = 3, p = 1 (ADR-0008). @node-rs/argon2 defaults to argon2id.
export const PASSWORD_HASH = { memoryCost: 65536, timeCost: 3, parallelism: 1 };
export type PasswordHashCost = typeof PASSWORD_HASH;
const USERNAME = /^[a-zA-Z0-9._@:-]{2,64}$/;
const RECOVERY_CODES = 10;

export type UserRow = typeof users.$inferSelect;

export type AccountKind = 'local' | 'sso';

export interface PublicUser {
  id: string;
  username: string;
  kind: AccountKind;
  /** The address an SSO account waits for until its first sign-in (ADR-0025). */
  oidcEmail: string | null;
  totpEnabled: boolean;
  oidcLinked: boolean;
  hasPassword: boolean;
  disabled: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
  role: PublicRole;
}

/** How a user came to exist without an admin creating them (ADR-0010). */
export type RegistrationSource = 'oidc' | 'external' | 'signup';

const toPublicUser = (u: UserRow, role: PublicRole): PublicUser => ({
  id: u.id,
  username: u.username,
  kind: u.kind,
  oidcEmail: u.oidcEmail,
  totpEnabled: u.totpEnabled,
  oidcLinked: !!u.oidcSubject,
  hasPassword: !!u.passwordHash,
  disabled: u.disabled,
  createdAt: u.createdAt,
  lastLoginAt: u.lastLoginAt,
  role,
});

const newRecoveryCodes = () =>
  Array.from({ length: RECOVERY_CODES }, () => randomToken(8).replace(/[-_]/g, '').slice(0, 10).toLowerCase());

function checkPasswordPolicy(password: string) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new ValidationError('weak_password', 'Passwords must be at least 12 characters');
  }
  if (password.length > 1024) throw new ValidationError('weak_password', 'Password is too long');
}

export class UserService {
  // Verified when the username doesn't exist, so response timing doesn't reveal which usernames exist.
  private dummyHash?: Promise<string>;

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly hashCost: PasswordHashCost = PASSWORD_HASH,
    private readonly now: () => Date = () => new Date(),
  ) {}

  count(): number {
    return this.db.select({ n: count() }).from(users).get()?.n ?? 0;
  }

  list(): PublicUser[] {
    return this.db
      .select()
      .from(users)
      .orderBy(asc(users.username))
      .all()
      .map((u) => this.toPublic(u));
  }

  /** A user's role; a dangling role id (none can be made through the API) reads as no access. */
  roleOf(u: UserRow): PublicRole {
    const role = this.db.select().from(roles).where(eq(roles.id, u.roleId)).get();
    return role
      ? toPublicRole(role)
      : {
          id: u.roleId,
          name: 'Unknown',
          isAdmin: false,
          canSeeOtherEndpoints: false,
        };
  }

  toPublic(u: UserRow): PublicUser {
    return toPublicUser(u, this.roleOf(u));
  }

  /** The signed-in user's own view: with two-factor on, it also counts the recovery codes left. */
  profile(userId: string): PublicUser & { recoveryCodesLeft?: number } {
    const u = this.get(userId);
    return { ...this.toPublic(u), ...(u.totpEnabled ? { recoveryCodesLeft: u.recoveryCodesHash?.length ?? 0 } : {}) };
  }

  isAdmin(u: UserRow): boolean {
    return u.roleId === ADMIN_ROLE_ID;
  }

  get(id: string): UserRow {
    const u = this.db.select().from(users).where(eq(users.id, id)).get();
    if (!u) throw new NotFoundError('user_not_found', 'No such user');
    return u;
  }

  byUsername(username: string): UserRow | undefined {
    return this.db.select().from(users).where(eq(users.username, username)).get();
  }

  /** The user a proxy-named identity is (ADR-0009): only one an admin made or that `external` mode
   * registered, so nobody can claim a proxy identity by signing up or through OIDC first. */
  byExternalIdentity(identity: string): UserRow | undefined {
    const found = this.byUsernameInsensitive(identity);
    return found && (found.registeredVia === null || found.registeredVia === 'external') ? found : undefined;
  }

  /** Case-insensitive match. */
  byUsernameInsensitive(username: string): UserRow | undefined {
    return this.db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = lower(${username})`)
      .orderBy(asc(users.createdAt))
      .get();
  }

  /** The SSO account an admin made for this address and nobody signed in to yet (ADR-0025). */
  byPendingOidcEmail(email: string): UserRow | undefined {
    return this.db
      .select()
      .from(users)
      .where(and(eq(users.kind, 'sso'), sql`lower(${users.oidcEmail}) = lower(${email})`))
      .get();
  }

  byOidc(issuer: string, subject: string): UserRow | undefined {
    return this.db
      .select()
      .from(users)
      .where(and(eq(users.oidcIssuer, issuer), eq(users.oidcSubject, subject)))
      .get();
  }

  async create(
    input: { username: string; password?: string; roleId?: string; kind?: AccountKind; oidcEmail?: string },
    actor: { userId?: string } = {},
    opts: { onlyIfFirst?: boolean; source?: RegistrationSource } = {},
  ): Promise<PublicUser> {
    const roleId = input.roleId ?? ADMIN_ROLE_ID;
    if (!this.db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId)).get())
      throw new ValidationError('unknown_role', 'No such role');
    const username = input.username.trim();
    if (!USERNAME.test(username)) {
      throw new ValidationError(
        'invalid_username',
        'Usernames are 2–64 letters, digits, dots, dashes, underscores or @',
      );
    }
    // Unique regardless of case: proxy identities match names that way (ADR-0009).
    if (this.byUsernameInsensitive(username)) throw new ConflictError('username_taken', 'That username is taken');
    const kind = input.kind ?? 'local';
    // An SSO account never has a password, so a session alone can never add a way in (ADR-0025).
    if (kind === 'sso' && input.password !== undefined)
      throw new ValidationError('sso_account', 'An SSO account signs in only with single sign-on, and has no password');
    if (kind === 'local' && input.oidcEmail !== undefined)
      throw new ValidationError('local_account', 'A local account has no single sign-on address');
    const oidcEmail = input.oidcEmail?.trim();
    if (oidcEmail !== undefined) {
      if (!/^[^\s@]+@[^\s@]+$/.test(oidcEmail)) throw new ValidationError('invalid_email', 'That is not an address');
      if (this.byPendingOidcEmail(oidcEmail))
        throw new ConflictError('oidc_email_taken', 'Another SSO account waits for that address');
    }
    if (input.password !== undefined) checkPasswordPolicy(input.password);
    const row = {
      id: randomUUID(),
      username,
      kind,
      oidcEmail: oidcEmail ?? null,
      passwordHash: input.password ? await hash(input.password, this.hashCost) : null,
      createdAt: new Date(),
      roleId,
      registeredVia: opts.source ?? null,
    };
    this.db.transaction((tx) => {
      // Re-checked after the (slow) hash, in the same transaction as the insert: of two concurrent
      // first-run setups only one creates a user.
      if (opts.onlyIfFirst && (tx.select({ n: count() }).from(users).get()?.n ?? 0) > 0)
        throw new ConflictError('setup_done', 'Setup has already been completed');
      if (
        tx
          .select({ id: users.id })
          .from(users)
          .where(sql`lower(${users.username}) = lower(${username})`)
          .get()
      )
        throw new ConflictError('username_taken', 'That username is taken');
      tx.insert(users).values(row).run();
      writeAudit(tx, {
        kind: 'auth',
        decision: opts.source ? 'user_registered' : 'user_created',
        actorKind: actor.userId ? 'user' : 'system',
        actorId: actor.userId,
        detail: { username, roleId, kind, ...(opts.source ? { source: opts.source } : {}) },
      });
    });
    return this.toPublic(this.get(row.id));
  }

  /** Self-registration (ADR-0010): only while an admin has set a default role, which the user gets. */
  async register(
    input: { username: string; password?: string; kind?: AccountKind },
    source: RegistrationSource,
  ): Promise<PublicUser> {
    const roleId = getSettings(this.db, 'security').defaultRoleId;
    if (!roleId) throw new ConflictError('registration_closed', 'This server does not accept new accounts');
    // `:` names Cloudflare service tokens (`service:<id>`); only the proxy may bring such a name.
    if (source !== 'external' && input.username.includes(':'))
      throw new ValidationError(
        'invalid_username',
        'Usernames are 2–64 letters, digits, dots, dashes, underscores or @',
      );
    return this.create({ ...input, roleId }, {}, { source });
  }

  registrationOpen(): boolean {
    const roleId = getSettings(this.db, 'security').defaultRoleId;
    return !!roleId && !!this.db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId)).get();
  }

  /** Enabled admins other than `except`: someone must always be left to administer the server. */
  private otherAdmins(except: string): number {
    return (
      this.db
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.roleId, ADMIN_ROLE_ID), eq(users.disabled, false), ne(users.id, except)))
        .get()?.n ?? 0
    );
  }

  setRole(userId: string, roleId: string, actor: { userId?: string } = {}) {
    const user = this.get(userId);
    if (!this.db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId)).get())
      throw new ValidationError('unknown_role', 'No such role');
    if (user.roleId === roleId) return;
    if (user.roleId === ADMIN_ROLE_ID && !user.disabled && this.otherAdmins(userId) === 0)
      throw new ConflictError('last_admin', 'You cannot remove the last enabled admin');
    this.db.transaction((tx) => {
      tx.update(users).set({ roleId }).where(eq(users.id, userId)).run();
      writeAudit(tx, {
        kind: 'auth',
        decision: 'user_role_changed',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { username: user.username, from: user.roleId, to: roleId },
      });
    });
  }

  /** First-run setup: only while no users exist (ADR-0008). */
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
    if (!user?.passwordHash || user.kind !== 'local' || user.disabled) {
      this.dummyHash ??= hash(randomToken(), this.hashCost);
      await verify(await this.dummyHash, password).catch(() => false);
      return null;
    }
    return (await verify(user.passwordHash, password).catch(() => false)) ? user : null;
  }

  async setPassword(userId: string, password: string, opts: { currentPassword?: string; actorId?: string } = {}) {
    const user = this.get(userId);
    if (user.kind === 'sso')
      throw new ConflictError('sso_account', 'This account signs in only with single sign-on, and has no password');
    if (opts.currentPassword !== undefined && user.passwordHash) {
      if (!(await verify(user.passwordHash, opts.currentPassword).catch(() => false))) {
        throw new ValidationError('wrong_password', 'Current password is incorrect');
      }
    }
    checkPasswordPolicy(password);
    const passwordHash = await hash(password, this.hashCost);
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
      if (user.roleId === ADMIN_ROLE_ID && !user.disabled && this.otherAdmins(userId) === 0)
        throw new ConflictError('last_admin', 'You cannot disable the last enabled admin');
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

  /** Refuses a delete that would leave no user, no enabled admin or (local login off) no SSO user. */
  assertDeletable(userId: string) {
    const user = this.get(userId);
    if (this.count() === 1) throw new ConflictError('last_user', 'You cannot delete the last user');
    if (user.roleId === ADMIN_ROLE_ID && !user.disabled && this.otherAdmins(userId) === 0)
      throw new ConflictError('last_admin', 'You cannot delete the last enabled admin');
    this.assertSsoRemains({ losingUser: userId });
    return user;
  }

  /** Hard delete (ADR-0008): the caller revokes credentials and cancels approvals first. History stays. */
  delete(userId: string, actor: { userId?: string } = {}) {
    this.db.transaction((tx) => {
      const user = this.assertDeletable(userId);
      // Attribution columns without ON DELETE; personal rules go, as a null owner means every caller.
      tx.update(operationGroups).set({ levelChangedBy: null }).where(eq(operationGroups.levelChangedBy, userId)).run();
      tx.update(operations).set({ acknowledgedBy: null }).where(eq(operations.acknowledgedBy, userId)).run();
      tx.delete(preApprovalRules).where(eq(preApprovalRules.ownerUserId, userId)).run();
      tx.update(preApprovalRules).set({ createdBy: null }).where(eq(preApprovalRules.createdBy, userId)).run();
      tx.update(mcpTokens).set({ createdBy: null }).where(eq(mcpTokens.createdBy, userId)).run();
      // A null owner lets any admin decide, so only decided rows lose it; the caller cancels live ones first.
      const mine = eq(pendingApprovals.ownerUserId, userId);
      if (
        tx
          .select({ id: pendingApprovals.id })
          .from(pendingApprovals)
          .where(and(mine, eq(pendingApprovals.status, 'pending')))
          .get()
      )
        throw new ConflictError('approvals_pending', 'The user still has pending approvals');
      tx.update(pendingApprovals)
        .set({ ownerUserId: null })
        .where(and(mine, ne(pendingApprovals.status, 'pending')))
        .run();
      tx.delete(users).where(eq(users.id, userId)).run();
      writeAudit(tx, {
        kind: 'auth',
        decision: 'user_deleted',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { userId, username: user.username, registeredVia: user.registeredVia },
      });
    });
  }

  /** A successful sign-in on any surface; `detail` says how and where. */
  recordLogin(userId: string, detail: Record<string, unknown>) {
    this.db.transaction((tx) => {
      tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId)).run();
      writeAudit(tx, { kind: 'auth', decision: 'login', actorKind: 'user', actorId: userId, detail });
    });
  }

  /** Local accounts must have TOTP when the admin requires it; the IdP owns the factors of an SSO account. */
  mustEnrollTotp(u: UserRow): boolean {
    return getSettings(this.db, 'security').requireTotp && u.kind === 'local' && !u.totpEnabled;
  }

  // ── TOTP ─────────────────────────────────────────────────────────────────────────────────────────

  private totpSecret(user: UserRow): string | null {
    if (!user.totpSecretEnc) return null;
    return this.box.decrypt(user.totpSecretEnc, aad('users', 'totp_secret_enc', user.id)).toString('utf8');
  }

  /** Starts (or restarts) enrollment. TOTP stays off until `confirmTotp` succeeds. */
  beginTotp(userId: string): { secret: string; uri: string } {
    const user = this.get(userId);
    if (user.kind === 'sso')
      throw new ConflictError('sso_account', 'This account signs in only with single sign-on, and has no app here');
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
    const step = verifyTotp(secret, code, { nowMs: this.now().getTime() });
    if (step === null) throw new ValidationError('invalid_code', 'That code is not valid');
    const codes = newRecoveryCodes();
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

  /** Replaces every recovery code. Needs a current code from the app, so a recovery code cannot renew the
   * set. Null on a wrong code (ADR-0008). */
  rotateRecoveryCodes(userId: string, code: string): string[] | null {
    const user = this.get(userId);
    if (!user.totpEnabled) throw new ConflictError('totp_disabled', 'Two-factor authentication is off');
    if (!this.verifyTotpCode(userId, code)) return null;
    const codes = newRecoveryCodes();
    this.db.transaction((tx) => {
      tx.update(users)
        .set({ recoveryCodesHash: codes.map(sha256) })
        .where(eq(users.id, userId))
        .run();
      writeAudit(tx, {
        kind: 'auth',
        decision: 'totp_recovery_rotated',
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
    const step = verifyTotp(secret, code, { nowMs: this.now().getTime(), lastStep: user.totpLastStep });
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

  /** Turning TOTP off needs a current code, so a hijacked session alone can't remove it. False on a wrong code. */
  disableOwnTotp(u: UserRow, code: string): boolean {
    if (getSettings(this.db, 'security').requireTotp && u.passwordHash) {
      throw new ConflictError('totp_required', 'Two-factor authentication is required on this server');
    }
    if (!this.verifySecondFactor(u.id, code)) return false;
    this.resetTotp(u.id);
    return true;
  }

  // ── OIDC identities (ADR-0025) ──

  /** Binds an SSO account to its identity at its first sign-in; from then on only the subject counts. */
  bindOidc(userId: string, issuer: string, subject: string) {
    const user = this.get(userId);
    if (user.kind !== 'sso' || user.oidcSubject)
      throw new ConflictError('oidc_bound', 'Only a new SSO account takes an identity');
    if (this.byOidc(issuer, subject)) throw new ConflictError('oidc_taken', 'That identity has another account');
    this.db.transaction((tx) => {
      tx.update(users)
        .set({ oidcIssuer: issuer, oidcSubject: subject, oidcEmail: null })
        .where(eq(users.id, userId))
        .run();
      writeAudit(tx, {
        kind: 'auth',
        decision: 'oidc_bound',
        actorKind: 'system',
        actorId: userId,
        detail: { username: user.username, issuer, subject },
      });
    });
  }

  /** While local login is off, refuse any change that would leave no enabled SSO account (ADR-0008). */
  assertSsoRemains(change: { oidcOff?: boolean; losingUser?: string }) {
    if (!getSettings(this.db, 'security').disableLocalLogin) return;
    if (change.oidcOff || !this.hasSsoAccount(change.losingUser)) {
      throw new ConflictError(
        'local_login_disabled',
        'Local login is disabled, so this would lock everyone out. Re-enable local login first.',
      );
    }
  }

  hasSsoAccount(except?: string): boolean {
    return this.db
      .select()
      .from(users)
      .all()
      // An account that waits for its first sign-in is no way in yet: its address may never arrive.
      .some((u) => u.kind === 'sso' && !!u.oidcSubject && !u.disabled && u.id !== except);
  }

  // ── the user's own endpoints (ADR-0010) ──

  /** An endpoint of the user's role; any other answers 404, as if it didn't exist. */
  ownEndpoint(u: UserRow, instanceId: string): string {
    if (!this.hasEndpoint(u, instanceId)) throw new NotFoundError('instance_not_found', 'No such endpoint');
    return instanceId;
  }

  hasEndpoint(u: UserRow, instanceId: string): boolean {
    return roleHasInstance(this.db, u.roleId, instanceId);
  }

  /** The role's switch on one of its endpoints (ADR-0010). */
  assertAllowed(u: UserRow, instanceId: string, cap: 'canSetOwnLevels' | 'canManageOwnRules') {
    if (!roleEndpointSwitches(this.db, u.roleId, instanceId)?.[cap])
      throw new ForbiddenError('forbidden', 'Your role does not allow this on this endpoint');
  }

  /** The user's levels on an endpoint. Without the endpoint's status switch, a non-admin sees only what they can call. */
  levels(u: UserRow, instanceId: string): LevelView {
    const who = { roleId: u.roleId, userId: u.id };
    const seesAll = !!roleEndpointSwitches(this.db, u.roleId, instanceId)?.canSeeStatus;
    return levelView(this.db, instanceId, who, { reachableOnly: !seesAll });
  }

  setOwnLevel(u: UserRow, instanceId: string, target: LevelTarget, level: AccessLevel | null): LevelView {
    setOwnLevel(this.db, u.id, instanceId, target, level);
    return this.levels(u, instanceId);
  }
}
