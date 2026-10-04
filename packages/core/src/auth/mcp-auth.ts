import type { Context } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { AppContext } from '../app.js';
import { getSettings } from '../settings.js';
import { McpTokenService, TOKEN_PREFIX } from './mcp-tokens.js';
import { ACCESS_PREFIX, canonicalResource } from './oauth.js';
import type { OAuthService } from './oauth.js';
import type { AccessCeiling } from '../gate/access.js';
import type { AuthMode } from '../instances/manager.js';
import { clientIp, requestOrigin } from '../http/common.js';

/**
 * Authentication for `/{slug}` (design §6.2). The mode is the instance override or the global
 * default. Every accepted request yields an identity that is recorded on each audited call.
 */

export interface McpIdentity {
  kind: 'token' | 'oauth' | 'external';
  /** Stable principal for session binding: a token id, `grant:<id>`, or the external identity. */
  principal: string;
  /** Human-readable, shown in audit and approvals: `token:Claude Code`, `oauth:Claude for admin`. */
  label: string;
  /**
   * Ceiling on what this principal can reach (design §6.3): chosen on the consent page for OAuth,
   * set per bearer token. `external` mode trusts the fronting proxy, so it is not limited here.
   */
  access: AccessCeiling;
}

export type McpAuthResult =
  | { ok: true; identity: McpIdentity }
  | { ok: false; status: 401 | 403; error: string; message: string; wwwAuthenticate?: string };

/**
 * The MCP listener's public origin: PUBLIC_MCP_URL, or — only where no security decision depends on
 * it (the approval-page link sent back to the same client, sign-in redirects) — the request's origin.
 */
export function publicMcpBase(ctx: AppContext, c: Context): string {
  return (ctx.config.PUBLIC_MCP_URL ?? requestOrigin(c, ctx.config.TRUST_PROXY)).replace(/\/+$/, '');
}

export const resourceUrl = (base: string, slug: string) => canonicalResource(`${base}/${slug}`);

export function effectiveAuthMode(ctx: AppContext, instanceAuthMode: string | null): AuthMode {
  return (instanceAuthMode as AuthMode | null) ?? getSettings(ctx.db, 'mcp').defaultAuthMode;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Verifies a `Cf-Access-Jwt-Assertion` against the team's signing keys: signature, issuer (the team
 * domain), audience (the Access application's AUD tag) and expiry. Returns who it names, or null.
 * `keys` replaces the team's published key set (tests).
 */
export async function verifyCloudflareAccess(
  teamDomain: string,
  aud: string,
  assertion: string,
  keys?: JWTVerifyGetKey,
): Promise<string | null> {
  const domain = teamDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  let jwks = keys ?? jwksCache.get(domain);
  if (!jwks) {
    const remote = createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`));
    jwksCache.set(domain, remote);
    jwks = remote;
  }
  try {
    const { payload } = await jwtVerify(assertion, jwks, { issuer: `https://${domain}`, audience: aud });
    // A service token's assertion has an empty `sub` and names the token's client ID in `common_name`.
    // An email must contain `@`, so it can't pose as a service token; one that names nobody is refused.
    const named = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const email = named(payload.email);
    const service = named(payload.common_name);
    return (
      (email?.includes('@') ? email : undefined) ?? (service && `service:${service}`) ?? named(payload.sub) ?? null
    );
  } catch {
    return null;
  }
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
      const who = assertion ? await verifyCloudflareAccess(teamDomain, aud, assertion) : null;
      if (!who)
        return {
          ok: false,
          status: 401,
          error: 'unauthorized',
          message: 'Cloudflare Access assertion missing or invalid',
        };
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

  const auth = c.req.header('authorization');
  const token = auth?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token)
    return {
      ok: false,
      status: 401,
      error: 'unauthorized',
      message: 'Authentication required',
      wwwAuthenticate: challenge(),
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
      };
    if (!McpTokenService.inScope(row, instance.id)) {
      return {
        ok: false,
        status: 403,
        error: 'insufficient_scope',
        message: 'This token is not valid for this endpoint',
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
      };
    if (!found.inAudience) {
      return {
        ok: false,
        status: 403,
        error: 'insufficient_scope',
        message: 'This token was not granted for this endpoint',
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
  };
}
