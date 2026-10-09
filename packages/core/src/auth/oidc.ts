import * as oidc from 'openid-client';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { aad } from '../crypto/index.js';
import type { SecretBox } from '../crypto/index.js';
import type { Db } from '../db/index.js';
import { oidcConfig } from '../db/schema.js';
import { ServiceError, ValidationError } from '../errors.js';
import { signPayload, verifyPayload } from './tokens.js';
import type { UserRow, UserService } from './users.js';

/** Optional OIDC sign-in (design §6.1): code + PKCE, state and nonce; the identity must pass the allow
 * policy and be linked unless auto-provisioning. Used by the admin and MCP-port logins. */

const AllowPolicySchema = z
  .object({
    emails: z.array(z.string().email()).default([]),
    subjects: z.array(z.string().min(1)).default([]),
    /** Required value in the groups claim (`groupsClaim`, default `groups`). */
    group: z.string().default(''),
    groupsClaim: z.string().default('groups'),
  })
  .prefault({});

const OidcSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  issuer: z.url(),
  clientId: z.string().min(1),
  scopes: z.string().default('openid email profile'),
  label: z.string().default('SSO'),
  allowPolicy: AllowPolicySchema,
  autoProvision: z.boolean().default(false),
});
export type OidcSettings = z.infer<typeof OidcSettingsSchema>;

export type OidcPurpose = 'admin_login' | 'admin_link' | 'mcp_login';

export interface OidcState extends Record<string, unknown> {
  purpose: OidcPurpose;
  verifier: string;
  state: string;
  nonce: string;
  redirectUri: string;
  returnTo?: string;
  userId?: string;
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  email?: string;
  username?: string;
  groups: string[];
}

const STATE_TTL_MS = 10 * 60_000;
const policyIsEmpty = (p: OidcSettings['allowPolicy']) => !p.emails.length && !p.subjects.length && !p.group;

class OidcError extends ServiceError {
  constructor(code: string, message: string) {
    super(400, code, message);
  }
}

export class OidcService {
  private cached?: { key: string; config: oidc.Configuration };

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly stateKey: Buffer,
    /** Allow http:// issuers (tests, lab IdPs on a trusted LAN). */
    private readonly allowInsecure = false,
  ) {}

  private row() {
    return this.db.select().from(oidcConfig).where(eq(oidcConfig.id, 1)).get();
  }

  getSettings(): (OidcSettings & { clientSecretSet: boolean }) | null {
    const row = this.row();
    if (!row) return null;
    return {
      ...OidcSettingsSchema.parse({
        enabled: row.enabled,
        issuer: row.issuer,
        clientId: row.clientId,
        scopes: row.scopes,
        allowPolicy: row.allowPolicy ?? {},
        autoProvision: row.autoProvision,
        label: (row.allowPolicy as { label?: string } | null)?.label ?? 'SSO',
      }),
      clientSecretSet: !!row.clientSecretEnc,
    };
  }

  isEnabled(): boolean {
    return this.getSettings()?.enabled === true;
  }

  /** `clientSecret`: string replaces, `null` clears, omitted keeps (write-only, never returned). */
  updateSettings(patch: Partial<OidcSettings> & { clientSecret?: string | null }, actor: { userId?: string } = {}) {
    const current = this.getSettings();
    const parsed = OidcSettingsSchema.safeParse({ ...current, ...patch });
    if (!parsed.success) {
      throw new ValidationError(
        'invalid_oidc',
        'Invalid OIDC settings',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    }
    const s = parsed.data;
    if (s.autoProvision && policyIsEmpty(s.allowPolicy)) {
      throw new ValidationError(
        'policy_required',
        'Auto-provisioning needs an allow policy (emails, subjects or a group)',
      );
    }
    let clientSecretEnc = this.row()?.clientSecretEnc ?? null;
    if (patch.clientSecret === null) clientSecretEnc = null;
    else if (patch.clientSecret)
      clientSecretEnc = this.box.encrypt(patch.clientSecret, aad('oidc_config', 'client_secret_enc', '1'));
    const values = {
      id: 1,
      issuer: s.issuer,
      clientId: s.clientId,
      clientSecretEnc,
      scopes: s.scopes,
      allowPolicy: { ...s.allowPolicy, label: s.label },
      autoProvision: s.autoProvision,
      enabled: s.enabled,
    };
    this.db.transaction((tx) => {
      tx.insert(oidcConfig).values(values).onConflictDoUpdate({ target: oidcConfig.id, set: values }).run();
      writeAudit(tx, {
        kind: 'config',
        decision: 'oidc_settings_updated',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { ...s, clientSecretChanged: patch.clientSecret !== undefined },
      });
    });
    this.cached = undefined;
    return this.getSettings();
  }

  private async configuration(): Promise<oidc.Configuration> {
    const row = this.row();
    if (!row?.enabled) throw new OidcError('oidc_disabled', 'OIDC sign-in is not enabled');
    const secret = row.clientSecretEnc
      ? this.box.decrypt(row.clientSecretEnc, aad('oidc_config', 'client_secret_enc', '1')).toString('utf8')
      : undefined;
    const key = `${row.issuer}|${row.clientId}|${secret ?? ''}`;
    if (this.cached?.key === key) return this.cached.config;
    const config = await oidc.discovery(
      new URL(row.issuer),
      row.clientId,
      secret,
      secret ? oidc.ClientSecretPost(secret) : oidc.None(),
      this.allowInsecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
    );
    this.cached = { key, config };
    return config;
  }

  /** Returns the IdP URL to redirect to and a signed state token to keep in a short-lived cookie. */
  async begin(input: { purpose: OidcPurpose; redirectUri: string; returnTo?: string; userId?: string }) {
    const config = await this.configuration();
    const settings = this.getSettings()!;
    const verifier = oidc.randomPKCECodeVerifier();
    const state: OidcState = {
      purpose: input.purpose,
      verifier,
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      redirectUri: input.redirectUri,
      returnTo: input.returnTo,
      userId: input.userId,
    };
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: input.redirectUri,
      scope: settings.scopes,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state: state.state,
      nonce: state.nonce,
    });
    return { url: url.toString(), stateToken: signPayload(this.stateKey, state, STATE_TTL_MS) };
  }

  /** Validates the callback (state, PKCE, nonce, ID token) and returns the identity plus the flow state. */
  async complete(
    callbackUrl: URL,
    stateToken: string | undefined,
  ): Promise<{ identity: OidcIdentity; state: OidcState }> {
    const state = verifyPayload<OidcState>(this.stateKey, stateToken);
    if (!state) throw new OidcError('oidc_state', 'Sign-in session expired or invalid; try again');
    const config = await this.configuration();
    let claims: oidc.IDToken | undefined;
    try {
      const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: state.verifier,
        expectedState: state.state,
        expectedNonce: state.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch (err) {
      throw new OidcError('oidc_failed', `Sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!claims) throw new OidcError('oidc_failed', 'The identity provider returned no ID token');
    const settings = this.getSettings()!;
    const rawGroups = (claims as Record<string, unknown>)[settings.allowPolicy.groupsClaim];
    const identity: OidcIdentity = {
      issuer: claims.iss,
      subject: claims.sub,
      // Only an email the IdP vouches for counts: many IdPs omit the claim or let users set any address.
      email: typeof claims.email === 'string' && claims.email_verified === true ? claims.email : undefined,
      username: typeof claims.preferred_username === 'string' ? claims.preferred_username : undefined,
      groups: Array.isArray(rawGroups) ? rawGroups.map(String) : [],
    };
    return { identity, state };
  }

  isAllowed(identity: OidcIdentity): boolean {
    const policy = this.getSettings()?.allowPolicy;
    if (!policy || policyIsEmpty(policy)) return true; // linking alone decides
    if (policy.subjects.includes(identity.subject)) return true;
    if (identity.email && policy.emails.map((e) => e.toLowerCase()).includes(identity.email.toLowerCase())) return true;
    if (policy.group && identity.groups.includes(policy.group)) return true;
    return false;
  }

  /** The local user for a sign-in (linked, or new with auto-provision); null when not allowed or linked. */
  async resolveUser(users: UserService, identity: OidcIdentity): Promise<UserRow | null> {
    if (!this.isAllowed(identity)) return null;
    const linked = users.byOidc(identity.issuer, identity.subject);
    if (linked) return linked.disabled ? null : linked;
    const settings = this.getSettings();
    // Auto-provisioning is self-registration: it needs a default role too (design §6.5).
    if (!settings?.autoProvision || policyIsEmpty(settings.allowPolicy) || !users.registrationOpen()) return null;
    const base =
      (identity.username ?? identity.email?.split('@')[0] ?? 'user').replace(/[^a-zA-Z0-9._@-]/g, '').slice(0, 48) ||
      'user';
    let username = base.length >= 2 ? base : `${base}-sso`;
    for (let i = 2; users.byUsername(username); i++) username = `${base}-${i}`;
    const created = await users.register({ username }, 'oidc');
    users.linkOidc(created.id, identity.issuer, identity.subject);
    return users.get(created.id);
  }
}
