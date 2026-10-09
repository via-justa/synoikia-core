import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit } from './audit.js';
import type { Db } from './db/index.js';
import { settings } from './db/schema.js';
import { ValidationError } from './errors.js';
import { cleanStored, parseLeniently } from './lenient.js';

/** Global settings (design §8.2 "Settings"), one JSON document per section in the `settings` table. */

const SETTINGS_SCHEMAS = {
  security: z
    .object({
      /** Force every user to enroll TOTP at next login. */
      requireTotp: z.boolean().default(false),
      /** Only OIDC sign-in. Saving requires an OIDC-linked user; ADMIN_FORCE_LOCAL_LOGIN overrides. */
      disableLocalLogin: z.boolean().default(false),
      sessionIdleMinutes: z
        .number()
        .int()
        .min(5)
        .max(24 * 60)
        .default(30),
      sessionAbsoluteHours: z
        .number()
        .int()
        .min(1)
        .max(24 * 30)
        .default(12),
      /** Approval-page sign-in on the MCP port (design §5.3): TOTP once per browser for this long. */
      approvalSessionIdleHours: z
        .number()
        .int()
        .min(1)
        .max(24 * 7)
        .default(12),
      approvalSessionAbsoluteDays: z.number().int().min(1).max(30).default(7),
      /** Role of self-registered users (design §6.5); null turns self-registration off. */
      defaultRoleId: z.string().min(1).max(64).nullable().default(null),
      /** The "Create account" form on the sign-in page; needs a default role. */
      localSignup: z.boolean().default(false),
    })
    .prefault({}),
  mcp: z
    .object({
      defaultAuthMode: z.enum(['external', 'bearer', 'oauth', 'bearer+oauth']).default('bearer+oauth'),
      allowDynamicRegistration: z.boolean().default(true),
      /** Cloudflare Access JWT verification for `external` mode. */
      cfAccess: z.object({ teamDomain: z.string().default(''), aud: z.string().default('') }).prefault({}),
      /** Header set by an auth proxy (Authelia/Authentik) used only to attribute calls in `external` mode. */
      trustedIdentityHeader: z.string().default(''),
      accessTokenTtlMinutes: z
        .number()
        .int()
        .min(5)
        .max(24 * 60)
        .default(60),
      refreshTokenTtlDays: z.number().int().min(1).max(365).default(30),
    })
    .prefault({}),
  audit: z
    .object({
      /** Unset = keep forever (design §10). */
      retentionDays: z.number().int().min(7).nullable().default(null),
    })
    .prefault({}),
} as const;

export type SettingsSection = keyof typeof SETTINGS_SCHEMAS;
export type Settings<S extends SettingsSection> = z.infer<(typeof SETTINGS_SCHEMAS)[S]>;

export function isSettingsSection(name: string): name is SettingsSection {
  return Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMAS, name);
}

/** Stored settings are read leniently: a field a newer schema rejects falls back to its default. */
export function getSettings<S extends SettingsSection>(db: Db, section: S): Settings<S> {
  const row = db.select().from(settings).where(eq(settings.key, section)).get();
  return parseLeniently(SETTINGS_SCHEMAS[section], row?.value, `settings.${section}`) as Settings<S>;
}

/** Startup: removes stored settings fields the schema rejects, once; valid fields stay as stored. */
export function normalizeStoredSettings(db: Db): string[] {
  const changed: string[] = [];
  for (const row of db.select().from(settings).all()) {
    if (!isSettingsSection(row.key)) continue;
    const { cleaned, dropped } = cleanStored(SETTINGS_SCHEMAS[row.key], row.value, `settings.${row.key}`);
    if (!dropped.length) continue;
    db.update(settings).set({ value: cleaned }).where(eq(settings.key, row.key)).run();
    changed.push(row.key);
  }
  return changed;
}

export function updateSettings<S extends SettingsSection>(
  db: Db,
  section: S,
  patch: unknown,
  actor: { userId?: string } = {},
): Settings<S> {
  const before = getSettings(db, section);
  const parsed = SETTINGS_SCHEMAS[section].safeParse({ ...before, ...(patch as object) });
  if (!parsed.success) {
    throw new ValidationError(
      'invalid_settings',
      'Invalid settings',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  db.transaction((tx) => {
    tx.insert(settings)
      .values({ key: section, value: parsed.data })
      .onConflictDoUpdate({ target: settings.key, set: { value: parsed.data } })
      .run();
    writeAudit(tx, {
      kind: 'config',
      decision: 'settings_updated',
      actorKind: 'user',
      actorId: actor.userId,
      detail: { section, before, after: parsed.data },
    });
  });
  return parsed.data as Settings<S>;
}
