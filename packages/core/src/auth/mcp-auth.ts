import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { AppContext } from '../app.js';
import { roleHasInstance } from '../catalog/role-levels.js';
import { users } from '../db/schema.js';
import { ConflictError, ValidationError } from '../errors.js';
import { getSettings } from '../settings.js';
import { McpTokenService, TOKEN_PREFIX } from './mcp-tokens.js';
import { ACCESS_PREFIX, canonicalResource } from './oauth.js';
import type { OAuthService } from './oauth.js';
import type { AccessCeiling } from '../gate/access.js';
import type { AuthMode } from '../instances/manager.js';
import { requestOrigin } from '../http/common.js';

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
  /** The user who owns the credential, or whom the proxy named; their role decides the reach (§6.4). */
  userId: string;
  roleId: string;
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

type Unowned = Omit<McpIdentity, 'userId' | 'roleId'>;

const refuse = (status: 401 | 403, error: string, message: string, detail: string): McpAuthResult => ({
  ok: false,
  status,
  error,
  message,
  detail,
});

/** The credential's owner must be enabled and their role must have this endpoint (design §6.4). */
function owned(ctx: AppContext, base: Unowned, userId: string | null | undefined, instanceId: string): McpAuthResult {
  const user = userId ? ctx.db.select().from(users).where(eq(users.id, userId)).get() : undefined;
  if (!user || user.disabled)
    return refuse(403, 'forbidden', 'The account behind this credential is disabled', `${base.label}: no enabled owner`);
  if (!roleHasInstance(ctx.db, user.roleId, instanceId))
    return refuse(
      403,
      'insufficient_scope',
      'This endpoint is not available to your role',
      `${base.label}: role of ${user.username} does not include this endpoint`,
    );
  return { ok: true, identity: { ...base, userId: user.id, roleId: user.roleId } };
}

/** A user named by the proxy: matched by username, else registered with the default role (design §6.5). */
async function externalUser(ctx: AppContext, name: string): Promise<string | undefined> {
  const found = ctx.users.byUsernameInsensitive(name);
  if (found) return found.id;
  if (!ctx.users.registrationOpen()) return undefined;
  try {
    return (await ctx.users.register({ username: name }, 'external')).id;
  } catch (err) {
    // A concurrent first request registered it; a name that isn't a valid username stays unknown.
    if (err instanceof ConflictError) return ctx.users.byUsernameInsensitive(name)?.id;
    if (err instanceof ValidationError) return undefined;
    throw err;
  }
}

/** The owner is still enabled, in the same role, and the role still has the endpoint (parked runs). */
export function ownerLive(ctx: AppContext, identity: McpIdentity, instanceId: string): boolean {
  const user = ctx.db.select().from(users).where(eq(users.id, identity.userId)).get();
  return (
    !!user && !user.disabled && user.roleId === identity.roleId && roleHasInstance(ctx.db, user.roleId, instanceId)
  );
}

/** Whether the credential behind a principal still reaches the instance; external identities have no
 * credential to revoke. A parked execution checks this on each call (design §5.6). */
export function principalLive(ctx: AppContext, principal: string, instanceId: string): boolean {
  if (principal.startsWith('token:')) return ctx.tokens.liveFor(principal.slice('token:'.length), instanceId);
  if (principal.startsWith('grant:')) return ctx.oauth.grantLiveFor(principal.slice('grant:'.length), instanceId);
  return true;
}

const unknownUser = (base: Unowned) =>
  refuse(
    403,
    'forbidden',
    'No account matches this identity',
    `${base.label}: no user has that username and self-registration is off or the name is not a valid username`,
  );

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
      const base: Unowned = { kind: 'external', principal: `cf:${who}`, label: `external:${who}`, access: 'write' };
      const userId = await externalUser(ctx, who);
      if (!userId) return unknownUser(base);
      return owned(ctx, base, userId, instance.id);
    }
    const header = settings.trustedIdentityHeader;
    const named = header && c.req.header(header)?.trim().slice(0, 200);
    if (named) {
      const base: Unowned = { kind: 'external', principal: `ext:${named}`, label: `external:${named}`, access: 'write' };
      const userId = await externalUser(ctx, named);
      if (!userId) return unknownUser(base);
      return owned(ctx, base, userId, instance.id);
    }
    // Every call belongs to a user (design §6.4): a caller the proxy didn't name is refused.
    return refuse(
      401,
      'unauthorized',
      'The proxy did not identify the caller',
      header
        ? `no ${header} header and no Cloudflare Access assertion: anonymous callers are refused`
        : 'external mode without Cloudflare Access or a trusted identity header: anonymous callers are refused',
    );
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
    return owned(
      ctx,
      { kind: 'token', principal: `token:${row.id}`, label: `token:${row.name}`, access: row.access },
      row.createdBy,
      instance.id,
    );
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
    return owned(
      ctx,
      {
        kind: 'oauth',
        principal: `grant:${found.grantId}`,
        label: `oauth:${found.client.name} (${found.user.username})`,
        access: found.access,
      },
      found.user.id,
      instance.id,
    );
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
