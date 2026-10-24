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

/** Optional OIDC sign-in (ADR-0008): code + PKCE, state and nonce; the identity must pass the allow
 * policy and be linked unless auto-provisioning. Used by the admin and MCP-port logins. */

/** `*@example.com`: any verified address in that exact domain, never its subdomains. */
const DomainEntrySchema = z
  .string()
  .regex(
    /^\*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
    'Invalid domain entry',
  )
  .transform((e) => e.toLowerCase());

const AllowPolicySchema = z
  .object({
    /** Exact addresses or `*@domain` entries. */
    emails: z.array(z.union([z.string().email(), DomainEntrySchema])).default([]),
    subjects: z.array(z.string().min(1)).default([]),
    /** Required value in the groups claim (`groupsClaim`, default `groups`). */
    group: z.string().default(''),
    groupsClaim: z.string().default('groups'),
  })
  .prefault({});

// The issuer and the client count only while single sign-on is on, so it saves as off without them.
const OidcSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    issuer: z.string().default(''),
    clientId: z.string().default(''),
    scopes: z.string().default('openid email profile'),
    label: z.string().default('SSO'),
    allowPolicy: AllowPolicySchema,
    autoProvision: z.boolean().default(false),
  })
  .superRefine((s, ctx) => {
    if (!s.enabled) return;
    if (!z.url().safeParse(s.issuer).success)
      ctx.addIssue({ code: 'custom', path: ['issuer'], message: 'Invalid URL' });
    if (!s.clientId) ctx.addIssue({ code: 'custom', path: ['clientId'], message: 'Required while it is on' });
  });
export type OidcSettings = z.infer<typeof OidcSettingsSchema>;

// The state key also signs other payloads, so a verified token must still have this shape.
const OidcStateSchema = z.object({
  purpose: z.enum(['admin_login', 'mcp_login']),
  verifier: z.string(),
  state: z.string(),
  nonce: z.string(),
  redirectUri: z.url({ protocol: /^https?$/ }),
  returnTo: z.string().optional(),
});
export type OidcState = z.infer<typeof OidcStateSchema>;
export type OidcPurpose = OidcState['purpose'];

export interface OidcIdentity {
  issuer: string;
  subject: string;
  email?: string;
  username?: string;
  groups: string[];
}

const STATE_TTL_MS = 10 * 60_000;
function emailAllowed(entries: string[], email: string): boolean {
  const address = email.toLowerCase();
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return entries.some((e) => {
    const entry = e.toLowerCase();
    return entry.startsWith('*@') ? entry.slice(2) === domain : entry === address;
  });
}

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
    private readonly now: () => Date = () => new Date(),
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
  async begin(input: { purpose: OidcPurpose; redirectUri: string; returnTo?: string }) {
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
    };
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: input.redirectUri,
      scope: settings.scopes,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state: state.state,
      nonce: state.nonce,
    });
    return { url: url.toString(), stateToken: signPayload(this.stateKey, state, STATE_TTL_MS, this.now().getTime()) };
  }

  /** Validates the callback query (state, PKCE, nonce, ID token) and returns the identity plus the flow state. */
  async complete(
    callbackQuery: string,
    stateToken: string | undefined,
  ): Promise<{ identity: OidcIdentity; state: OidcState }> {
    const state = OidcStateSchema.safeParse(verifyPayload(this.stateKey, stateToken, this.now().getTime())).data;
    if (!state) throw new OidcError('oidc_state', 'Sign-in session expired or invalid; try again');
    const config = await this.configuration();
    // The token request's redirect_uri must equal the one sent to the IdP, not the URL a proxy forwarded.
    const callbackUrl = new URL(state.redirectUri);
    callbackUrl.search = callbackQuery;
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
      const detail =
        err instanceof oidc.ResponseBodyError
          ? `${err.error.slice(0, 100)}${err.error_description ? `: ${err.error_description.slice(0, 200)}` : ''}`
          : err instanceof Error
            ? err.message
            : String(err);
      throw new OidcError('oidc_failed', `Sign-in failed: ${detail}`);
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
    if (!policy || policyIsEmpty(policy)) return true; // the SSO accounts alone decide
    if (policy.subjects.includes(identity.subject)) return true;
    if (identity.email && emailAllowed(policy.emails, identity.email)) return true;
    if (policy.group && identity.groups.includes(policy.group)) return true;
    return false;
  }

  /** The SSO account of a sign-in (ADR-0025): bound by subject, made by an admin for the verified address, or new
   * with auto-provision; null when not allowed. A local account never signs in here. */
  async resolveUser(users: UserService, identity: OidcIdentity): Promise<UserRow | null> {
    if (!this.isAllowed(identity)) return null;
    const bound = users.byOidc(identity.issuer, identity.subject);
    if (bound) return bound.kind === 'sso' && !bound.disabled ? bound : null;
    const waiting = identity.email ? users.byPendingOidcEmail(identity.email) : undefined;
    // A disabled account takes no identity, so nobody can claim it while the admin keeps it off.
    if (waiting?.disabled) return null;
    if (waiting && !waiting.oidcSubject) {
      users.bindOidc(waiting.id, identity.issuer, identity.subject);
      return users.get(waiting.id);
    }
    const settings = this.getSettings();
    // Auto-provisioning is self-registration: it needs a default role too (ADR-0010).
    if (!settings?.autoProvision || policyIsEmpty(settings.allowPolicy) || !users.registrationOpen()) return null;
    const base =
      (identity.username ?? identity.email?.split('@')[0] ?? 'user').replace(/[^a-zA-Z0-9._@-]/g, '').slice(0, 48) ||
      'user';
    let username = base.length >= 2 ? base : `${base}-sso`;
    for (let i = 2; users.byUsernameInsensitive(username); i++) username = `${base}-${i}`;
    const created = await users.register({ username, kind: 'sso' }, 'oidc');
    users.bindOidc(created.id, identity.issuer, identity.subject);
    return users.get(created.id);
  }
}
