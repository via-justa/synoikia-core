import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppContext } from '../../app.js';
import { writeAudit } from '../../audit.js';
import { roleHasInstance } from '../../catalog/role-levels.js';
import { effectiveAuthMode, publicMcpBase, resourceUrl } from '../../auth/mcp-auth.js';
import { canonicalResource, OAuthError } from '../../auth/oauth.js';
import type { OAuthService } from '../../auth/oauth.js';
import type { SessionLimits, ValidSession } from '../../auth/sessions.js';
import { randomToken, safeEqual, sha256, signPayload, verifyPayload } from '../../auth/tokens.js';
import { ServiceError } from '../../errors.js';
import { getSettings } from '../../settings.js';
import { localLoginEnabled, mustEnrollTotp } from '../admin/auth.js';
import { clientIp, isSecure } from '../common.js';
import { consentPage, errorPage, loginPage, totpPage } from './pages.js';

/** OAuth 2.1 endpoints and the MCP-port sign-in (design §6.2): portal accounts, but a separate
 * short-lived session that works only for consent and approval pages. */

/** MCP-port sign-ins are separated by purpose (design §2.1), each with its own scoped cookie. */
export type UiPurpose = 'oauth' | 'approval';
const UI_SESSIONS = {
  oauth: { cookie: 'syn_mcp_oauth', kind: 'oauth_ui', path: '/oauth' },
  approval: { cookie: 'syn_mcp_approve', kind: 'approval_ui', path: '/a' },
} as const;
/** Which kind of session a sign-in continuing to `continueTo` creates. */
const purposeOf = (continueTo: string): UiPurpose => (continueTo.startsWith('/a/') ? 'approval' : 'oauth');
const UI_CSRF_COOKIE = 'syn_mcp_csrf';
const OIDC_COOKIE = 'syn_mcp_oidc';
const OAUTH_UI_LIMITS: SessionLimits = { idleMs: 15 * 60_000, absoluteMs: 60 * 60_000 };

/** The consent page keeps a short session; the approval page one browser-long session (design §5.3). */
function uiLimits(ctx: AppContext, purpose: UiPurpose): SessionLimits {
  if (purpose === 'oauth') return OAUTH_UI_LIMITS;
  const s = getSettings(ctx.db, 'security');
  return { idleMs: s.approvalSessionIdleHours * 3_600_000, absoluteMs: s.approvalSessionAbsoluteDays * 86_400_000 };
}
const FORM_TTL_MS = 10 * 60_000;
const NEEDS_TOTP =
  'This server requires two-factor authentication. Set up your authenticator app in the admin portal (Profile) first.';

/** Where a sign-in may continue to: only our own consent and approval pages. */
const safeContinue = (v: unknown) =>
  typeof v === 'string' && (v.startsWith('/oauth/authorize?') || /^\/a\/[A-Za-z0-9_-]+$/.test(v))
    ? v
    : '/oauth/authorize';

export function uiSession(ctx: AppContext, c: Context, purpose: UiPurpose): ValidSession | null {
  const { cookie, kind } = UI_SESSIONS[purpose];
  return ctx.sessions.validate(getCookie(c, cookie), kind, uiLimits(ctx, purpose));
}

/** Double-submit CSRF for the MCP-port forms (SameSite=Strict cookie + hidden field). */
export function uiCsrf(ctx: AppContext, c: Context): string {
  let token = getCookie(c, UI_CSRF_COOKIE);
  if (!token) {
    token = randomToken(24);
    setCookie(c, UI_CSRF_COOKIE, token, {
      httpOnly: true,
      secure: isSecure(c, ctx.config.TRUST_PROXY),
      sameSite: 'Strict',
      path: '/',
    });
  }
  return token;
}

export const checkUiCsrf = (c: Context, submitted: unknown) => {
  const cookie = getCookie(c, UI_CSRF_COOKIE);
  return !!cookie && typeof submitted === 'string' && safeEqual(cookie, submitted);
};

/** When each MCP-port session last proved TOTP (design §5.3); in memory, so a restart asks again. */
const totpProofs = new Map<string, number>();

export function recordTotpProof(ctx: AppContext, idHash: string) {
  const now = ctx.now().getTime();
  const maxAge = uiLimits(ctx, 'approval').absoluteMs;
  for (const [k, at] of totpProofs) if (now - at > maxAge) totpProofs.delete(k);
  totpProofs.set(idHash, now);
}

/** Milliseconds since this session last proved TOTP, or Infinity if it never did. */
export function sinceTotpProof(ctx: AppContext, session: ValidSession): number {
  const at = totpProofs.get(session.idHash);
  return at === undefined ? Infinity : ctx.now().getTime() - at;
}

function startUiSession(ctx: AppContext, c: Context, userId: string, method: string, continueTo: string) {
  const purpose = purposeOf(continueTo);
  const { cookie, kind, path } = UI_SESSIONS[purpose];
  const limits = uiLimits(ctx, purpose);
  const raw = ctx.sessions.create(userId, kind, limits, {
    ip: clientIp(c, ctx.config.TRUST_PROXY),
    userAgent: c.req.header('user-agent'),
  });
  if (method === 'password+totp') recordTotpProof(ctx, ctx.sessions.hashId(raw));
  // Lax: the browser must send it when an OIDC provider redirects back into the consent flow.
  setCookie(c, cookie, raw, {
    httpOnly: true,
    secure: isSecure(c, ctx.config.TRUST_PROXY),
    sameSite: 'Lax',
    path,
    maxAge: limits.absoluteMs / 1000,
  });
  ctx.users.markLogin(userId);
  writeAudit(ctx.db, {
    kind: 'auth',
    decision: 'login',
    actorKind: 'user',
    actorId: userId,
    detail: { method, surface: 'mcp', purpose },
  });
}

export function renderLogin(
  ctx: AppContext,
  c: Context,
  continueTo: string,
  purpose: string,
  error?: string,
  status: 200 | 401 | 403 | 429 = 200,
) {
  const oidc = ctx.oidc.getSettings();
  return loginPage(
    c,
    {
      purpose,
      continueTo,
      csrf: uiCsrf(ctx, c),
      error,
      localLogin: localLoginEnabled(ctx),
      oidc: oidc?.enabled ? { label: oidc.label } : undefined,
    },
    status,
  );
}

interface AuthorizeRequest extends Record<string, unknown> {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  offered: string[];
  preselected: string[];
  session: string;
}

export function registerOAuthRoutes(app: Hono, ctx: AppContext, oauth: OAuthService) {
  // The authorization server only runs with a configured public URL (design §2.1): its issuer and every
  // discovery document must not come from the request's Host header, which a client controls.
  const asOff = (c: Context) => {
    c.header('Cache-Control', 'no-store');
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'OAuth is off until the server operator sets PUBLIC_MCP_URL',
      },
      503,
    );
  };
  for (const path of [
    '/.well-known/*',
    '/oauth/register',
    '/oauth/authorize',
    '/oauth/consent',
    '/oauth/token',
    '/oauth/revoke',
  ]) {
    app.use(path, async (c, next) => (ctx.config.PUBLIC_MCP_URL ? next() : asOff(c)));
  }
  const issuer = (c: Context) => publicMcpBase(ctx, c);
  const oauthEndpoints = (c: Context) =>
    ctx.instances
      .list()
      .filter((i) => {
        const mode = effectiveAuthMode(ctx, i.authMode);
        return mode === 'oauth' || mode === 'bearer+oauth';
      })
      .map((i) => ({ resource: resourceUrl(issuer(c), i.slug), slug: i.slug, name: i.displayName, id: i.id }));

  // ── metadata ──

  const asMetadata = (c: Context) => {
    const base = issuer(c);
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      revocation_endpoint: `${base}/oauth/revoke`,
      ...(getSettings(ctx.db, 'mcp').allowDynamicRegistration
        ? { registration_endpoint: `${base}/oauth/register` }
        : {}),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: ['mcp'],
      authorization_response_iss_parameter_supported: true,
    };
  };
  app.get('/.well-known/oauth-authorization-server', (c) => c.json(asMetadata(c)));
  app.get('/.well-known/openid-configuration', (c) => c.json(asMetadata(c)));

  // RFC 9728: the path of the protected resource is appended to the well-known prefix.
  app.get('/.well-known/oauth-protected-resource/:slug', (c) => {
    const endpoint = ctx.instances.bySlug(c.req.param('slug'));
    const mode = endpoint && effectiveAuthMode(ctx, endpoint.instance.authMode);
    if (!endpoint || (mode !== 'oauth' && mode !== 'bearer+oauth')) return c.json({ error: 'not_found' }, 404);
    return c.json({
      resource: resourceUrl(issuer(c), endpoint.instance.slug),
      authorization_servers: [issuer(c)],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
      // No resource_name: the endpoint's display name is not for unauthenticated callers.
    });
  });

  // ── dynamic client registration (RFC 7591) ──

  app.post('/oauth/register', async (c) => {
    if (!getSettings(ctx.db, 'mcp').allowDynamicRegistration) {
      return c.json(
        { error: 'registration_disabled', error_description: 'Ask the administrator to register this client' },
        403,
      );
    }
    if (!ctx.throttle.allowIp(clientIp(c, ctx.config.TRUST_PROXY))) return c.json({ error: 'slow_down' }, 429);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_client_metadata', error_description: 'Body must be JSON' }, 400);
    }
    try {
      return c.json(oauth.register(body, 'dcr'), 201);
    } catch (err) {
      if (err instanceof OAuthError) return c.json({ error: err.code, error_description: err.message }, 400);
      throw err;
    }
  });

  // ── authorize: validate, then sign-in, then consent ──

  app.get('/oauth/authorize', (c) => {
    const q = new URL(c.req.url).searchParams;
    const client = oauth.client(q.get('client_id') ?? '');
    if (!client) return errorPage(c, 'Unknown application', 'This application is not registered with this server.');
    const redirectUri = q.get('redirect_uri') ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : '');
    // Never redirect to an unregistered URI, not even with an error.
    if (!client.redirectUris.includes(redirectUri))
      return errorPage(c, 'Invalid redirect', 'The redirect address is not registered for this application.');

    const back = (params: Record<string, string>) => {
      const url = new URL(redirectUri);
      for (const [k, v] of Object.entries({
        ...params,
        ...(q.get('state') ? { state: q.get('state')! } : {}),
        iss: issuer(c),
      }))
        url.searchParams.set(k, v);
      return c.redirect(url.toString());
    };
    if (q.get('response_type') !== 'code') return back({ error: 'unsupported_response_type' });
    const challenge = q.get('code_challenge');
    if (!challenge || q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return back({ error: 'invalid_request', error_description: 'PKCE with S256 is required' });
    }
    const available = oauthEndpoints(c);
    const requested = q.getAll('resource').map(canonicalResource);
    const unknown = requested.filter((r) => !available.some((e) => e.resource === r));
    if (unknown.length)
      return back({
        error: 'invalid_target',
        error_description: `Unknown or non-OAuth endpoint: ${unknown.join(', ')}`,
      });
    const offered = requested.length ? available.filter((e) => requested.includes(e.resource)) : available;
    if (offered.length === 0) return back({ error: 'invalid_target', error_description: 'No endpoints accept OAuth' });

    const session = uiSession(ctx, c, 'oauth');
    const continueTo = `/oauth/authorize?${q.toString()}`;
    if (!session) return renderLogin(ctx, c, continueTo, `Sign in to let ${client.name} use your MCP endpoints.`);
    // A user can only hand out endpoints their role has (design §6.4).
    const mine = offered.filter((e) => roleHasInstance(ctx.db, session.user.roleId, e.id));
    if (mine.length === 0)
      return errorPage(c, 'No endpoints', 'None of the requested endpoints is available to your account.', 403);

    const form: AuthorizeRequest = {
      clientId: client.clientId,
      redirectUri,
      state: q.get('state') ?? undefined,
      codeChallenge: challenge,
      offered: mine.map((e) => e.resource),
      preselected: requested,
      session: sha256(getCookie(c, UI_SESSIONS.oauth.cookie) ?? ''),
    };
    return consentPage(c, {
      clientName: client.name,
      redirectHost: new URL(redirectUri).host || redirectUri,
      username: session.user.username,
      endpoints: mine.map((e) => ({ ...e, checked: requested.includes(e.resource) })),
      formToken: signPayload(ctx.keys.state, form, FORM_TTL_MS),
      access: 'read',
    });
  });

  app.post('/oauth/consent', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const form = verifyPayload<AuthorizeRequest>(ctx.keys.state, typeof body.form === 'string' ? body.form : undefined);
    const session = uiSession(ctx, c, 'oauth');
    // The consent form is bound to the session that rendered it (and so to this browser).
    if (!form || !session || form.session !== sha256(getCookie(c, UI_SESSIONS.oauth.cookie) ?? '')) {
      return errorPage(c, 'Session expired', 'Start the connection again from your MCP client.');
    }
    const client = oauth.client(form.clientId);
    if (!client || !client.redirectUris.includes(form.redirectUri))
      return errorPage(c, 'Unknown application', 'This application is no longer registered.');
    const back = (params: Record<string, string>) => {
      const url = new URL(form.redirectUri);
      for (const [k, v] of Object.entries({ ...params, ...(form.state ? { state: form.state } : {}), iss: issuer(c) }))
        url.searchParams.set(k, v);
      return c.redirect(url.toString(), 302);
    };
    if (body.decision !== 'approve') {
      writeAudit(ctx.db, {
        kind: 'auth',
        decision: 'oauth_consent_denied',
        actorKind: 'user',
        actorId: session.user.id,
        detail: { clientId: client.clientId },
      });
      return back({ error: 'access_denied' });
    }
    const chosen = ([] as unknown[]).concat(body.resource ?? []).filter((r): r is string => typeof r === 'string');
    // Bind each resource to the instance it names right now; one renamed since the form was shown drops out.
    const current = new Map(oauthEndpoints(c).map((e) => [e.resource, e.id]));
    const resources = [...new Set(chosen.map(canonicalResource))].filter(
      (r) => form.offered.includes(r) && current.has(r) && roleHasInstance(ctx.db, session.user.roleId, current.get(r)!),
    );
    if (resources.length === 0) {
      return consentPage(c, {
        clientName: client.name,
        redirectHost: new URL(form.redirectUri).host || form.redirectUri,
        username: session.user.username,
        endpoints: oauthEndpoints(c)
          .filter((e) => form.offered.includes(e.resource))
          .map((e) => ({ ...e, checked: false })),
        formToken: signPayload(ctx.keys.state, form, FORM_TTL_MS),
        access: body.access === 'write' ? 'write' : 'read',
        error: 'Pick at least one endpoint, or deny.',
      });
    }
    const code = oauth.issueCode({
      client,
      userId: session.user.id,
      resources,
      instanceIds: resources.map((r) => current.get(r)!),
      // Anything but an explicit "Read & write" choice is read-only (design §6.3).
      access: body.access === 'write' ? 'write' : 'read',
      codeChallenge: form.codeChallenge,
      redirectUri: form.redirectUri,
    });
    return back({ code });
  });

  // ── MCP-port sign-in (also used by the approval page) ──

  app.post('/oauth/login', async (c) => {
    const body = await c.req.parseBody();
    const continueTo = safeContinue(body.continue);
    if (!checkUiCsrf(c, body.csrf))
      return renderLogin(ctx, c, continueTo, 'Sign in', 'Your form expired; try again.', 401);
    if (!localLoginEnabled(ctx)) return renderLogin(ctx, c, continueTo, 'Sign in', 'Use single sign-on.', 401);
    const ip = clientIp(c, ctx.config.TRUST_PROXY);
    const username = String(body.username ?? '').slice(0, 64);
    if (!ctx.throttle.allowIp(ip) || ctx.throttle.lockedFor(username, 'mcp') > 0) {
      return renderLogin(ctx, c, continueTo, 'Sign in', 'Too many attempts; try again later.', 429);
    }
    const user = await ctx.users.verifyPassword(username, String(body.password ?? '').slice(0, 1024));
    if (!user) {
      if (ctx.throttle.fail(username, 'mcp')) ctx.events.emit('auth.lockout', { username, ip, surface: 'mcp' });
      writeAudit(ctx.db, {
        kind: 'auth',
        decision: 'login_failed',
        actorKind: 'system',
        detail: { username, ip, surface: 'mcp' },
      });
      return renderLogin(ctx, c, continueTo, 'Sign in', 'Invalid username or password.', 401);
    }
    if (mustEnrollTotp(ctx, user)) {
      // The portal would force enrollment first; the internet-facing sign-in must not skip it.
      return renderLogin(ctx, c, continueTo, 'Sign in', NEEDS_TOTP, 403);
    }
    if (user.totpEnabled) {
      return totpPage(c, {
        mfa: signPayload(ctx.keys.state, { mfaUser: user.id }, 5 * 60_000),
        continueTo,
        csrf: uiCsrf(ctx, c),
      });
    }
    ctx.throttle.succeed(username, 'mcp');
    startUiSession(ctx, c, user.id, 'password', continueTo);
    return c.redirect(continueTo, 303);
  });

  app.post('/oauth/login/totp', async (c) => {
    const body = await c.req.parseBody();
    const continueTo = safeContinue(body.continue);
    const pending = verifyPayload<{ mfaUser: string }>(
      ctx.keys.state,
      typeof body.mfa === 'string' ? body.mfa : undefined,
    );
    if (!checkUiCsrf(c, body.csrf) || !pending)
      return renderLogin(ctx, c, continueTo, 'Sign in', 'Your sign-in expired; try again.', 401);
    const user = ctx.users.get(pending.mfaUser);
    if (ctx.throttle.lockedFor(user.username, 'mcp') > 0)
      return renderLogin(ctx, c, continueTo, 'Sign in', 'Too many attempts; try again later.', 429);
    if (!ctx.users.verifySecondFactor(user.id, String(body.code ?? ''))) {
      ctx.throttle.fail(user.username, 'mcp');
      return totpPage(c, { mfa: String(body.mfa), continueTo, csrf: uiCsrf(ctx, c), error: 'Invalid code.' }, 401);
    }
    ctx.throttle.succeed(user.username, 'mcp');
    startUiSession(ctx, c, user.id, 'password+totp', continueTo);
    return c.redirect(continueTo, 303);
  });

  app.get('/oauth/login/oidc', async (c) => {
    const { url, stateToken } = await ctx.oidc.begin({
      purpose: 'mcp_login',
      redirectUri: `${issuer(c)}/oauth/oidc/callback`,
      returnTo: safeContinue(c.req.query('continue')),
    });
    setCookie(c, OIDC_COOKIE, stateToken, {
      httpOnly: true,
      secure: isSecure(c, ctx.config.TRUST_PROXY),
      sameSite: 'Lax',
      path: '/oauth',
      maxAge: 600,
    });
    return c.redirect(url);
  });

  app.get('/oauth/oidc/callback', async (c) => {
    try {
      const { identity, state } = await ctx.oidc.complete(
        new URL(c.req.url, `${issuer(c)}/oauth/oidc/callback`),
        getCookie(c, OIDC_COOKIE),
      );
      if (state.purpose !== 'mcp_login') return errorPage(c, 'Sign-in failed', 'Unexpected sign-in flow.');
      const user = await ctx.oidc.resolveUser(ctx.users, identity);
      if (!user) return errorPage(c, 'Not allowed', 'Your account is not allowed to sign in here.', 403);
      if (mustEnrollTotp(ctx, user)) return errorPage(c, 'Two-factor authentication required', NEEDS_TOTP, 403);
      const continueTo = safeContinue(state.returnTo);
      startUiSession(ctx, c, user.id, 'oidc', continueTo);
      return c.redirect(continueTo);
    } catch (err) {
      if (err instanceof ServiceError) return errorPage(c, 'Sign-in failed', err.message);
      throw err;
    } finally {
      deleteCookie(c, OIDC_COOKIE, { path: '/oauth' });
    }
  });

  // ── token & revocation (form-encoded, RFC 6749 errors, no caching) ──

  const clientCredentials = (c: Context, body: Record<string, unknown>) => {
    const basic = c.req.header('authorization')?.match(/^Basic\s+(.+)$/i)?.[1];
    if (basic) {
      const [id, secret] = Buffer.from(basic, 'base64').toString('utf8').split(':');
      return { id: decodeURIComponent(id ?? ''), secret: decodeURIComponent(secret ?? '') };
    }
    return {
      id: typeof body.client_id === 'string' ? body.client_id : undefined,
      secret: typeof body.client_secret === 'string' ? body.client_secret : undefined,
    };
  };
  const oauthError = (c: Context, err: unknown) => {
    c.header('Cache-Control', 'no-store');
    if (err instanceof OAuthError) return c.json({ error: err.code, error_description: err.message }, err.httpStatus);
    throw err;
  };

  app.post('/oauth/token', async (c) => {
    c.header('Cache-Control', 'no-store');
    const body = await c.req.parseBody({ all: true });
    const one = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined);
    const resources = ([] as unknown[]).concat(body.resource ?? []).filter((r): r is string => typeof r === 'string');
    const mcp = getSettings(ctx.db, 'mcp');
    const ttl = { accessMs: mcp.accessTokenTtlMinutes * 60_000, refreshMs: mcp.refreshTokenTtlDays * 86_400_000 };
    try {
      const creds = clientCredentials(c, body);
      const client = oauth.authenticateClient(creds.id, creds.secret);
      switch (one('grant_type')) {
        case 'authorization_code':
          return c.json(
            oauth.exchangeCode({
              client,
              code: one('code') ?? '',
              redirectUri: one('redirect_uri') ?? '',
              codeVerifier: one('code_verifier') ?? '',
              resource: resources,
              ttl,
            }),
          );
        case 'refresh_token':
          return c.json(oauth.refresh({ client, refreshToken: one('refresh_token') ?? '', resource: resources, ttl }));
        default:
          throw new OAuthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported');
      }
    } catch (err) {
      return oauthError(c, err);
    }
  });

  app.post('/oauth/revoke', async (c) => {
    const body = await c.req.parseBody();
    try {
      const creds = clientCredentials(c, body);
      const client = oauth.authenticateClient(creds.id, creds.secret);
      if (typeof body.token === 'string') oauth.revokeToken(body.token, client);
      return c.body(null, 200);
    } catch (err) {
      return oauthError(c, err);
    }
  });

  app.post('/oauth/logout', (c) => {
    ctx.sessions.revoke(getCookie(c, UI_SESSIONS.oauth.cookie));
    deleteCookie(c, UI_SESSIONS.oauth.cookie, { path: UI_SESSIONS.oauth.path });
    return c.redirect('/oauth/authorize', 303);
  });
}
