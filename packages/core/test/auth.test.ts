import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { OidcService } from '../src/auth/oidc.js';
import { SessionService } from '../src/auth/sessions.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { SlidingWindowLimiter } from '../src/gate/rate-limit.js';
import { signPayload, verifyPayload } from '../src/auth/tokens.js';
import { base32Decode, base32Encode, currentStep, totpAt, verifyTotp } from '../src/auth/totp.js';
import { UserService } from '../src/auth/users.js';
import { SecretBox } from '../src/crypto/index.js';
import { openDatabase } from '../src/db/index.js';
import { auditLog, users } from '../src/db/schema.js';
import { ConflictError, ValidationError } from '../src/errors.js';
import { updateSettings } from '../src/settings.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function setup() {
  const db = openDatabase(':memory:');
  const box = SecretBox.fromKey(randomBytes(32));
  return { db, box, users: new UserService(db, box) };
}

const PASSWORD = 'correct horse battery';

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 test vector', () => {
    // RFC 6238 appendix B: secret "12345678901234567890", T = 59 s → 94287082 (8 digits) → 287082.
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpAt(secret, 1)).toBe('287082');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });

  it('accepts ±1 step and refuses replays', () => {
    const secret = base32Encode(randomBytes(20));
    const now = Date.now();
    const step = currentStep(now);
    expect(verifyTotp(secret, totpAt(secret, step), { nowMs: now })).toBe(step);
    expect(verifyTotp(secret, totpAt(secret, step - 1), { nowMs: now })).toBe(step - 1);
    expect(verifyTotp(secret, totpAt(secret, step - 2), { nowMs: now })).toBeNull();
    expect(verifyTotp(secret, totpAt(secret, step), { nowMs: now, lastStep: step })).toBeNull();
    expect(verifyTotp(secret, 'abcdef', { nowMs: now })).toBeNull();
  });
});

describe('signed payloads', () => {
  it('round-trips and rejects tampering and expiry', () => {
    const key = randomBytes(32);
    const token = signPayload(key, { a: 1 }, 1000, 0);
    expect(verifyPayload(key, token, 500)).toMatchObject({ a: 1 });
    expect(verifyPayload(key, token, 1500)).toBeNull();
    expect(verifyPayload(randomBytes(32), token, 500)).toBeNull();
    expect(verifyPayload(key, token.replace(/^./, 'x'), 500)).toBeNull();
    expect(verifyPayload(key, undefined)).toBeNull();
  });
});

describe('UserService', () => {
  it('runs first-run setup once and enforces the password policy', async () => {
    const t = setup();
    await expect(t.users.setupFirstUser('admin', 'short')).rejects.toBeInstanceOf(ValidationError);
    const admin = await t.users.setupFirstUser('admin', PASSWORD);
    expect(admin).toMatchObject({ username: 'admin', hasPassword: true, totpEnabled: false });
    await expect(t.users.setupFirstUser('other', PASSWORD)).rejects.toBeInstanceOf(ConflictError);
    expect(await t.users.bootstrap('x', PASSWORD)).toBe('ignored');
    const hash = t.db.select().from(users).get()!.passwordHash!;
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  });

  it('lets only one of two concurrent first-run setups create a user (review L3)', async () => {
    const t = setup();
    const results = await Promise.allSettled([
      t.users.setupFirstUser('operator', PASSWORD),
      t.users.setupFirstUser('intruder', PASSWORD),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: expect.any(ConflictError) });
    expect(t.users.count()).toBe(1);
  });

  it('verifies passwords without revealing which usernames exist', async () => {
    const t = setup();
    await t.users.create({ username: 'admin', password: PASSWORD });
    expect((await t.users.verifyPassword('admin', PASSWORD))?.username).toBe('admin');
    expect(await t.users.verifyPassword('admin', 'wrong password!!')).toBeNull();
    expect(await t.users.verifyPassword('ghost', PASSWORD)).toBeNull();
  });

  it('changes passwords only with the current one, and keeps one active user', async () => {
    const t = setup();
    const u = await t.users.create({ username: 'admin', password: PASSWORD });
    await expect(t.users.setPassword(u.id, 'another long password', { currentPassword: 'nope' })).rejects.toThrow(
      /incorrect/,
    );
    await t.users.setPassword(u.id, 'another long password', { currentPassword: PASSWORD });
    expect(await t.users.verifyPassword('admin', 'another long password')).not.toBeNull();
    expect(() => t.users.setDisabled(u.id, true)).toThrow(/last active user/);
  });

  it('enrolls TOTP, accepts codes once, and consumes recovery codes', async () => {
    const t = setup();
    const u = await t.users.create({ username: 'admin', password: PASSWORD });
    const { secret, uri } = t.users.beginTotp(u.id);
    expect(uri).toMatch(/^otpauth:\/\/totp\/Synoikia%3Aadmin\?secret=/);
    expect(() => t.users.confirmTotp(u.id, '000000')).toThrow(/not valid/);

    const step = currentStep();
    const codes = t.users.confirmTotp(u.id, totpAt(secret, step));
    expect(codes).toHaveLength(10);
    expect(t.users.get(u.id).totpEnabled).toBe(true);
    expect(t.db.select().from(users).get()!.totpSecretEnc!.toString('latin1')).not.toContain(secret);

    // The enrollment code can't be reused; the next step's code works once.
    expect(t.users.verifySecondFactor(u.id, totpAt(secret, step))).toBeNull();
    expect(t.users.verifySecondFactor(u.id, totpAt(secret, step + 1))).toBe('totp');
    expect(t.users.verifySecondFactor(u.id, totpAt(secret, step + 1))).toBeNull();

    expect(t.users.verifySecondFactor(u.id, codes[0]!)).toBe('recovery');
    expect(t.users.verifySecondFactor(u.id, codes[0]!)).toBeNull();
    expect(t.users.get(u.id).recoveryCodesHash).toHaveLength(9);

    t.users.resetTotp(u.id);
    expect(t.users.get(u.id)).toMatchObject({ totpEnabled: false, totpSecretEnc: null });
    expect(
      t.db
        .select()
        .from(auditLog)
        .all()
        .map((a) => a.decision),
    ).toEqual(expect.arrayContaining(['totp_enabled', 'recovery_code_used', 'totp_reset']));
  });
});

describe('SessionService', () => {
  const limits = { idleMs: 30 * 60_000, absoluteMs: 12 * 3600_000 };

  it('stores only a peppered hash and enforces kind, idle and absolute expiry', async () => {
    const t = setup();
    const u = await t.users.create({ username: 'admin', password: PASSWORD });
    let now = new Date('2026-01-01T00:00:00Z');
    const sessions = new SessionService(t.db, randomBytes(32), () => now);
    const raw = sessions.create(u.id, 'admin', limits);
    expect(JSON.stringify(t.db.$client.prepare('select * from sessions').all())).not.toContain(raw);

    expect(sessions.validate(raw, 'admin', limits)?.user.username).toBe('admin');
    expect(sessions.validate(raw, 'oauth_ui', limits)).toBeNull();
    expect(sessions.validate('forged', 'admin', limits)).toBeNull();

    now = new Date(now.getTime() + 20 * 60_000);
    expect(sessions.validate(raw, 'admin', limits)).not.toBeNull(); // touched: idle clock resets
    now = new Date(now.getTime() + 31 * 60_000);
    expect(sessions.validate(raw, 'admin', limits)).toBeNull(); // idle expired and deleted

    const raw2 = sessions.create(u.id, 'admin', { idleMs: limits.idleMs, absoluteMs: 60_000 });
    now = new Date(now.getTime() + 61_000);
    expect(sessions.validate(raw2, 'admin', limits)).toBeNull(); // absolute expiry
  });

  it('revokes all of a user’s sessions except the current one, and drops disabled users', async () => {
    const t = setup();
    const a = await t.users.create({ username: 'alice', password: PASSWORD });
    await t.users.create({ username: 'bob', password: PASSWORD });
    const sessions = new SessionService(t.db, randomBytes(32));
    const keep = sessions.create(a.id, 'admin', limits);
    const other = sessions.create(a.id, 'admin', limits);
    sessions.revokeUser(a.id, keep);
    expect(sessions.validate(keep, 'admin', limits)).not.toBeNull();
    expect(sessions.validate(other, 'admin', limits)).toBeNull();
    t.users.setDisabled(a.id, true);
    expect(sessions.validate(keep, 'admin', limits)).toBeNull();
  });
});

describe('LoginThrottle', () => {
  it('counts MCP-port failures separately, so the internet cannot lock the admin portal', () => {
    const throttle = new LoginThrottle();
    for (let i = 0; i < 5; i++) throttle.fail('admin', 'mcp');
    expect(throttle.lockedFor('admin', 'mcp')).toBeGreaterThan(0);
    expect(throttle.lockedFor('admin')).toBe(0);
    expect(throttle.lockedFor('admin', 'admin')).toBe(0);
  });

  it('stays bounded under random usernames and IPs, keeping recent lockouts (review L15)', () => {
    let now = 0;
    const throttle = new LoginThrottle({}, () => now, 100);
    // Looking up names that never failed stores nothing.
    for (let i = 0; i < 1000; i++) expect(throttle.lockedFor(`nobody-${i}`, 'mcp')).toBe(0);
    expect(throttle.size).toBe(0);

    for (let i = 0; i < 5; i++) throttle.fail('admin', 'mcp');
    for (let i = 0; i < 1000; i++) {
      throttle.fail(`random-${i}`, 'mcp');
      throttle.allowIp(`10.0.${i >> 8}.${i & 255}`);
    }
    expect(throttle.size).toBeLessThanOrEqual(200);
    // Entries whose window has passed go first; a live lockout that keeps being checked stays.
    now = 60_000;
    expect(throttle.lockedFor('admin', 'mcp')).toBeGreaterThan(0);
    for (let i = 0; i < 99; i++) throttle.fail(`later-${i}`, 'mcp');
    expect(throttle.lockedFor('admin', 'mcp')).toBeGreaterThan(0);
  });

  it('bounds the rate limiter the same way', () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(() => now, 50);
    for (let i = 0; i < 500; i++) limiter.take(`k${i}`, 10, 60_000);
    expect(limiter.size).toBeLessThanOrEqual(50);
    now = 120_000;
    expect(limiter.take('k499', 1, 60_000)).toBe(true);
    expect(limiter.take('k499', 1, 60_000)).toBe(false);
  });

  it('locks a username after 5 failures for 15 minutes and limits IPs', () => {
    let now = 0;
    const throttle = new LoginThrottle({ ipLimit: 3 }, () => now);
    for (let i = 0; i < 4; i++) expect(throttle.fail('Admin')).toBe(false);
    expect(throttle.lockedFor('admin')).toBe(0);
    expect(throttle.fail('admin')).toBe(true);
    expect(throttle.lockedFor('ADMIN')).toBe(900);
    now = 15 * 60_000 + 1;
    expect(throttle.lockedFor('admin')).toBe(0);

    expect([
      throttle.allowIp('1.2.3.4'),
      throttle.allowIp('1.2.3.4'),
      throttle.allowIp('1.2.3.4'),
      throttle.allowIp('1.2.3.4'),
    ]).toEqual([true, true, true, false]);
  });
});

describe('OidcService', () => {
  async function fakeIdp() {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    const codes = new Map<
      string,
      { nonce: string; sub: string; email: string; groups: string[]; emailVerified?: boolean }
    >();
    const app = new Hono();
    let issuer = '';
    app.get('/.well-known/openid-configuration', (c) =>
      c.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      }),
    );
    app.get('/jwks', (c) => c.json({ keys: [jwk] }));
    app.post('/token', async (c) => {
      const form = await c.req.parseBody();
      const grant = codes.get(String(form.code));
      if (!grant || !form.code_verifier) return c.json({ error: 'invalid_grant' }, 400);
      const idToken = await new SignJWT({
        nonce: grant.nonce,
        email: grant.email,
        ...(grant.emailVerified === undefined ? {} : { email_verified: grant.emailVerified }),
        groups: grant.groups,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(issuer)
        .setSubject(grant.sub)
        .setAudience('portal')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return c.json({ access_token: 'at', token_type: 'Bearer', id_token: idToken, expires_in: 300 });
    });
    const server = await new Promise<Server>((resolve) => {
      const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(s as Server));
    });
    cleanup.push(() => new Promise((r) => server.close(r)));
    issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { issuer, codes };
  }

  async function signIn(
    service: OidcService,
    idp: Awaited<ReturnType<typeof fakeIdp>>,
    who: { sub: string; email: string; groups?: string[]; emailVerified?: boolean | null },
  ) {
    const { url, stateToken } = await service.begin({
      purpose: 'admin_login',
      redirectUri: 'https://admin.lan/auth/oidc/callback',
    });
    const params = new URL(url).searchParams;
    expect(params.get('code_challenge_method')).toBe('S256');
    idp.codes.set('code-1', {
      nonce: params.get('nonce')!,
      sub: who.sub,
      email: who.email,
      groups: who.groups ?? [],
      // null: the IdP leaves the claim out; default: it vouches for the address.
      emailVerified: who.emailVerified === null ? undefined : (who.emailVerified ?? true),
    });
    const callback = new URL(
      `https://admin.lan/auth/oidc/callback?code=code-1&state=${params.get('state')}&iss=${encodeURIComponent(idp.issuer)}`,
    );
    return service.complete(callback, stateToken);
  }

  it('completes code + PKCE sign-in and applies link / allow-policy / auto-provision rules', async () => {
    const t = setup();
    const idp = await fakeIdp();
    const service = new OidcService(t.db, t.box, randomBytes(32), true);
    await expect(service.begin({ purpose: 'admin_login', redirectUri: 'x' })).rejects.toThrow(/not enabled/);
    service.updateSettings({ enabled: true, issuer: idp.issuer, clientId: 'portal', clientSecret: 'shh' });
    expect(service.getSettings()).toMatchObject({ clientSecretSet: true, autoProvision: false });

    const { identity } = await signIn(service, idp, { sub: 'u-1', email: 'me@example.com', groups: ['admins'] });
    expect(identity).toMatchObject({ subject: 'u-1', email: 'me@example.com', groups: ['admins'] });

    // Not linked, no auto-provision → no user.
    expect(await service.resolveUser(t.users, identity)).toBeNull();
    const admin = await t.users.create({ username: 'admin', password: PASSWORD });
    t.users.linkOidc(admin.id, identity.issuer, identity.subject);
    expect((await service.resolveUser(t.users, identity))?.id).toBe(admin.id);

    // Allow policy applies to linked users too.
    service.updateSettings({ allowPolicy: { emails: [], subjects: [], group: 'mcp-admins', groupsClaim: 'groups' } });
    expect(await service.resolveUser(t.users, identity)).toBeNull();

    expect(() =>
      service.updateSettings({
        autoProvision: true,
        allowPolicy: { emails: [], subjects: [], group: '', groupsClaim: 'groups' },
      }),
    ).toThrow(/allow policy/);
    service.updateSettings({
      autoProvision: true,
      allowPolicy: { emails: [], subjects: [], group: 'admins', groupsClaim: 'groups' },
    });
    const second = await signIn(service, idp, { sub: 'u-2', email: 'new.person@example.com', groups: ['admins'] });
    // Auto-provisioning is self-registration: off until an admin picks a default role.
    expect(await service.resolveUser(t.users, second.identity)).toBeNull();
    updateSettings(t.db, 'security', { defaultRoleId: 'admin' });
    const provisioned = await service.resolveUser(t.users, second.identity);
    expect(provisioned).toMatchObject({ username: 'new.person', oidcSubject: 'u-2', roleId: 'admin' });
  });

  it('uses an email only when the IdP marks it verified', async () => {
    const t = setup();
    const idp = await fakeIdp();
    const service = new OidcService(t.db, t.box, randomBytes(32), true);
    service.updateSettings({
      enabled: true,
      issuer: idp.issuer,
      clientId: 'portal',
      clientSecret: 'shh',
      autoProvision: true,
      allowPolicy: { emails: ['admin@example.com'], subjects: [], group: '', groupsClaim: 'groups' },
    });
    updateSettings(t.db, 'security', { defaultRoleId: 'admin' });
    for (const emailVerified of [null, false] as const) {
      const { identity } = await signIn(service, idp, {
        sub: `u-${emailVerified}`,
        email: 'admin@example.com',
        emailVerified,
      });
      expect(identity.email).toBeUndefined();
      expect(await service.resolveUser(t.users, identity)).toBeNull();
    }
    const { identity } = await signIn(service, idp, { sub: 'u-ok', email: 'admin@example.com' });
    expect(await service.resolveUser(t.users, identity)).toMatchObject({ oidcSubject: 'u-ok' });
  });

  it('rejects tampered or replayed state', async () => {
    const t = setup();
    const idp = await fakeIdp();
    const service = new OidcService(t.db, t.box, randomBytes(32), true);
    service.updateSettings({ enabled: true, issuer: idp.issuer, clientId: 'portal' });
    const { url } = await service.begin({ purpose: 'admin_login', redirectUri: 'https://admin.lan/cb' });
    const state = new URL(url).searchParams.get('state');
    await expect(
      service.complete(new URL(`https://admin.lan/cb?code=x&state=${state}`), 'forged.token'),
    ).rejects.toThrow(/expired or invalid/);
  });
});
