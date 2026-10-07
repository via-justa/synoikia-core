/** Admin API response shapes (design §8.4), mirrored from packages/core. */

export type AuthMode = 'external' | 'bearer' | 'oauth' | 'bearer+oauth';
export const AUTH_MODES: AuthMode[] = ['external', 'bearer', 'oauth', 'bearer+oauth'];
export type Level = 'none' | 'read' | 'ask' | 'write';
export const LEVELS: Level[] = ['none', 'read', 'ask', 'write'];
export type Ceiling = 'read' | 'write';

export interface PublicUser {
  id: string;
  username: string;
  totpEnabled: boolean;
  oidcLinked: boolean;
  hasPassword: boolean;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SessionInfo {
  authenticated: boolean;
  setupRequired: boolean;
  localLoginEnabled: boolean;
  oidc: { enabled: boolean; label: string };
  user?: PublicUser;
  mustEnrollTotp?: boolean;
}

export interface InstanceSettings {
  approvalTimeoutMs: number;
  formElicitationApprovals: 'off' | 'writes';
  sessionGrantMaxHours: number;
  executePerMinute: number;
  writesPerMinute: number;
  sandbox: { timeoutMs: number; memoryMb: number; maxResultBytes: number };
  extraRedactKeys: string[];
  syncMaxAgeMs: number;
  memoryMb: number;
}

export interface Instance {
  id: string;
  slug: string;
  displayName: string;
  enabled: boolean;
  authMode: AuthMode | null;
  status: 'starting' | 'ready' | 'error' | 'stopped';
  statusError: string | null;
  upstreamVersion: string | null;
  /** Where the last catalog came from, as the plugin reports it (e.g. a version or git ref). */
  sourceRef?: string | null;
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
  settings: InstanceSettings;
  plugin: {
    id: string;
    pluginId: string;
    name: string;
    enabled: boolean;
    status: string;
    labels?: { operation: string; operations: string };
    /** The plugin offers best-practice guides (attestation keys). */
    attestation?: boolean;
  };
  endpointUrl?: string;
  effectiveAuthMode?: AuthMode;
}

export interface Overview {
  instances: Instance[];
  plugins: { id: string; pluginId: string; status: string; enabled: boolean }[];
  warnings: string[];
  publicMcpUrl: string | null;
  /** The core's version. */
  version?: string;
}

export interface UiHint {
  widget?: string;
  help?: string;
  placeholder?: string;
  optionsSource?: string;
  showWhen?: { field: string; in: (string | number | boolean)[] };
}

export interface JsonSchemaProp {
  type?: string | string[];
  title?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  format?: string;
  writeOnly?: boolean;
  minimum?: number;
  maximum?: number;
  items?: { enum?: unknown[]; type?: string };
}

export interface ConnectionSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
}

export interface Connection {
  config: Record<string, unknown>;
  secrets: Record<string, { set: boolean; hint?: string }>;
  schema: ConnectionSchema;
  ui: Record<string, UiHint>;
  help?: string;
}

export interface MatchField {
  field: string;
  label: string;
  op?: 'eq' | 'in' | 'prefix' | 'range' | 'bool';
  widget: string;
  options?: Record<string, unknown>;
  optionsSource?: string;
}

/** What a plugin's targets are and which scopes rules can select them by (the manifest's `targets`). */
export interface TargetsDecl {
  label: string;
  registryKind?: string;
  scopes: { key: string; label: string; registryKind?: string }[];
}

/** `options` of a `$targets` match field. */
export interface TargetFieldOptions {
  scopes?: string[];
  filter?: Record<string, string>;
}

export interface PluginRow {
  id: string;
  pluginId: string;
  version: string;
  repoId: string | null;
  sha256: string | null;
  signatureVerified: boolean;
  status: 'ok' | 'invalid' | 'incompatible';
  statusError: string | null;
  enabled: boolean;
  instances: number;
  manifest: {
    name?: string;
    description?: string;
    matchProfiles?: Record<string, MatchField[]>;
    targets?: TargetsDecl;
    network?: { hosts: string[] };
    connection?: { schema: ConnectionSchema; ui?: Record<string, UiHint>; help?: string };
    labels?: { operation: string; operations: string };
  };
}

export interface GroupSummary {
  key: string;
  label: string;
  level: Level;
  stale: boolean;
  counts: { read: number; write: number; locked: number; pendingReview: number; overridden: number };
}

export interface Operation {
  id: string;
  key: string;
  displayName: string | null;
  kind: string;
  tag: string | null;
  classification: 'read' | 'write';
  classificationSource: string | null;
  inferredClassification: string | null;
  inferredReason: string | null;
  locked: boolean;
  attestationRequired: boolean;
  /** The operation's own level; null follows its group. */
  levelOverride: Level | null;
  /** The level in force, in the operation's own terms (own, else what its group's level means for it). */
  level: Level;
  /** The levels this operation can be given on its own. */
  allowedLevels: Level[];
  /** What the upstream API says the operation does, when it says. */
  description: string | null;
  writeAcknowledged: boolean;
  needsReview: boolean;
  matchProfile: string | null;
  group: string | null;
  reachable: boolean;
  /** What a call does: run (read), approve (asks a human), auto (auto-approved write). */
  mode: 'run' | 'approve' | 'auto' | null;
  pendingReview: boolean;
  reason: string | null;
}

export type MatchCondition =
  | { field: string; op: 'eq' | 'in' | 'prefix' | 'range' | 'bool' | 'any'; value?: unknown }
  | { field: '$targets'; ids?: string[]; scopes?: Record<string, string[]> };

export interface Rule {
  id: string;
  operationId: string;
  match: MatchCondition[];
  rateLimit: number | null;
  windowSeconds: number | null;
  expiresAt: string | null;
  reason: string;
  enabled: boolean;
  createdAt: string;
  operation: { id: string; key: string; locked: boolean; matchProfile: string | null };
  inert: string | null;
  /** Last time the conditions held but the call had parameters the rule doesn't accept. */
  strictMissAt: string | null;
}

export interface RegistryEntry {
  kind: string;
  id: string;
  name: string | null;
  parentId: string | null;
  scopes: Record<string, string> | null;
}

export interface AuditRow {
  id: number;
  at: string;
  kind: 'call' | 'search' | 'config' | 'auth' | 'plugin';
  instanceId: string | null;
  operationKey: string | null;
  classification: string | null;
  decision: string | null;
  actorKind: string;
  actorId: string | null;
  decidedBy: string | null;
  decidedVia: string | null;
  params: unknown;
  resolvedTargets: unknown;
  resultStatus: string | null;
  durationMs: number | null;
  detail: unknown;
}

export interface Token {
  id: string;
  name: string;
  scope: string[];
  access: Ceiling;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface OAuthClient {
  id: string;
  clientId: string;
  name: string;
  redirectUris: string[];
  registeredVia: 'dcr' | 'admin';
  createdAt: string;
  revokedAt: string | null;
  confidential: boolean;
}

export interface Grant {
  id: string;
  resources: string[];
  access: Ceiling;
  createdAt: string;
  revokedAt: string | null;
  client: { id: string; clientId: string; name: string };
  user: { id: string; username: string };
}

export interface Repo {
  id: string;
  url: string;
  name: string | null;
  signingMode: 'signed' | 'unsigned';
  publicKey: string | null;
  keyId: string | null;
  keyStatus: 'ok' | 'key_changed';
  offeredKey: { publicKey: string; keyId: string } | null;
  pluginCount: number;
  lastFetchedAt: string | null;
  lastFetchError: string | null;
}

export interface AvailablePlugin {
  repoId: string;
  repoName: string | null;
  signingMode: 'signed' | 'unsigned';
  pluginId: string;
  name: string;
  description: string | null;
  versions: { version: string; compatible: boolean }[];
  latest: string | null;
  /** `managed`: installed from a repository. An unmanaged plugin (built in before 0.3.0, or copied in by hand) can be replaced from any repo. */
  installed: { version: string; fromThisRepo: boolean; managed: boolean } | null;
  updateAvailable: boolean;
  blocked: string | null;
}

export type NotifyEvent =
  'instance.error' | 'instance.recovered' | 'plugin.crashed' | 'sync.failed' | 'sync.pending_review' | 'auth.lockout';

export const NOTIFY_EVENTS: NotifyEvent[] = [
  'instance.error',
  'instance.recovered',
  'plugin.crashed',
  'sync.failed',
  'sync.pending_review',
  'auth.lockout',
];

export interface Notifier {
  id: string;
  kind: 'ntfy' | 'webhook';
  name: string;
  config: { server?: string; topic?: string; url?: string };
  secrets: Record<string, { set: boolean }>;
  events: NotifyEvent[];
  instanceFilter: string[] | null;
  enabled: boolean;
  lastSentAt: string | null;
  lastError: string | null;
}

export interface Settings {
  security: {
    requireTotp: boolean;
    disableLocalLogin: boolean;
    sessionIdleMinutes: number;
    approvalSessionIdleHours: number;
    approvalSessionAbsoluteDays: number;
    sessionAbsoluteHours: number;
  };
  mcp: {
    defaultAuthMode: AuthMode;
    allowDynamicRegistration: boolean;
    cfAccess: { teamDomain: string; aud: string };
    trustedIdentityHeader: string;
    accessTokenTtlMinutes: number;
    refreshTokenTtlDays: number;
  };
  audit: { retentionDays: number | null };
  oidc: {
    enabled: boolean;
    issuer: string;
    clientId: string;
    scopes: string;
    label: string;
    allowPolicy: { emails: string[]; subjects: string[]; group: string; groupsClaim: string };
    autoProvision: boolean;
    clientSecretSet: boolean;
  } | null;
  forceLocalLogin: boolean;
  publicMcpUrl: string | null;
  publicAdminUrl: string | null;
}

/** A live "Approve for this session" grant on one endpoint (design §5.8). */
export interface SessionGrant {
  id: string;
  client: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}
