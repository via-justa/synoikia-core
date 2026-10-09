import type { SensitiveResult } from '@synoikia/plugin-sdk';
import { sql } from 'drizzle-orm';
import { blob, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { ADMIN_ROLE_ID } from '../gate/access.js';

/** The SQLite schema (design §7.1): JSON as TEXT, timestamps as epoch ms, secrets as AES-256-GCM blobs. */

const id = () => text('id').primaryKey();
const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });
const createdAt = () =>
  ts('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`);
const flag = (name: string) => integer(name, { mode: 'boolean' });
const json = (name: string) => text(name, { mode: 'json' });

// ── identity & admin auth ────────────────────────────────────────────────────────────────────────

export const roles = sqliteTable('roles', {
  id: id(),
  name: text('name').notNull().unique(),
  builtIn: flag('built_in').notNull().default(false),
  canSetOwnLevels: flag('can_set_own_levels').notNull().default(false),
  canManageOwnRules: flag('can_manage_own_rules').notNull().default(false),
  canSeeStatus: flag('can_see_status').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: ts('updated_at'),
});

export const users = sqliteTable('users', {
  id: id(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash'),
  totpSecretEnc: blob('totp_secret_enc', { mode: 'buffer' }),
  totpEnabled: flag('totp_enabled').notNull().default(false),
  /** Last accepted TOTP time step, so a code can't be replayed within its window. */
  totpLastStep: integer('totp_last_step'),
  recoveryCodesHash: json('recovery_codes_hash').$type<string[]>(),
  oidcIssuer: text('oidc_issuer'),
  oidcSubject: text('oidc_subject'),
  createdAt: createdAt(),
  lastLoginAt: ts('last_login_at'),
  disabled: flag('disabled').notNull().default(false),
  /** References `roles`; SQLite can't add that constraint to an existing table, so RoleService keeps it. */
  roleId: text('role_id').notNull().default(ADMIN_ROLE_ID),
  /** How the user came to exist without an admin (design §6.5); null: an admin or setup made it. */
  registeredVia: text('registered_via', { enum: ['oidc', 'external', 'signup'] }),
});

export const sessions = sqliteTable(
  'sessions',
  {
    idHash: text('id_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['admin', 'oauth_ui', 'approval_ui'] }).notNull(),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: json('value').notNull(),
});

export const oidcConfig = sqliteTable('oidc_config', {
  id: integer('id').primaryKey(),
  issuer: text('issuer').notNull(),
  clientId: text('client_id').notNull(),
  clientSecretEnc: blob('client_secret_enc', { mode: 'buffer' }),
  scopes: text('scopes').notNull().default('openid email profile'),
  allowPolicy: json('allow_policy').$type<{ emails?: string[]; subjects?: string[]; group?: string }>(),
  autoProvision: flag('auto_provision').notNull().default(false),
  enabled: flag('enabled').notNull().default(false),
});

// ── plugins ──────────────────────────────────────────────────────────────────────────────────────

export const pluginRepos = sqliteTable('plugin_repos', {
  id: id(),
  url: text('url').notNull().unique(),
  name: text('name'),
  signingMode: text('signing_mode', { enum: ['signed', 'unsigned'] }).notNull(),
  publicKey: text('public_key'),
  keyFingerprint: text('key_fingerprint'),
  keyStatus: text('key_status', { enum: ['ok', 'key_changed'] })
    .notNull()
    .default('ok'),
  indexCache: json('index_cache'),
  lastFetchedAt: ts('last_fetched_at'),
  lastFetchError: text('last_fetch_error'),
});

export const plugins = sqliteTable('plugins', {
  id: id(),
  pluginId: text('plugin_id').notNull().unique(),
  version: text('version').notNull(),
  repoId: text('repo_id').references(() => pluginRepos.id),
  path: text('path').notNull(),
  sha256: text('sha256'),
  signatureVerified: flag('signature_verified').notNull().default(false),
  manifest: json('manifest').notNull(),
  status: text('status', { enum: ['ok', 'invalid', 'incompatible'] }).notNull(),
  statusError: text('status_error'),
  enabled: flag('enabled').notNull().default(false),
  installedAt: createdAt(),
});

export const pluginInstances = sqliteTable('plugin_instances', {
  id: id(),
  pluginId: text('plugin_id')
    .notNull()
    .references(() => plugins.id),
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull(),
  enabled: flag('enabled').notNull().default(true),
  config: json('config').notNull().default({}),
  secretsEnc: blob('secrets_enc', { mode: 'buffer' }),
  /** NULL = inherit the global default (design §6.2). */
  authMode: text('auth_mode', { enum: ['external', 'bearer', 'oauth', 'bearer+oauth'] }),
  settings: json('settings').notNull().default({}),
  status: text('status', { enum: ['stopped', 'starting', 'ready', 'error'] })
    .notNull()
    .default('stopped'),
  statusError: text('status_error'),
  upstreamVersion: text('upstream_version'),
  sourceRef: text('source_ref'),
  lastSyncedAt: ts('last_synced_at'),
  lastSyncStatus: text('last_sync_status'),
  /** The plugin version the catalog was synced from; another bundle is synced before serving again. */
  catalogPluginVersion: text('catalog_plugin_version'),
  createdAt: createdAt(),
});

// ── catalog ──────────────────────────────────────────────────────────────────────────────────────

/** One none/read/ask/write level per group; operations follow it unless they carry their own level (design §5.2). */
export const operationGroups = sqliteTable(
  'operation_groups',
  {
    id: id(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => pluginInstances.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    /** Catalog sync creates groups at `ask` (reads run, writes ask); the column default is only a fallback. */
    level: text('level', { enum: ['none', 'read', 'ask', 'write'] })
      .notNull()
      .default('read'),
    levelChangedAt: ts('level_changed_at'),
    levelChangedBy: text('level_changed_by').references(() => users.id),
    firstSeenAt: ts('first_seen_at').notNull(),
    stale: flag('stale').notNull().default(false),
  },
  (t) => [uniqueIndex('operation_groups_instance_key_idx').on(t.instanceId, t.key)],
);

/** Admin regrouping: maps a plugin-derived group onto a (possibly merged) group key; survives syncs. */
export const operationGroupAliases = sqliteTable(
  'operation_group_aliases',
  {
    instanceId: text('instance_id')
      .notNull()
      .references(() => pluginInstances.id, { onDelete: 'cascade' }),
    pluginGroup: text('plugin_group').notNull(),
    groupKey: text('group_key').notNull(),
  },
  (t) => [uniqueIndex('operation_group_aliases_idx').on(t.instanceId, t.pluginGroup)],
);

export const operations = sqliteTable(
  'operations',
  {
    id: id(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => pluginInstances.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    displayName: text('display_name'),
    kind: text('kind').notNull(),
    /** Group as derived by the plugin, before admin aliases are applied. */
    pluginGroup: text('plugin_group').notNull(),
    groupId: text('group_id')
      .notNull()
      .references(() => operationGroups.id),
    tag: text('tag'),
    /** Effective classification; locked implies write. */
    classification: text('classification', { enum: ['read', 'write'] }).notNull(),
    classificationSource: text('classification_source', { enum: ['locked', 'override', 'inferred'] }).notNull(),
    inferredClassification: text('inferred_classification', { enum: ['read', 'write'] }).notNull(),
    inferredReason: text('inferred_reason').notNull(),
    locked: flag('locked').notNull().default(false),
    /** Admin-set level for this operation; null follows the group. Locked ops only become callable at `ask`. */
    levelOverride: text('level_override', { enum: ['none', 'read', 'ask', 'write'] }),
    /** Writes at level `write` still ask for approval until an admin acknowledges them. */
    writeAcknowledged: flag('write_acknowledged').notNull().default(false),
    acknowledgedAt: ts('acknowledged_at'),
    acknowledgedBy: text('acknowledged_by').references(() => users.id),
    typedConfirmation: flag('typed_confirmation').notNull().default(false),
    attestationRequired: flag('attestation_required').notNull().default(false),
    /** An admin turned the attestation requirement off; the plugin's request no longer re-adds it. */
    attestationWaived: flag('attestation_waived').notNull().default(false),
    needsReview: flag('needs_review').notNull().default(false),
    matchProfile: text('match_profile'),
    paramsSchema: json('params_schema'),
    /** JSON-pointer paths into params that hold a secret without a key name (a positional password). */
    sensitiveParams: json('sensitive_params').$type<string[]>(),
    /** Secrets in the result that no key name gives away; core masks them after `invoke` (design §5.5). */
    sensitiveResult: json('sensitive_result').$type<SensitiveResult>(),
    docs: json('docs'),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    stale: flag('stale').notNull().default(false),
  },
  (t) => [
    uniqueIndex('operations_instance_key_idx').on(t.instanceId, t.key),
    index('operations_group_idx').on(t.groupId),
  ],
);

export const registryEntries = sqliteTable(
  'registry_entries',
  {
    id: id(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => pluginInstances.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    extId: text('ext_id').notNull(),
    name: text('name').notNull(),
    parentExtId: text('parent_ext_id'),
    scopes: json('scopes'),
    attrs: json('attrs'),
    stale: flag('stale').notNull().default(false),
    lastSyncedAt: ts('last_synced_at').notNull(),
  },
  (t) => [uniqueIndex('registry_instance_kind_ext_idx').on(t.instanceId, t.kind, t.extId)],
);

export const guides = sqliteTable('guides', {
  id: id(),
  instanceId: text('instance_id')
    .notNull()
    .references(() => pluginInstances.id, { onDelete: 'cascade' }),
  operationId: text('operation_id')
    .notNull()
    .references(() => operations.id, { onDelete: 'cascade' }),
  version: text('version').notNull(),
  content: text('content').notNull(),
  fetchedAt: ts('fetched_at').notNull(),
});

// ── permission gate ──────────────────────────────────────────────────────────────────────────────

export const preApprovalRules = sqliteTable('pre_approval_rules', {
  id: id(),
  instanceId: text('instance_id')
    .notNull()
    .references(() => pluginInstances.id, { onDelete: 'cascade' }),
  operationId: text('operation_id')
    .notNull()
    .references(() => operations.id),
  match: json('match').notNull().default([]),
  rateLimit: integer('rate_limit'),
  windowSeconds: integer('window_seconds'),
  expiresAt: ts('expires_at'),
  reason: text('reason').notNull(),
  enabled: flag('enabled').notNull().default(true),
  createdBy: text('created_by').references(() => users.id),
  /** Null: an admin rule for every caller. Set: applies only to this user's calls (design §6.4). */
  ownerUserId: text('owner_user_id').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: ts('updated_at'),
  lastTriggeredAt: ts('last_triggered_at'),
  /** Last time the conditions held but the call had parameters the rule doesn't accept (strict match). */
  strictMissAt: ts('strict_miss_at'),
});

export const preApprovalHits = sqliteTable(
  'pre_approval_hits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ruleId: text('rule_id')
      .notNull()
      .references(() => preApprovalRules.id, { onDelete: 'cascade' }),
    occurredAt: ts('occurred_at').notNull(),
  },
  (t) => [index('hits_rule_time_idx').on(t.ruleId, t.occurredAt)],
);

export const pendingApprovals = sqliteTable('pending_approvals', {
  id: id(),
  instanceId: text('instance_id')
    .notNull()
    .references(() => pluginInstances.id),
  operationId: text('operation_id')
    .notNull()
    .references(() => operations.id),
  /** Redacted copy for display; the real params live only in memory while pending (design §5.5). */
  paramsDisplay: json('params_display'),
  paramsHash: text('params_hash').notNull(),
  resolvedTargets: json('resolved_targets'),
  summary: text('summary').notNull(),
  confirmLiteral: text('confirm_literal'),
  diff: json('diff'),
  expectedHash: text('expected_hash'),
  clientKind: text('client_kind'),
  clientId: text('client_id'),
  mcpSessionId: text('mcp_session_id'),
  requestedAt: ts('requested_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
  status: text('status', { enum: ['pending', 'approved', 'denied', 'timed_out', 'cancelled'] })
    .notNull()
    .default('pending'),
  decidedBy: text('decided_by'),
  /** `url`: decided by a signed-in human on the approval page; `elicitation`: by the MCP client (opt-in). */
  decidedVia: text('decided_via', { enum: ['elicitation', 'url'] }),
  decidedAt: ts('decided_at'),
  /** The user who owns the calling credential: the only one who may decide on the page (design §5.3). */
  ownerUserId: text('owner_user_id').references(() => users.id),
});

/** Append-only: no API updates or deletes rows (design §7.3). */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: ts('at').notNull(),
    kind: text('kind', { enum: ['call', 'search', 'config', 'auth', 'plugin'] }).notNull(),
    instanceId: text('instance_id'),
    operationKey: text('operation_key'),
    classification: text('classification'),
    decision: text('decision'),
    actorKind: text('actor_kind', { enum: ['mcp_client', 'user', 'system'] }).notNull(),
    actorId: text('actor_id'),
    decidedBy: text('decided_by'),
    decidedVia: text('decided_via'),
    params: json('params'),
    resolvedTargets: json('resolved_targets'),
    resultStatus: text('result_status'),
    durationMs: integer('duration_ms'),
    detail: json('detail'),
  },
  (t) => [index('audit_at_idx').on(t.at), index('audit_instance_at_idx').on(t.instanceId, t.at)],
);

// ── roles (design §6.4) ──────────────────────────────────────────────────────────────────────────

/** The endpoints a role has; outside them its users reach nothing. */
export const roleInstances = sqliteTable(
  'role_instances',
  {
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    instanceId: text('instance_id')
      .notNull()
      .references(() => pluginInstances.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('role_instances_idx').on(t.roleId, t.instanceId)],
);

/** A role's maximum level for one group or one operation (exactly one is set); no row means None. */
export const roleLevels = sqliteTable(
  'role_levels',
  {
    id: id(),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    instanceId: text('instance_id')
      .notNull()
      .references(() => pluginInstances.id, { onDelete: 'cascade' }),
    groupId: text('group_id').references(() => operationGroups.id, { onDelete: 'cascade' }),
    operationId: text('operation_id').references(() => operations.id, { onDelete: 'cascade' }),
    level: text('level', { enum: ['none', 'read', 'ask', 'write'] }).notNull(),
    changedAt: ts('changed_at'),
    changedBy: text('changed_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('role_levels_group_idx').on(t.roleId, t.groupId),
    uniqueIndex('role_levels_op_idx').on(t.roleId, t.operationId),
  ],
);

/** A user's own level for one group or one operation, capped by their role's maximum. */
export const userLevels = sqliteTable(
  'user_levels',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    instanceId: text('instance_id')
      .notNull()
      .references(() => pluginInstances.id, { onDelete: 'cascade' }),
    groupId: text('group_id').references(() => operationGroups.id, { onDelete: 'cascade' }),
    operationId: text('operation_id').references(() => operations.id, { onDelete: 'cascade' }),
    level: text('level', { enum: ['none', 'read', 'ask', 'write'] }).notNull(),
    changedAt: ts('changed_at'),
  },
  (t) => [
    uniqueIndex('user_levels_group_idx').on(t.userId, t.groupId),
    uniqueIndex('user_levels_op_idx').on(t.userId, t.operationId),
  ],
);

// ── MCP client auth ──────────────────────────────────────────────────────────────────────────────

export const mcpTokens = sqliteTable('mcp_tokens', {
  id: id(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  /** Instance ids, or ['*']. */
  scope: json('scope').$type<string[]>().notNull(),
  /** Ceiling on what the token can reach: `read` hides and blocks every write. */
  access: text('access', { enum: ['read', 'write'] })
    .notNull()
    .default('read'),
  createdBy: text('created_by').references(() => users.id),
  createdAt: createdAt(),
  expiresAt: ts('expires_at'),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
});

export const oauthClients = sqliteTable('oauth_clients', {
  id: id(),
  clientId: text('client_id').notNull().unique(),
  clientSecretHash: text('client_secret_hash'),
  name: text('name').notNull(),
  redirectUris: json('redirect_uris').$type<string[]>().notNull(),
  registeredVia: text('registered_via', { enum: ['dcr', 'admin'] }).notNull(),
  createdAt: createdAt(),
  revokedAt: ts('revoked_at'),
});

export const oauthGrants = sqliteTable('oauth_grants', {
  id: id(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  resources: json('resources').$type<string[]>().notNull(),
  /** Instance ids the consented resources named at consent; tokens are checked against these, not slugs
   * (design §6.2). NULL only for grants from before this column. */
  instanceIds: json('instance_ids').$type<string[]>(),
  /** Chosen on the consent page (design §6.3); `read` hides and blocks every write. */
  access: text('access', { enum: ['read', 'write'] })
    .notNull()
    .default('read'),
  createdAt: createdAt(),
  revokedAt: ts('revoked_at'),
});

export const oauthCodes = sqliteTable('oauth_codes', {
  codeHash: text('code_hash').primaryKey(),
  grantId: text('grant_id')
    .notNull()
    .references(() => oauthGrants.id, { onDelete: 'cascade' }),
  codeChallenge: text('code_challenge').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  resources: json('resources').$type<string[]>().notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
});

export const oauthTokens = sqliteTable('oauth_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  grantId: text('grant_id')
    .notNull()
    .references(() => oauthGrants.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['access', 'refresh'] }).notNull(),
  familyId: text('family_id').notNull(),
  resources: json('resources').$type<string[]>().notNull(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
});

// ── notifications ────────────────────────────────────────────────────────────────────────────────

export const notifierChannels = sqliteTable('notifier_channels', {
  id: id(),
  kind: text('kind', { enum: ['ntfy', 'webhook'] }).notNull(),
  name: text('name').notNull(),
  config: json('config').notNull(),
  secretsEnc: blob('secrets_enc', { mode: 'buffer' }),
  events: json('events').$type<string[]>().notNull(),
  instanceFilter: json('instance_filter').$type<string[]>(),
  enabled: flag('enabled').notNull().default(true),
  lastSentAt: ts('last_sent_at'),
  lastError: text('last_error'),
});

export const approvalLinks = sqliteTable('approval_links', {
  tokenHash: text('token_hash').primaryKey(),
  approvalId: text('approval_id')
    .notNull()
    .references(() => pendingApprovals.id, { onDelete: 'cascade' }),
  action: text('action', { enum: ['approve', 'deny', 'view'] }).notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
});
