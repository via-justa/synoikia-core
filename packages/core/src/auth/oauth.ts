import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import type { AccessCeiling } from '../gate/access.js';
import { writeAudit } from '../audit.js';
import type { Db } from '../db/index.js';
import { oauthClients, oauthCodes, oauthGrants, oauthTokens, users } from '../db/schema.js';
import { NotFoundError, ServiceError } from '../errors.js';
import { randomToken, safeEqual, sha256 } from './tokens.js';

/** Built-in OAuth 2.1 server (design §6.2): DCR, code + PKCE S256, resource indicators binding tokens to
 * endpoints, short opaque access tokens, rotating refresh tokens with reuse detection; secrets hashed. */

export const ACCESS_PREFIX = 'syno_';
const REFRESH_PREFIX = 'synr_';
const CODE_TTL_MS = 60_000;

/** OAuth protocol errors carry RFC 6749 codes (`invalid_grant`, …) and map to 400/401. */
export class OAuthError extends ServiceError {
  constructor(
    code: string,
    message: string,
    readonly httpStatus: 400 | 401 = 400,
  ) {
    super(400, code, message);
  }
}

/** https, loopback http (native apps, RFC 8252) and private-use schemes; never javascript:/data:/file:. */
function isAcceptableRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:'].includes(url.protocol)) return false;
  return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/.test(url.protocol) || /^[a-z][a-z0-9+.-]{2,}:$/.test(url.protocol);
}

const RegistrationSchema = z.object({
  redirect_uris: z.array(z.string()).min(1).max(10),
  client_name: z.string().trim().min(1).max(100).optional(),
  token_endpoint_auth_method: z.enum(['none', 'client_secret_post', 'client_secret_basic']).default('none'),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return safeEqual(createHash('sha256').update(verifier).digest('base64url'), challenge);
}

export const canonicalResource = (url: string) => url.replace(/\/+$/, '');

type ClientRow = typeof oauthClients.$inferSelect;

export interface TokenPair {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export class OAuthService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ── clients ──

  register(raw: unknown, via: 'dcr' | 'admin', actor: { userId?: string } = {}) {
    const input = RegistrationSchema.safeParse(raw);
    if (!input.success)
      throw new OAuthError('invalid_client_metadata', input.error.issues.map((i) => i.message).join('; '));
    const bad = input.data.redirect_uris.filter((u) => !isAcceptableRedirectUri(u));
    if (bad.length) throw new OAuthError('invalid_redirect_uri', `Unacceptable redirect URI(s): ${bad.join(', ')}`);
    if (input.data.grant_types?.some((g) => !['authorization_code', 'refresh_token'].includes(g))) {
      throw new OAuthError('invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported');
    }
    const confidential = input.data.token_endpoint_auth_method !== 'none';
    const clientId = `mcp_${randomToken(16)}`;
    const clientSecret = confidential ? randomToken(32) : undefined;
    const row = {
      id: randomUUID(),
      clientId,
      clientSecretHash: clientSecret ? sha256(clientSecret) : null,
      name: input.data.client_name ?? 'Unnamed MCP client',
      redirectUris: input.data.redirect_uris,
      registeredVia: via,
      createdAt: this.now(),
    };
    this.db.transaction((tx) => {
      tx.insert(oauthClients).values(row).run();
      writeAudit(tx, {
        kind: 'auth',
        decision: 'oauth_client_registered',
        actorKind: actor.userId ? 'user' : 'system',
        actorId: actor.userId,
        detail: { clientId, name: row.name, redirectUris: row.redirectUris, via },
      });
    });
    return {
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
      client_name: row.name,
      redirect_uris: row.redirectUris,
      token_endpoint_auth_method: input.data.token_endpoint_auth_method,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  client(clientId: string): ClientRow | undefined {
    const row = this.db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).get();
    return row && !row.revokedAt ? row : undefined;
  }

  listClients() {
    return this.db
      .select()
      .from(oauthClients)
      .orderBy(asc(oauthClients.createdAt))
      .all()
      .map(({ clientSecretHash, ...c }) => ({ ...c, confidential: !!clientSecretHash }));
  }

  revokeClient(id: string, actor: { userId?: string } = {}) {
    const row = this.db.select().from(oauthClients).where(eq(oauthClients.id, id)).get();
    if (!row) throw new NotFoundError('client_not_found', 'No such client');
    const now = this.now();
    this.db.transaction((tx) => {
      tx.update(oauthClients).set({ revokedAt: now }).where(eq(oauthClients.id, id)).run();
      const grantIds = tx
        .select({ id: oauthGrants.id })
        .from(oauthGrants)
        .where(eq(oauthGrants.clientId, id))
        .all()
        .map((g) => g.id);
      if (grantIds.length) {
        tx.update(oauthGrants).set({ revokedAt: now }).where(inArray(oauthGrants.id, grantIds)).run();
        tx.update(oauthTokens).set({ revokedAt: now }).where(inArray(oauthTokens.grantId, grantIds)).run();
      }
      writeAudit(tx, {
        kind: 'auth',
        decision: 'oauth_client_revoked',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { clientId: row.clientId, name: row.name },
      });
    });
  }

  /** Confidential clients must present their secret; public clients must not claim to have one. */
  authenticateClient(clientId: string | undefined, clientSecret: string | undefined): ClientRow {
    const client = clientId ? this.client(clientId) : undefined;
    if (!client) throw new OAuthError('invalid_client', 'Unknown client', 401);
    if (client.clientSecretHash) {
      if (!clientSecret || !safeEqual(sha256(clientSecret), client.clientSecretHash))
        throw new OAuthError('invalid_client', 'Client authentication failed', 401);
    }
    return client;
  }

  // ── grants & codes ──

  listGrants(userId?: string) {
    return this.db
      .select({ grant: oauthGrants, client: oauthClients, user: users })
      .from(oauthGrants)
      .innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
      .innerJoin(users, eq(oauthGrants.userId, users.id))
      .where(userId ? eq(oauthGrants.userId, userId) : undefined)
      .orderBy(asc(oauthGrants.createdAt))
      .all()
      .map(({ grant, client, user }) => ({
        ...grant,
        client: { id: client.id, clientId: client.clientId, name: client.name },
        user: { id: user.id, username: user.username },
      }));
  }

  revokeGrant(id: string, actor: { userId?: string } = {}) {
    const now = this.now();
    this.db.transaction((tx) => {
      const changed = tx.update(oauthGrants).set({ revokedAt: now }).where(eq(oauthGrants.id, id)).run().changes;
      if (!changed) throw new NotFoundError('grant_not_found', 'No such grant');
      tx.update(oauthTokens).set({ revokedAt: now }).where(eq(oauthTokens.grantId, id)).run();
      writeAudit(tx, {
        kind: 'auth',
        decision: 'oauth_grant_revoked',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { grantId: id },
      });
    });
  }

  /** Revokes a grant of the user; any other answers 404, as if it didn't exist. */
  revokeOwnGrant(id: string, userId: string) {
    if (!this.listGrants(userId).some((g) => g.id === id)) throw new NotFoundError('grant_not_found', 'No such grant');
    this.revokeGrant(id, { userId });
  }

  /** Password changed or user disabled: revoke every live grant and its tokens; re-enabling revives nothing. */
  revokeUserGrants(userId: string, reason: 'password_changed' | 'user_disabled', actor: { userId?: string } = {}) {
    const now = this.now();
    return this.db.transaction((tx) => {
      const live = tx
        .select({ id: oauthGrants.id })
        .from(oauthGrants)
        .where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)))
        .all()
        .map((g) => g.id);
      if (!live.length) return 0;
      tx.update(oauthGrants).set({ revokedAt: now }).where(inArray(oauthGrants.id, live)).run();
      tx.update(oauthTokens).set({ revokedAt: now }).where(inArray(oauthTokens.grantId, live)).run();
      writeAudit(tx, {
        kind: 'auth',
        decision: 'oauth_grants_revoked',
        actorKind: actor.userId ? 'user' : 'system',
        actorId: actor.userId,
        detail: { userId, reason, grants: live.length },
      });
      return live.length;
    });
  }

  /** After consent: records the grant and returns a single-use code bound to PKCE, redirect and resources. */
  issueCode(input: {
    client: ClientRow;
    userId: string;
    resources: string[];
    /** The instance each resource names, in the same order. */
    instanceIds: string[];
    /** Chosen on the consent page; carried by every token issued from this grant, refreshes included. */
    access: AccessCeiling;
    codeChallenge: string;
    redirectUri: string;
  }): string {
    const code = randomToken(32);
    const now = this.now();
    this.db.transaction((tx) => {
      const grantId = randomUUID();
      tx.insert(oauthGrants)
        .values({
          id: grantId,
          clientId: input.client.id,
          userId: input.userId,
          resources: input.resources,
          instanceIds: input.instanceIds,
          access: input.access,
          createdAt: now,
        })
        .run();
      tx.insert(oauthCodes)
        .values({
          codeHash: sha256(code),
          grantId,
          codeChallenge: input.codeChallenge,
          redirectUri: input.redirectUri,
          resources: input.resources,
          expiresAt: new Date(now.getTime() + CODE_TTL_MS),
        })
        .run();
      writeAudit(tx, {
        kind: 'auth',
        decision: 'oauth_consent_granted',
        actorKind: 'user',
        actorId: input.userId,
        detail: {
          clientId: input.client.clientId,
          name: input.client.name,
          resources: input.resources,
          access: input.access,
        },
      });
    });
    return code;
  }

  private issueTokens(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    grantId: string,
    resources: string[],
    familyId: string,
    ttl: { accessMs: number; refreshMs: number },
  ): TokenPair {
    const now = this.now().getTime();
    const access = `${ACCESS_PREFIX}${randomToken(32)}`;
    const refresh = `${REFRESH_PREFIX}${randomToken(32)}`;
    tx.insert(oauthTokens)
      .values([
        {
          tokenHash: sha256(access),
          grantId,
          kind: 'access',
          familyId,
          resources,
          expiresAt: new Date(now + ttl.accessMs),
        },
        {
          tokenHash: sha256(refresh),
          grantId,
          kind: 'refresh',
          familyId,
          resources,
          expiresAt: new Date(now + ttl.refreshMs),
        },
      ])
      .run();
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: Math.floor(ttl.accessMs / 1000),
      refresh_token: refresh,
      scope: 'mcp',
    };
  }

  private revokeFamily(tx: Parameters<Parameters<Db['transaction']>[0]>[0], familyId: string) {
    tx.update(oauthTokens)
      .set({ revokedAt: this.now() })
      .where(and(eq(oauthTokens.familyId, familyId), isNull(oauthTokens.revokedAt)))
      .run();
  }

  /** `authorization_code` grant. A replayed code revokes everything issued from it (OAuth 2.1 §4.1.2). */
  exchangeCode(input: {
    client: ClientRow;
    code: string;
    redirectUri: string;
    codeVerifier: string;
    resource?: string[];
    ttl: { accessMs: number; refreshMs: number };
  }): TokenPair {
    // Security-relevant state changes (marking the code used, revoking on replay) must commit even
    // when the request fails, so failures are returned from the transaction and thrown afterwards.
    const outcome = this.db.transaction((tx): TokenPair | OAuthError => {
      const row = tx
        .select()
        .from(oauthCodes)
        .where(eq(oauthCodes.codeHash, sha256(input.code)))
        .get();
      const grant = row && tx.select().from(oauthGrants).where(eq(oauthGrants.id, row.grantId)).get();
      if (!row || !grant || grant.clientId !== input.client.id)
        return new OAuthError('invalid_grant', 'Invalid authorization code');
      if (row.usedAt) {
        tx.update(oauthTokens).set({ revokedAt: this.now() }).where(eq(oauthTokens.grantId, grant.id)).run();
        tx.update(oauthGrants).set({ revokedAt: this.now() }).where(eq(oauthGrants.id, grant.id)).run();
        writeAudit(tx, {
          kind: 'auth',
          decision: 'oauth_code_replayed',
          actorKind: 'system',
          detail: { clientId: input.client.clientId },
        });
        return new OAuthError('invalid_grant', 'Authorization code already used');
      }
      tx.update(oauthCodes).set({ usedAt: this.now() }).where(eq(oauthCodes.codeHash, row.codeHash)).run();
      if (row.expiresAt.getTime() <= this.now().getTime() || grant.revokedAt)
        return new OAuthError('invalid_grant', 'Authorization code expired');
      if (row.redirectUri !== input.redirectUri) return new OAuthError('invalid_grant', 'redirect_uri does not match');
      if (!verifyPkceS256(input.codeVerifier, row.codeChallenge))
        return new OAuthError('invalid_grant', 'PKCE verification failed');
      const resources = input.resource?.length ? input.resource.map(canonicalResource) : row.resources;
      if (!resources.every((r) => row.resources.includes(r)))
        return new OAuthError('invalid_target', 'Requested resource was not granted');
      return this.issueTokens(tx, grant.id, resources, randomUUID(), input.ttl);
    });
    if (outcome instanceof OAuthError) throw outcome;
    return outcome;
  }

  /** `refresh_token` grant with rotation; presenting an already-rotated token revokes the family. */
  refresh(input: {
    client: ClientRow;
    refreshToken: string;
    resource?: string[];
    ttl: { accessMs: number; refreshMs: number };
  }): TokenPair {
    const outcome = this.db.transaction((tx): TokenPair | OAuthError => {
      const row = tx
        .select()
        .from(oauthTokens)
        .where(and(eq(oauthTokens.tokenHash, sha256(input.refreshToken)), eq(oauthTokens.kind, 'refresh')))
        .get();
      const grant = row && tx.select().from(oauthGrants).where(eq(oauthGrants.id, row.grantId)).get();
      if (!row || !grant || grant.clientId !== input.client.id)
        return new OAuthError('invalid_grant', 'Invalid refresh token');
      const owner = tx.select({ disabled: users.disabled }).from(users).where(eq(users.id, grant.userId)).get();
      if (!owner || owner.disabled) return new OAuthError('invalid_grant', 'The user of this grant is disabled');
      if (row.revokedAt) {
        this.revokeFamily(tx, row.familyId);
        writeAudit(tx, {
          kind: 'auth',
          decision: 'oauth_refresh_reuse',
          actorKind: 'system',
          detail: { clientId: input.client.clientId, familyId: row.familyId },
        });
        return new OAuthError('invalid_grant', 'Refresh token was already used');
      }
      if (grant.revokedAt || row.expiresAt.getTime() <= this.now().getTime())
        return new OAuthError('invalid_grant', 'Refresh token expired or revoked');
      const resources = input.resource?.length ? input.resource.map(canonicalResource) : row.resources;
      if (!resources.every((r) => grant.resources.includes(r)))
        return new OAuthError('invalid_target', 'Requested resource was not granted');
      tx.update(oauthTokens).set({ revokedAt: this.now() }).where(eq(oauthTokens.tokenHash, row.tokenHash)).run();
      return this.issueTokens(tx, grant.id, resources, row.familyId, input.ttl);
    });
    if (outcome instanceof OAuthError) throw outcome;
    return outcome;
  }

  /** RFC 7009. Unknown tokens are not an error. Revoking a refresh token revokes its family. */
  revokeToken(token: string, client: ClientRow) {
    this.db.transaction((tx) => {
      const row = tx
        .select()
        .from(oauthTokens)
        .where(eq(oauthTokens.tokenHash, sha256(token)))
        .get();
      const grant = row && tx.select().from(oauthGrants).where(eq(oauthGrants.id, row.grantId)).get();
      if (!row || grant?.clientId !== client.id) return;
      if (row.kind === 'refresh') this.revokeFamily(tx, row.familyId);
      else tx.update(oauthTokens).set({ revokedAt: this.now() }).where(eq(oauthTokens.tokenHash, row.tokenHash)).run();
    });
  }

  /** Validates an access token for one instance, by the instance ids recorded at consent, not slugs. */
  verifyAccess(token: string, instanceId: string) {
    if (!token.startsWith(ACCESS_PREFIX)) return null;
    const found = this.db
      .select({ token: oauthTokens, grant: oauthGrants, client: oauthClients, user: users })
      .from(oauthTokens)
      .innerJoin(oauthGrants, eq(oauthTokens.grantId, oauthGrants.id))
      .innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
      .innerJoin(users, eq(oauthGrants.userId, users.id))
      .where(and(eq(oauthTokens.tokenHash, sha256(token)), eq(oauthTokens.kind, 'access')))
      .get();
    if (!found) return null;
    const { token: t, grant, client, user } = found;
    if (t.revokedAt || grant.revokedAt || client.revokedAt || user.disabled) return null;
    if (t.expiresAt.getTime() <= this.now().getTime()) return null;
    const ids = grant.instanceIds ?? [];
    const granted = t.resources.map((r) => ids[grant.resources.indexOf(r)]).filter((id) => id !== undefined);
    return {
      inAudience: granted.includes(instanceId),
      client,
      user,
      grantId: grant.id,
      access: grant.access,
    };
  }

  /** The grant, its client and user are still live and the grant covers the instance (design §5.6). */
  grantLiveFor(grantId: string, instanceId: string): boolean {
    const found = this.db
      .select({ grant: oauthGrants, client: oauthClients, user: users })
      .from(oauthGrants)
      .innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
      .innerJoin(users, eq(oauthGrants.userId, users.id))
      .where(eq(oauthGrants.id, grantId))
      .get();
    if (!found || found.grant.revokedAt || found.client.revokedAt || found.user.disabled) return false;
    return (found.grant.instanceIds ?? []).includes(instanceId);
  }

  /** An instance was deleted: grants left with no other instance are revoked with their tokens. */
  forgetInstance(instanceId: string) {
    const now = this.now();
    this.db.transaction((tx) => {
      for (const g of tx.select().from(oauthGrants).where(isNull(oauthGrants.revokedAt)).all()) {
        if (!g.instanceIds?.includes(instanceId)) continue;
        if (g.instanceIds.some((id) => id !== instanceId)) continue;
        tx.update(oauthGrants).set({ revokedAt: now }).where(eq(oauthGrants.id, g.id)).run();
        tx.update(oauthTokens).set({ revokedAt: now }).where(eq(oauthTokens.grantId, g.id)).run();
      }
    });
  }

  /** One-time upgrade for grants from before `instance_ids`: map each resource's slug to its instance now. */
  backfillInstanceIds(instances: { id: string; slug: string }[]): number {
    const bySlug = new Map(instances.map((i) => [i.slug, i.id]));
    let n = 0;
    for (const g of this.db.select().from(oauthGrants).where(isNull(oauthGrants.instanceIds)).all()) {
      // The slug is the last path segment: PUBLIC_MCP_URL may carry a path (`https://host/mcp/<slug>`).
      const slugOf = (r: string) => new URL(r).pathname.split('/').filter(Boolean).at(-1) ?? '';
      const ids = g.resources.map((r) => bySlug.get(slugOf(r)) ?? '');
      this.db.update(oauthGrants).set({ instanceIds: ids }).where(eq(oauthGrants.id, g.id)).run();
      n++;
    }
    return n;
  }

  purgeExpired(): number {
    const now = this.now();
    const a = this.db
      .delete(oauthCodes)
      .where(or(lt(oauthCodes.expiresAt, new Date(now.getTime() - 3600_000))))
      .run().changes;
    const b = this.db
      .delete(oauthTokens)
      .where(lt(oauthTokens.expiresAt, new Date(now.getTime() - 24 * 3600_000)))
      .run().changes;
    return a + b;
  }
}
