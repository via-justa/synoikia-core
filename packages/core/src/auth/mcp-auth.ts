import type { Context } from 'hono';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { AppContext } from '../app.js';
import { getSettings } from '../settings.js';
import { McpTokenService, TOKEN_PREFIX } from './mcp-tokens.js';
import { ACCESS_PREFIX, canonicalResource } from './oauth.js';
import type { OAuthService } from './oauth.js';
import type { AccessCeiling } from '../gate/access.js';
import type { AuthMode } from '../instances/manager.js';
import { clientIp, requestOrigin } from '../http/common.js';

/** Authentication for `/{slug}` (design §6.2): the instance's mode or the global default; every accepted
 * request yields an identity recorded on each audited call. */

export interface McpIdentity {
  kind: 'token' | 'oauth' | 'external';
  /** Stable principal for session binding: a token id, `grant:<id>`, or the external identity. */
  principal: string;
  /** Human-readable, shown in audit and approvals: `token:Claude Code`, `oauth:Claude for admin`. */
  label: string;
  /** Ceiling on what this principal can reach (design §6.3): from OAuth consent or the bearer token;
   * `external` mode is not limited here. */
  access: AccessCeiling;
}

export type McpAuthResult =
  | { ok: true; identity: McpIdentity }
  | {
      ok: false;
      status: 401 | 403;
      error: string;
      message: string;
      wwwAuthenticate?: string;
      /** Why, in enough detail to fix a client or proxy. For the server log only, never the client. */
      detail: string;
    };

/** The MCP listener's public origin: PUBLIC_MCP_URL, or the request's origin where no security decision
 * depends on it (the approval link back to the same client, sign-in redirects). */
export function publicMcpBase(ctx: AppContext, c: Context): string {
  return (ctx.config.PUBLIC_MCP_URL ?? requestOrigin(c, ctx.config.TRUST_PROXY)).replace(/\/+$/, '');
}

export const resourceUrl = (base: string, slug: string) => canonicalResource(`${base}/${slug}`);

export function effectiveAuthMode(ctx: AppContext, instanceAuthMode: string | null): AuthMode {
  return (instanceAuthMode as AuthMode | null) ?? getSettings(ctx.db, 'mcp').defaultAuthMode;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const MAX_CLAIM = 120;
const clip = (v: string) => (v.length > MAX_CLAIM ? `${v.slice(0, MAX_CLAIM)}…` : v);

/** A JWT's claimed issuer and audience, unverified, only to explain a rejection: strings only, clipped. */
function claimedIssuer(token: string): { iss?: string; aud?: string } | null {
  let payload: Record<string, unknown>;
  try {
    payload = decodeJwt(token);
  } catch {
    return null;
  }
  const { iss, aud } = payload;
  const auds = (Array.isArray(aud) ? aud : [aud]).filter((a): a is string => typeof a === 'string');
  return {
    iss: typeof iss === 'string' ? clip(iss) : undefined,
    aud: auds.length ? clip(auds.join(',')) : undefined,
  };
}

/** Verifies a `Cf-Access-Jwt-Assertion` (signature, issuer, audience, expiry) and returns who it names
 * or why it was rejected. `keys` replaces the team's key set (tests). */
export async function checkCloudflareAccess(
  teamDomain: string,
  aud: string,
  assertion: string,
  keys?: JWTVerifyGetKey,
): Promise<{ ok: true; who: string } | { ok: false; reason: string }> {
  const domain = teamDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  let jwks = keys ?? jwksCache.get(domain);
  if (!jwks) {
    const remote = createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`));
    jwksCache.set(domain, remote);
    jwks = remote;
  }
  const issuer = `https://${domain}`;
  try {
    const { payload } = await jwtVerify(assertion, jwks, { issuer, audience: aud });
    // A service token's assertion has an empty `sub` and names the token's client ID in `common_name`.
    // An email must contain `@`, so it can't pose as a service token; one that names nobody is refused.
    const named = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const email = named(payload.email);
    const service = named(payload.common_name);
    const who = (email?.includes('@') ? email : undefined) ?? (service && `service:${service}`) ?? named(payload.sub);
    return who
      ? { ok: true, who }
      : { ok: false, reason: 'valid assertion that names nobody (no email, common_name or sub)' };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    const claimed = claimedIssuer(assertion);
    if (!claimed) return { ok: false, reason: `${why} (not a JWT)` };
    // The AUD tag and team domain are not secrets: every assertion Access issues carries them.
    return {
      ok: false,
      reason: `${why} (assertion iss=${claimed.iss ?? '-'} aud=${claimed.aud ?? '-'}; expected iss=${issuer} aud=${aud})`,
    };
  }
}

/** {@link checkCloudflareAccess}, returning who the assertion names, or null. */
export async function verifyCloudflareAccess(
  teamDomain: string,
  aud: string,
  assertion: string,
  keys?: JWTVerifyGetKey,
): Promise<string | null> {
  const result = await checkCloudflareAccess(teamDomain, aud, assertion, keys);
  return result.ok ? result.who : null;
}

/** What kind of bearer token this is, for the log: never any part of its value. */
function describeToken(token: string): string {
  if (token.startsWith(TOKEN_PREFIX)) return 'a Synoikia bearer token';
  if (token.startsWith(ACCESS_PREFIX)) return 'a Synoikia OAuth access token';
  const claimed = claimedIssuer(token);
  if (claimed) return `a JWT from another issuer (iss=${claimed.iss ?? '-'})`;
  return 'a token this server did not issue';
}

export async function authenticateMcp(
  ctx: AppContext,
  oauth: OAuthService,
  c: Context,
  instance: { id: string; slug: string; authMode: string | null },
): Promise<McpAuthResult> {
  const mode = effectiveAuthMode(ctx, instance.authMode);
  const settings = getSettings(ctx.db, 'mcp');

  if (mode === 'external') {
    const { teamDomain, aud } = settings.cfAccess;
    if (teamDomain && aud) {
      const assertion = c.req.header('cf-access-jwt-assertion');
      const checked = assertion ? await checkCloudflareAccess(teamDomain, aud, assertion) : null;
      if (!checked?.ok)
        return {
          ok: false,
          status: 401,
          error: 'unauthorized',
          message: 'Cloudflare Access assertion missing or invalid',
          detail: checked
            ? `Cloudflare Access assertion rejected: ${checked.reason}`
            : 'no Cf-Access-Jwt-Assertion header: the request did not come through the Cloudflare Access application',
        };
      const who = checked.who;
      return {
        ok: true,
        identity: { kind: 'external', principal: `cf:${who}`, label: `external:${who}`, access: 'write' },
      };
    }
    const header = settings.trustedIdentityHeader;
    const named = header && c.req.header(header)?.trim().slice(0, 200);
    if (named)
      return {
        ok: true,
        identity: { kind: 'external', principal: `ext:${named}`, label: `external:${named}`, access: 'write' },
      };
    // Anonymous: without an identity, the client address is what keeps callers' sessions (and rate
    // budgets) apart; otherwise every anonymous client would share one principal.
    const ip = clientIp(c, ctx.config.TRUST_PROXY) ?? 'unknown';
    return {
      ok: true,
      identity: {
        kind: 'external',
        principal: `ext-anon:${ip}`,
        label: `external (anonymous, ${ip})`,
        access: 'write',
      },
    };
  }

  const allowBearer = mode === 'bearer' || mode === 'bearer+oauth';
  // OAuth is off until PUBLIC_MCP_URL is set: its discovery documents must not come from the Host header.
  const allowOauth = (mode === 'oauth' || mode === 'bearer+oauth') && !!ctx.config.PUBLIC_MCP_URL;
  const base = publicMcpBase(ctx, c);
  const challenge = (error?: string) => {
    const params: string[] = [];
    if (allowOauth) params.push(`resource_metadata="${base}/.well-known/oauth-protected-resource/${instance.slug}"`);
    if (error) params.push(`error="${error}"`);
    return params.length ? `Bearer ${params.join(', ')}` : 'Bearer';
  };

  // A proxy that authenticated the caller is the usual reason a client sends what this mode can't use.
  const hint = c.req.header('cf-access-jwt-assertion')
    ? '; the request carries a Cloudflare Access assertion: set the endpoint to External auth to accept it'
    : '';
  const oauthOff =
    (mode === 'oauth' || mode === 'bearer+oauth') && !allowOauth ? '; OAuth is off until PUBLIC_MCP_URL is set' : '';

  const auth = c.req.header('authorization');
  const token = auth?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token)
    return {
      ok: false,
      status: 401,
      error: 'unauthorized',
      message: 'Authentication required',
      wwwAuthenticate: challenge(),
      detail: `${auth ? 'Authorization header is not a bearer token' : 'no Authorization header'}${oauthOff}${hint}`,
    };

  if (allowBearer && token.startsWith(TOKEN_PREFIX)) {
    const row = ctx.tokens.verify(token);
    if (!row)
      return {
        ok: false,
        status: 401,
        error: 'invalid_token',
        message: 'Invalid or expired token',
        wwwAuthenticate: challenge('invalid_token'),
        detail: 'bearer token is unknown, revoked or expired',
      };
    if (!McpTokenService.inScope(row, instance.id)) {
      return {
        ok: false,
        status: 403,
        error: 'insufficient_scope',
        message: 'This token is not valid for this endpoint',
        detail: `bearer token "${row.name}" is not scoped to this endpoint`,
      };
    }
    return {
      ok: true,
      identity: { kind: 'token', principal: `token:${row.id}`, label: `token:${row.name}`, access: row.access },
    };
  }

  if (allowOauth && token.startsWith(ACCESS_PREFIX)) {
    const found = oauth.verifyAccess(token, instance.id);
    if (!found)
      return {
        ok: false,
        status: 401,
        error: 'invalid_token',
        message: 'Invalid or expired token',
        wwwAuthenticate: challenge('invalid_token'),
        detail: 'OAuth access token is unknown, revoked or expired',
      };
    if (!found.inAudience) {
      return {
        ok: false,
        status: 403,
        error: 'insufficient_scope',
        message: 'This token was not granted for this endpoint',
        detail: `OAuth grant of client "${found.client.name}" does not include this endpoint`,
      };
    }
    return {
      ok: true,
      identity: {
        kind: 'oauth',
        principal: `grant:${found.grantId}`,
        label: `oauth:${found.client.name} (${found.user.username})`,
        access: found.access,
      },
    };
  }

  return {
    ok: false,
    status: 401,
    error: 'invalid_token',
    message: 'This endpoint does not accept that kind of token',
    wwwAuthenticate: challenge('invalid_token'),
    detail: `got ${describeToken(token)}, which ${mode} auth does not accept${oauthOff}${hint}`,
  };
}
