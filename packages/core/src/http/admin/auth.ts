import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { writeAudit } from '../../audit.js';
import type { SessionLimits } from '../../auth/sessions.js';
import { randomToken, safeEqual, signPayload, verifyPayload } from '../../auth/tokens.js';
import type { UserRow } from '../../auth/users.js';
import { ConflictError, ServiceError } from '../../errors.js';
import { getSettings } from '../../settings.js';
import { clientIp, isSecure, readJson, requestOrigin } from '../common.js';

/** Admin auth over HTTP (ADR-0008): session cookie, double-submit CSRF plus Origin check, TOTP, OIDC. */

export type AdminEnv = { Variables: { user: UserRow; sessionRaw: string } };

const SESSION_COOKIE = 'syn_admin';
const SECURE_SESSION_COOKIE = '__Host-syn_admin';
const CSRF_COOKIE = 'syn_csrf';
const CSRF_HEADER = 'x-csrf-token';
const MFA_COOKIE = 'syn_mfa';
const OIDC_COOKIE = 'syn_oidc';
const MFA_TTL_MS = 5 * 60_000;

export function sessionLimits(ctx: AppContext): SessionLimits {
  const s = getSettings(ctx.db, 'security');
  return { idleMs: s.sessionIdleMinutes * 60_000, absoluteMs: s.sessionAbsoluteHours * 3600_000 };
}

const readSessionCookie = (c: Context) => getCookie(c, SECURE_SESSION_COOKIE) ?? getCookie(c, SESSION_COOKIE);

function setSessionCookie(c: Context, ctx: AppContext, raw: string) {
  const secure = isSecure(c, ctx.config.TRUST_PROXY);
  const limits = sessionLimits(ctx);
  // `__Host-` requires Secure; plain-HTTP LAN setups fall back to the unprefixed name.
  setCookie(c, secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, raw, {
    httpOnly: true,
    secure,
    sameSite: 'Strict',
    path: '/',
    maxAge: Math.floor(limits.absoluteMs / 1000),
  });
  setCookie(c, CSRF_COOKIE, randomToken(24), { httpOnly: false, secure, sameSite: 'Strict', path: '/' });
}

function clearSessionCookies(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  deleteCookie(c, SECURE_SESSION_COOKIE, { path: '/', secure: true });
}

export function localLoginEnabled(ctx: AppContext): boolean {
  return ctx.config.ADMIN_FORCE_LOCAL_LOGIN || !getSettings(ctx.db, 'security').disableLocalLogin;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** CSRF: double-submit token + Origin check for every state-changing request under /api and /auth. */
export function csrfGuard(ctx: AppContext): MiddlewareHandler {
  return async (c, next) => {
    if (!UNSAFE.has(c.req.method)) return next();
    const origin = c.req.header('origin');
    if (origin) {
      const expected = ctx.config.PUBLIC_ADMIN_URL
        ? new URL(ctx.config.PUBLIC_ADMIN_URL).origin
        : requestOrigin(c, ctx.config.TRUST_PROXY);
      if (origin !== expected) return c.json({ error: 'bad_origin', message: 'Cross-origin request refused' }, 403);
    }
    const cookie = getCookie(c, CSRF_COOKIE);
    const header = c.req.header(CSRF_HEADER);
    if (!cookie || !header || !safeEqual(cookie, header)) {
      return c.json({ error: 'csrf', message: 'Missing or invalid CSRF token' }, 403);
    }
    return next();
  };
}

const TOTP_ENROLL_PATHS = ['/api/session', '/api/profile', '/api/profile/totp/begin', '/api/profile/totp/confirm'];

export function requireUser(ctx: AppContext): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const raw = readSessionCookie(c);
    const session = ctx.sessions.validate(raw, 'admin', sessionLimits(ctx));
    if (!session || !raw) return c.json({ error: 'unauthenticated', message: 'Sign in first' }, 401);
    if (ctx.users.mustEnrollTotp(session.user) && !TOTP_ENROLL_PATHS.includes(c.req.path)) {
      return c.json({ error: 'totp_enrollment_required', message: 'Set up two-factor authentication first' }, 403);
    }
    c.set('user', session.user);
    c.set('sessionRaw', raw);
    return next();
  };
}

/** After `requireUser`: the Admin role only (ADR-0010). */
export function requireAdmin(ctx: AppContext): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    if (!ctx.users.isAdmin(c.get('user')))
      return c.json({ error: 'forbidden', message: 'Only administrators can do this' }, 403);
    return next();
  };
}

/** The sign-in page offers "Create account" (ADR-0010). */
export const signupOpen = (ctx: AppContext) =>
  localLoginEnabled(ctx) && getSettings(ctx.db, 'security').localSignup && ctx.users.registrationOpen();

function startSession(c: Context, ctx: AppContext, user: UserRow, method: string) {
  const raw = ctx.sessions.create(user.id, 'admin', sessionLimits(ctx), {
    ip: clientIp(c, ctx.config.TRUST_PROXY),
    userAgent: c.req.header('user-agent'),
  });
  setSessionCookie(c, ctx, raw);
  ctx.users.recordLogin(user.id, { username: user.username, method, ip: clientIp(c, ctx.config.TRUST_PROXY) });
}

function adminCallbackUrl(c: Context, ctx: AppContext): string {
  const base = ctx.config.PUBLIC_ADMIN_URL ?? requestOrigin(c, ctx.config.TRUST_PROXY);
  return new URL('/auth/oidc/callback', base).toString();
}

const lockedAnswer = (lockedFor: number) => ({
  error: 'locked',
  message: `Too many failed attempts; try again in ${Math.ceil(lockedFor / 60)} min`,
});

/** A wrong second-factor code counts toward the name's lock (ADR-0008), announces a new lock and is audited. */
function codeFailed(ctx: AppContext, username: string, detail: Record<string, unknown> = {}) {
  if (ctx.throttle.fail(username)) ctx.events.emit('auth.lockout', { username });
  writeAudit(ctx.db, { kind: 'auth', decision: 'totp_failed', actorKind: 'system', detail: { username, ...detail } });
}

/** A profile change that needs a current code: the sign-in lock of the name covers it too (ADR-0008). */
async function withProfileCode<T>(
  c: Context<AdminEnv>,
  ctx: AppContext,
  verify: (user: UserRow, code: string) => T | null | false,
  done: (result: T) => Response,
): Promise<Response> {
  const { code } = await readJson(c, z.object({ code: z.string().max(32) }));
  const user = c.get('user');
  const lockedFor = ctx.throttle.lockedFor(user.username);
  if (lockedFor > 0) return c.json(lockedAnswer(lockedFor), 429);
  const result = verify(user, code);
  if (!result) {
    codeFailed(ctx, user.username, { route: c.req.path });
    return c.json({ error: 'invalid_code', message: 'Invalid code' }, 401);
  }
  ctx.throttle.succeed(user.username);
  return done(result);
}

// A browser reads `\` as `/` and drops tabs and line ends, so only a plain path stays on the portal (ADR-0008).
const safeReturnTo = (v: string | undefined) =>
  v && v.startsWith('/') && !v.startsWith('//') && ![...v].some((ch) => ch <= ' ' || ch === '\\' || ch === '\x7f')
    ? v
    : '/';

export function registerAuthRoutes(app: Hono<AdminEnv>, ctx: AppContext) {
  const LoginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(1024) });

  // Public session probe: also hands out the CSRF cookie the SPA echoes back.
  app.get('/api/session', (c) => {
    if (!getCookie(c, CSRF_COOKIE)) {
      setCookie(c, CSRF_COOKIE, randomToken(24), {
        httpOnly: false,
        secure: isSecure(c, ctx.config.TRUST_PROXY),
        sameSite: 'Strict',
        path: '/',
      });
    }
    const oidc = ctx.oidc.getSettings();
    const base = {
      setupRequired: ctx.users.count() === 0,
      localLoginEnabled: localLoginEnabled(ctx),
      signupOpen: signupOpen(ctx),
      oidc: { enabled: !!oidc?.enabled, label: oidc?.label ?? 'SSO' },
    };
    const session = ctx.sessions.validate(readSessionCookie(c), 'admin', sessionLimits(ctx));
    if (!session) return c.json({ authenticated: false, ...base });
    return c.json({
      authenticated: true,
      ...base,
      user: ctx.users.toPublic(session.user),
      mustEnrollTotp: ctx.users.mustEnrollTotp(session.user),
    });
  });

  app.post('/api/setup', async (c) => {
    const body = await readJson(c, LoginBody);
    const created = await ctx.users.setupFirstUser(body.username, body.password);
    startSession(c, ctx, ctx.users.get(created.id), 'setup');
    return c.json({ status: 'ok', user: created });
  });

  app.post('/auth/register', async (c) => {
    const ip = clientIp(c, ctx.config.TRUST_PROXY);
    if (!ctx.throttle.allowIp(ip))
      return c.json({ error: 'rate_limited', message: 'Too many attempts; try again later' }, 429);
    if (!signupOpen(ctx))
      return c.json({ error: 'registration_closed', message: 'This server does not accept new accounts' }, 403);
    const body = await readJson(c, LoginBody);
    let created;
    try {
      created = await ctx.users.register({ username: body.username, password: body.password }, 'signup');
    } catch (err) {
      // One answer for a taken name: sign-up must not list which accounts exist.
      if (err instanceof ConflictError && err.code === 'username_taken')
        return c.json({ error: 'registration_failed', message: 'Choose another username' }, 400);
      throw err;
    }
    const user = ctx.users.get(created.id);
    startSession(c, ctx, user, 'signup');
    return c.json({ status: 'ok', mustEnrollTotp: ctx.users.mustEnrollTotp(user) }, 201);
  });

  app.post('/auth/login', async (c) => {
    const ip = clientIp(c, ctx.config.TRUST_PROXY);
    if (!ctx.throttle.allowIp(ip))
      return c.json({ error: 'rate_limited', message: 'Too many attempts; try again later' }, 429);
    if (!localLoginEnabled(ctx)) return c.json({ error: 'local_login_disabled', message: 'Use single sign-on' }, 403);
    const body = await readJson(c, LoginBody);
    const lockedFor = ctx.throttle.lockedFor(body.username);
    if (lockedFor > 0) return c.json(lockedAnswer(lockedFor), 429);
    const user = await ctx.users.verifyPassword(body.username, body.password);
    if (!user) {
      const locked = ctx.throttle.fail(body.username);
      writeAudit(ctx.db, {
        kind: 'auth',
        decision: locked ? 'login_locked' : 'login_failed',
        actorKind: 'system',
        detail: { username: body.username, ip },
      });
      if (locked) ctx.events.emit('auth.lockout', { username: body.username, ip });
      return c.json({ error: 'invalid_credentials', message: 'Invalid username or password' }, 401);
    }
    if (user.totpEnabled) {
      setCookie(c, MFA_COOKIE, signPayload(ctx.keys.state, { mfaUser: user.id }, MFA_TTL_MS, ctx.now().getTime()), {
        httpOnly: true,
        secure: isSecure(c, ctx.config.TRUST_PROXY),
        sameSite: 'Strict',
        path: '/auth',
        maxAge: MFA_TTL_MS / 1000,
      });
      return c.json({ status: 'totp_required' });
    }
    ctx.throttle.succeed(body.username);
    startSession(c, ctx, user, 'password');
    return c.json({ status: 'ok', mustEnrollTotp: ctx.users.mustEnrollTotp(user) });
  });

  app.post('/auth/totp', async (c) => {
    if (!ctx.throttle.allowIp(clientIp(c, ctx.config.TRUST_PROXY)))
      return c.json({ error: 'rate_limited', message: 'Too many attempts; try again later' }, 429);
    const { code } = await readJson(c, z.object({ code: z.string().min(1).max(32) }));
    const pending = verifyPayload<{ mfaUser: string }>(ctx.keys.state, getCookie(c, MFA_COOKIE), ctx.now().getTime());
    if (!pending) return c.json({ error: 'mfa_expired', message: 'Sign in again' }, 401);
    const user = ctx.users.get(pending.mfaUser);
    if (ctx.throttle.lockedFor(user.username) > 0)
      return c.json({ error: 'locked', message: 'Too many failed attempts' }, 429);
    const factor = ctx.users.verifySecondFactor(user.id, code);
    if (!factor) {
      codeFailed(ctx, user.username);
      return c.json({ error: 'invalid_code', message: 'Invalid code' }, 401);
    }
    deleteCookie(c, MFA_COOKIE, { path: '/auth' });
    ctx.throttle.succeed(user.username);
    startSession(c, ctx, user, factor === 'recovery' ? 'password+recovery_code' : 'password+totp');
    return c.json({ status: 'ok' });
  });

  app.post('/auth/logout', (c) => {
    ctx.sessions.revoke(readSessionCookie(c));
    clearSessionCookies(c);
    return c.json({ status: 'ok' });
  });

  // OIDC: sign in, or link the signed-in user's account (Profile → Link).
  app.get('/auth/oidc/start', async (c) => {
    const { url, stateToken } = await ctx.oidc.begin({
      purpose: 'admin_login',
      redirectUri: adminCallbackUrl(c, ctx),
      returnTo: safeReturnTo(c.req.query('returnTo')),
    });
    setCookie(c, OIDC_COOKIE, stateToken, {
      httpOnly: true,
      secure: isSecure(c, ctx.config.TRUST_PROXY),
      sameSite: 'Lax',
      path: '/auth',
      maxAge: 600,
    });
    return c.redirect(url);
  });

  app.get('/auth/oidc/callback', async (c) => {
    const fail = (code: string) => c.redirect(`/login?error=${encodeURIComponent(code)}`);
    let result;
    try {
      result = await ctx.oidc.complete(new URL(c.req.url).search, getCookie(c, OIDC_COOKIE));
    } catch (err) {
      writeAudit(ctx.db, {
        kind: 'auth',
        decision: 'oidc_failed',
        actorKind: 'system',
        detail: { error: err instanceof Error ? err.message : String(err) },
      });
      return fail('oidc_failed');
    } finally {
      deleteCookie(c, OIDC_COOKIE, { path: '/auth' });
    }
    const { identity, state } = result;
    if (state.purpose !== 'admin_login') return fail('wrong_flow');
    const user = await ctx.oidc.resolveUser(ctx.users, identity);
    if (!user) {
      writeAudit(ctx.db, {
        kind: 'auth',
        decision: 'oidc_denied',
        actorKind: 'system',
        detail: { issuer: identity.issuer, subject: identity.subject, email: identity.email },
      });
      return fail('oidc_not_allowed');
    }
    startSession(c, ctx, user, 'oidc');
    return c.redirect(safeReturnTo(state.returnTo));
  });
}

export function registerProfileRoutes(app: Hono<AdminEnv>, ctx: AppContext) {
  app.get('/api/profile', (c) => c.json(ctx.users.profile(c.get('user').id)));

  app.post('/api/profile/password', async (c) => {
    const body = await readJson(c, z.object({ currentPassword: z.string().optional(), newPassword: z.string() }));
    const user = c.get('user');
    // The current password is a guess like a sign-in: it counts toward the name's lock (ADR-0008).
    const lockedFor = ctx.throttle.lockedFor(user.username);
    if (lockedFor > 0) return c.json(lockedAnswer(lockedFor), 429);
    try {
      await ctx.users.setPassword(user.id, body.newPassword, {
        currentPassword: body.currentPassword ?? '',
        actorId: user.id,
      });
    } catch (err) {
      if (err instanceof ServiceError && err.code === 'wrong_password') {
        if (ctx.throttle.fail(user.username)) ctx.events.emit('auth.lockout', { username: user.username });
        writeAudit(ctx.db, {
          kind: 'auth',
          decision: 'password_failed',
          actorKind: 'system',
          detail: { username: user.username, route: c.req.path },
        });
      }
      throw err;
    }
    ctx.throttle.succeed(user.username);
    ctx.sessions.revokeUser(user.id, c.get('sessionRaw'));
    ctx.oauth.revokeUserGrants(user.id, 'password_changed', { userId: user.id });
    return c.json({ status: 'ok' });
  });

  // Approval browsers (ADR-0006): MCP-port sign-ins that open approval pages without a new sign-in.
  app.get('/api/profile/approval-sessions', (c) => c.json(ctx.sessions.listKind(c.get('user').id, 'approval_ui')));

  app.post('/api/profile/approval-sessions/revoke', (c) => {
    return c.json({ revoked: ctx.sessions.revokeApprovalBrowsers(c.get('user').id) });
  });

  app.post('/api/profile/totp/begin', (c) => c.json(ctx.users.beginTotp(c.get('user').id)));

  app.post('/api/profile/totp/confirm', async (c) => {
    const { code } = await readJson(c, z.object({ code: z.string() }));
    const recoveryCodes = ctx.users.confirmTotp(c.get('user').id, code);
    // A new authenticator: approval browsers signed in without it and must sign in again.
    ctx.sessions.revokeKind(c.get('user').id, 'approval_ui');
    return c.json({ recoveryCodes });
  });

  app.post('/api/profile/totp/disable', (c) =>
    withProfileCode(
      c,
      ctx,
      (user, code) => ctx.users.disableOwnTotp(user, code),
      () => {
        ctx.sessions.revokeKind(c.get('user').id, 'approval_ui');
        return c.json({ status: 'ok' });
      },
    ),
  );

  app.post('/api/profile/totp/recovery-codes', (c) =>
    withProfileCode(
      c,
      ctx,
      (user, code) => ctx.users.rotateRecoveryCodes(user.id, code),
      (recoveryCodes) => c.json({ recoveryCodes }),
    ),
  );
}
