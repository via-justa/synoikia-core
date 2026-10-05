import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseManifest, SDK_VERSION } from '@synoikia/plugin-sdk';
import type { Manifest } from '@synoikia/plugin-sdk';
import { asc, eq } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import { applyRegistrySync } from '../catalog/registry.js';
import { applyCatalogSync } from '../catalog/sync.js';
import type { SyncSummary } from '../catalog/sync.js';
import { aad } from '../crypto/index.js';
import type { SecretBox } from '../crypto/index.js';
import type { Db } from '../db/index.js';
import { pendingApprovals, pluginInstances, plugins } from '../db/schema.js';
import { isValidSlug } from '../endpoints/slug.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import type { CoreEvents } from '../events.js';
import { createInstanceRedactor, GLOBAL_SENSITIVE_KEYS } from '../gate/redact.js';
import type { InstanceRuntime } from '../gate/pipeline.js';
import { PluginProcess, PluginUnavailableError } from '../plugins/process.js';
import { PluginSupervisor } from '../plugins/supervisor.js';
import type { InstanceStatus } from '../plugins/supervisor.js';
import { mergeSecrets, storedSecretsFor, summarizeSecrets, validateConnection } from './connection.js';
import { cleanInstanceSettings, parseInstanceSettings, readInstanceSettings } from './settings.js';
import type { InstanceSettings } from './settings.js';

/** Instance lifecycle (design §4, §10): connection config, one supervised plugin child per enabled
 * instance, and sync scheduling. */

export const AUTH_MODES = ['external', 'bearer', 'oauth', 'bearer+oauth'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

type InstanceRow = typeof pluginInstances.$inferSelect;
type PluginRow = typeof plugins.$inferSelect;

export interface ManagerOptions {
  db: Db;
  secrets: SecretBox;
  events: CoreEvents;
  now?: () => Date;
  /** Test hooks: faster restarts and shorter RPC/init timeouts. */
  supervisor?: { backoff?: { initialMs: number; maxMs: number }; initTimeoutMs?: number; rpcTimeoutMs?: number };
  /** How often a live session may trigger the cheap upstream version check. */
  versionCheckIntervalMs?: number;
}

interface Live {
  supervisor: PluginSupervisor;
  syncing?: Promise<SyncSummary>;
  lastVersionCheck: number;
  catalogChangedTimer?: NodeJS.Timeout;
  /** The running child's bundle version, read from its manifest.json just before each fork; the catalog
   * must have been synced from it (`ensureFresh`). */
  version?: string;
}

/** The version in a plugin directory's manifest.json, as the child about to run it sees it. */
function bundleVersion(dir: string): string {
  const version = (JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { version?: unknown }).version;
  if (typeof version !== 'string' || !version) throw new Error('manifest.json has no version');
  return version;
}

export interface CreateInstanceInput {
  pluginId: string;
  slug: string;
  displayName?: string;
  /** Config and secrets together, as the connection form submits them. */
  connection: Record<string, unknown>;
  authMode?: AuthMode | null;
  settings?: unknown;
  enabled?: boolean;
}

export interface Actor {
  userId?: string;
}

export class InstanceManager {
  private readonly live = new Map<string, Live>();
  private readonly db: Db;
  private readonly now: () => Date;

  constructor(private readonly opts: ManagerOptions) {
    this.db = opts.db;
    this.now = opts.now ?? (() => new Date());
  }

  // ── lookups ────────────────────────────────────────────────────────────────────────────────────

  private row(id: string): InstanceRow {
    const row = this.db.select().from(pluginInstances).where(eq(pluginInstances.id, id)).get();
    if (!row) throw new NotFoundError('instance_not_found', 'No such instance');
    return row;
  }

  private plugin(pluginRowId: string): PluginRow & { parsed: Manifest } {
    const p = this.db.select().from(plugins).where(eq(plugins.id, pluginRowId)).get();
    if (!p) throw new NotFoundError('plugin_not_found', 'No such plugin');
    // Discovery re-validates manifests against the current SDK on every start and marks failures; a
    // row it marked unusable is reported as such rather than failing deep inside a request.
    if (p.status !== 'ok')
      throw new ConflictError(
        'plugin_unusable',
        `Plugin ${p.pluginId} is ${p.status}${p.statusError ? `: ${p.statusError}` : ''}`,
      );
    return { ...p, parsed: parseManifest(p.manifest) };
  }

  /** Resolves a plugin by row id or by manifest id (`acme`). */
  private pluginByAnyId(id: string): PluginRow {
    const p =
      this.db.select().from(plugins).where(eq(plugins.id, id)).get() ??
      this.db.select().from(plugins).where(eq(plugins.pluginId, id)).get();
    if (!p) throw new NotFoundError('plugin_not_found', `No plugin "${id}"`);
    return p;
  }

  list() {
    return this.db
      .select({ instance: pluginInstances, plugin: plugins })
      .from(pluginInstances)
      .innerJoin(plugins, eq(pluginInstances.pluginId, plugins.id))
      .orderBy(asc(pluginInstances.slug))
      .all()
      .map(({ instance, plugin }) => this.describe(instance, plugin));
  }

  get(id: string) {
    const instance = this.row(id);
    return this.describe(instance, this.plugin(instance.pluginId));
  }

  bySlug(slug: string): { instance: InstanceRow; plugin: PluginRow } | undefined {
    const found = this.db
      .select({ instance: pluginInstances, plugin: plugins })
      .from(pluginInstances)
      .innerJoin(plugins, eq(pluginInstances.pluginId, plugins.id))
      .where(eq(pluginInstances.slug, slug))
      .get();
    return found ?? undefined;
  }

  private describe(instance: InstanceRow, plugin: PluginRow) {
    const manifest = plugin.status === 'ok' ? parseManifest(plugin.manifest) : undefined;
    return {
      id: instance.id,
      slug: instance.slug,
      displayName: instance.displayName,
      enabled: instance.enabled,
      authMode: (instance.authMode as AuthMode | null) ?? null,
      status: instance.status,
      statusError: instance.statusError,
      upstreamVersion: instance.upstreamVersion,
      sourceRef: instance.sourceRef,
      lastSyncedAt: instance.lastSyncedAt,
      lastSyncStatus: instance.lastSyncStatus,
      settings: readInstanceSettings(instance.settings, `/${instance.slug} settings`),
      plugin: {
        id: plugin.id,
        pluginId: plugin.pluginId,
        name: manifest?.name ?? plugin.pluginId,
        enabled: plugin.enabled,
        status: plugin.status,
        labels: manifest?.labels,
        attestation: manifest?.capabilities.attestation ?? false,
      },
    };
  }

  /** Whether the instance's endpoint should serve: instance and plugin enabled, plugin healthy. */
  isServing(instance: InstanceRow, plugin: PluginRow): boolean {
    return instance.enabled && plugin.enabled && plugin.status === 'ok';
  }

  settingsOf(instance: InstanceRow): InstanceSettings {
    return readInstanceSettings(instance.settings, `/${instance.slug} settings`);
  }

  /** Scrubs an instance's secret values out of plugin/upstream error text before it is stored or sent. */
  private scrubError(instanceId: string, message: string): string {
    try {
      const instance = this.row(instanceId);
      return createInstanceRedactor({ keyLists: [], secretValues: Object.values(this.readSecrets(instance)) })(message);
    } catch {
      return message;
    }
  }

  /** Startup step: removes stored instance settings fields the current schema rejects. */
  normalizeStoredSettings(): string[] {
    const changed: string[] = [];
    for (const row of this.db.select().from(pluginInstances).all()) {
      const { cleaned, dropped } = cleanInstanceSettings(row.settings, `/${row.slug} settings`);
      if (!dropped.length) continue;
      this.db
        .update(pluginInstances)
        .set({ settings: cleaned as Record<string, unknown> })
        .where(eq(pluginInstances.id, row.id))
        .run();
      changed.push(row.slug);
    }
    return changed;
  }

  /** Everything the gate needs for one instance. */
  runtime(instanceId: string): InstanceRuntime {
    const instance = this.row(instanceId);
    const plugin = this.plugin(instance.pluginId);
    const settings = this.settingsOf(instance);
    return {
      instanceId,
      slug: instance.slug,
      manifest: plugin.parsed,
      settings,
      redact: createInstanceRedactor({
        keyLists: [GLOBAL_SENSITIVE_KEYS, plugin.parsed.sensitiveKeys, settings.extraRedactKeys],
        secretValues: Object.values(this.readSecrets(instance)),
      }),
      plugin: () => {
        const live = this.live.get(instanceId);
        if (!live) throw new PluginUnavailableError();
        return live.supervisor.client;
      },
      catalogVersion: () => {
        const version = this.live.get(instanceId)?.version;
        const synced = this.db
          .select({ v: pluginInstances.catalogPluginVersion })
          .from(pluginInstances)
          .where(eq(pluginInstances.id, instanceId))
          .get()?.v;
        return version && synced === version ? version : undefined;
      },
    };
  }

  status(instanceId: string): InstanceStatus {
    return this.live.get(instanceId)?.supervisor.status ?? 'stopped';
  }

  // ── secrets ────────────────────────────────────────────────────────────────────────────────────

  private readSecrets(instance: InstanceRow): Record<string, string> {
    if (!instance.secretsEnc) return {};
    return this.opts.secrets.decryptJson<Record<string, string>>(
      instance.secretsEnc,
      aad('plugin_instances', 'secrets_enc', instance.id),
    );
  }

  private sealSecrets(instanceId: string, secrets: Record<string, string>): Buffer | null {
    if (Object.keys(secrets).length === 0) return null;
    return this.opts.secrets.encryptJson(secrets, aad('plugin_instances', 'secrets_enc', instanceId));
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────────────────────────

  async create(input: CreateInstanceInput, actor: Actor = {}) {
    const plugin = this.pluginByAnyId(input.pluginId);
    if (plugin.status !== 'ok')
      throw new ConflictError('plugin_unusable', `Plugin ${plugin.pluginId} is ${plugin.status}`);
    const manifest = parseManifest(plugin.manifest);
    const slug = input.slug.trim();
    if (!isValidSlug(slug)) {
      throw new ValidationError(
        'invalid_slug',
        'Slug must be lowercase letters, digits and dashes, and not a reserved path',
      );
    }
    if (this.bySlug(slug)) throw new ConflictError('slug_taken', `/${slug} is already in use`);
    if (input.authMode != null && !(AUTH_MODES as readonly string[]).includes(input.authMode)) {
      throw new ValidationError('invalid_auth_mode', 'Unknown auth mode');
    }
    const settings = parseInstanceSettings(input.settings);
    const { config, secrets } = validateConnection(manifest, input.connection);

    const id = randomUUID();
    this.db.transaction((tx) => {
      tx.insert(pluginInstances)
        .values({
          id,
          pluginId: plugin.id,
          slug,
          displayName: input.displayName?.trim() || manifest.name,
          enabled: input.enabled ?? true,
          config,
          secretsEnc: this.sealSecrets(id, secrets),
          authMode: input.authMode ?? null,
          settings,
          createdAt: this.now(),
        })
        .run();
      writeAudit(tx, {
        kind: 'config',
        instanceId: id,
        decision: 'instance_created',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { slug, plugin: plugin.pluginId, config, secrets: Object.keys(secrets) },
      });
    });
    const row = this.row(id);
    if (this.isServing(row, plugin)) await this.start(id);
    return this.get(id);
  }

  async update(
    id: string,
    patch: { displayName?: string; slug?: string; enabled?: boolean; authMode?: AuthMode | null; settings?: unknown },
    actor: Actor = {},
  ) {
    const before = this.row(id);
    const set: Partial<typeof pluginInstances.$inferInsert> = {};
    if (patch.displayName !== undefined) {
      if (!patch.displayName.trim()) throw new ValidationError('invalid_name', 'Name must not be empty');
      set.displayName = patch.displayName.trim();
    }
    if (patch.slug !== undefined && patch.slug !== before.slug) {
      if (!isValidSlug(patch.slug)) throw new ValidationError('invalid_slug', 'Invalid slug');
      if (this.bySlug(patch.slug)) throw new ConflictError('slug_taken', `/${patch.slug} is already in use`);
      set.slug = patch.slug;
    }
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.authMode !== undefined) {
      if (patch.authMode !== null && !(AUTH_MODES as readonly string[]).includes(patch.authMode)) {
        throw new ValidationError('invalid_auth_mode', 'Unknown auth mode');
      }
      set.authMode = patch.authMode;
    }
    if (patch.settings !== undefined) {
      // Start from the normalized stored settings, so a field an older release stored and this one
      // rejects doesn't block saving an unrelated change.
      const stored = cleanInstanceSettings(before.settings, `/${before.slug} settings`).cleaned as object;
      const merged = { ...stored, ...(patch.settings as object) };
      set.settings = parseInstanceSettings(merged);
    }
    if (Object.keys(set).length === 0) return this.get(id);

    this.db.transaction((tx) => {
      tx.update(pluginInstances).set(set).where(eq(pluginInstances.id, id)).run();
      writeAudit(tx, {
        kind: 'config',
        instanceId: id,
        decision: 'instance_updated',
        actorKind: 'user',
        actorId: actor.userId,
        detail: {
          before: Object.fromEntries(Object.keys(set).map((k) => [k, before[k as keyof InstanceRow]])),
          after: set,
        },
      });
    });
    const after = this.row(id);
    const plugin = this.plugin(after.pluginId);
    const shouldRun = this.isServing(after, plugin);
    if (!shouldRun) await this.stop(id);
    else if (!this.live.has(id)) await this.start(id);
    else if (set.settings) await this.live.get(id)!.supervisor.restart();
    return this.get(id);
  }

  async remove(id: string, confirmSlug: string, actor: Actor = {}) {
    const row = this.row(id);
    if (confirmSlug !== row.slug)
      throw new ConflictError('confirmation_required', `Type "${row.slug}" to delete this endpoint`);
    await this.stop(id);
    this.db.transaction((tx) => {
      tx.delete(pendingApprovals).where(eq(pendingApprovals.instanceId, id)).run();
      tx.delete(pluginInstances).where(eq(pluginInstances.id, id)).run();
      writeAudit(tx, {
        kind: 'config',
        instanceId: id,
        decision: 'instance_deleted',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { slug: row.slug },
      });
    });
  }

  getConnection(id: string) {
    const row = this.row(id);
    const manifest = this.plugin(row.pluginId).parsed;
    return {
      config: row.config as Record<string, unknown>,
      secrets: summarizeSecrets(manifest, this.readSecrets(row)),
      schema: manifest.connection.schema,
      ui: manifest.connection.ui,
      help: manifest.connection.help,
    };
  }

  /** Replaces non-secret config; secrets follow the merge rules in `mergeSecrets`. Restarts the child. */
  async updateConnection(
    id: string,
    input: { config: Record<string, unknown>; secrets?: Record<string, string | null> },
    actor: Actor = {},
  ) {
    const row = this.row(id);
    const manifest = this.plugin(row.pluginId).parsed;
    const stored = storedSecretsFor(
      manifest,
      { config: row.config as Record<string, unknown>, secrets: this.readSecrets(row) },
      input,
    );
    const secrets = mergeSecrets(manifest, stored, input.secrets ?? {});
    const validated = validateConnection(manifest, { ...input.config, ...secrets });
    this.db.transaction((tx) => {
      tx.update(pluginInstances)
        .set({ config: validated.config, secretsEnc: this.sealSecrets(id, validated.secrets) })
        .where(eq(pluginInstances.id, id))
        .run();
      writeAudit(tx, {
        kind: 'config',
        instanceId: id,
        decision: 'connection_updated',
        actorKind: 'user',
        actorId: actor.userId,
        detail: {
          before: row.config,
          after: validated.config,
          secretsChanged: Object.keys(input.secrets ?? {}),
        },
      });
    });
    const live = this.live.get(id);
    if (live) await live.supervisor.restart();
    return this.getConnection(id);
  }

  /** "Test connection" in a throwaway child, so a candidate config never disturbs the running instance. */
  async testConnection(
    id: string,
    candidate?: { config: Record<string, unknown>; secrets?: Record<string, string | null> },
  ) {
    const row = this.row(id);
    const plugin = this.plugin(row.pluginId);
    const current = { config: row.config as Record<string, unknown>, secrets: this.readSecrets(row) };
    const stored = candidate ? storedSecretsFor(plugin.parsed, current, candidate) : current.secrets;
    const secrets = mergeSecrets(plugin.parsed, stored, candidate?.secrets ?? {});
    const validated = validateConnection(plugin.parsed, {
      ...(candidate?.config ?? current.config),
      ...secrets,
    });
    const proc = new PluginProcess({
      dir: plugin.path,
      entry: plugin.parsed.entry,
      instanceId: `${id}:test`,
      memoryMb: this.settingsOf(row).memoryMb,
      defaultTimeoutMs: this.opts.supervisor?.rpcTimeoutMs ?? 30_000,
    });
    try {
      proc.start();
      await proc.call('init', {
        instanceId: id,
        config: validated.config,
        secrets: validated.secrets,
        sdkVersion: SDK_VERSION,
      });
      return await proc.call('testConnection');
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      await proc.stop(1000);
    }
  }

  async setPluginEnabled(pluginRowId: string, enabled: boolean, actor: Actor = {}) {
    const plugin = this.pluginByAnyId(pluginRowId);
    this.db.transaction((tx) => {
      tx.update(plugins).set({ enabled }).where(eq(plugins.id, plugin.id)).run();
      writeAudit(tx, {
        kind: 'config',
        decision: enabled ? 'plugin_enabled' : 'plugin_disabled',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { pluginId: plugin.pluginId },
      });
    });
    const instances = this.db.select().from(pluginInstances).where(eq(pluginInstances.pluginId, plugin.id)).all();
    for (const i of instances) {
      if (enabled && this.isServing(i, { ...plugin, enabled })) await this.start(i.id);
      else await this.stop(i.id);
    }
  }

  /** Stops every running instance of a plugin (before its files are replaced). */
  async stopPlugin(pluginRowId: string) {
    const instances = this.db.select().from(pluginInstances).where(eq(pluginInstances.pluginId, pluginRowId)).all();
    for (const i of instances) {
      await this.stop(i.id);
      this.setStatus(i.id, 'stopped');
    }
  }

  /** Starts every servable instance of a plugin and resyncs its catalog (after an install or update). */
  async startPlugin(pluginRowId: string) {
    const plugin = this.pluginByAnyId(pluginRowId);
    const instances = this.db.select().from(pluginInstances).where(eq(pluginInstances.pluginId, plugin.id)).all();
    for (const i of instances) {
      if (!this.isServing(i, plugin)) continue;
      await this.start(i.id);
      void this.syncNow(i.id).catch(() => undefined);
    }
  }

  // ── processes ──────────────────────────────────────────────────────────────────────────────────

  async startAll() {
    for (const { instance, plugin } of this.db
      .select({ instance: pluginInstances, plugin: plugins })
      .from(pluginInstances)
      .innerJoin(plugins, eq(pluginInstances.pluginId, plugins.id))
      .all()) {
      if (this.isServing(instance, plugin)) await this.start(instance.id);
      else this.setStatus(instance.id, 'stopped');
    }
  }

  async stopAll() {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
  }

  private setStatus(instanceId: string, status: InstanceStatus, error?: string) {
    const row = this.db.select().from(pluginInstances).where(eq(pluginInstances.id, instanceId)).get();
    if (!row) return;
    this.db
      .update(pluginInstances)
      .set({ status, statusError: error ?? null })
      .where(eq(pluginInstances.id, instanceId))
      .run();
    this.opts.events.emit('instance.status', { instanceId, slug: row.slug, status, error });
  }

  private async start(instanceId: string) {
    if (this.live.has(instanceId)) return;
    const row = this.row(instanceId);
    const plugin = this.plugin(row.pluginId);
    const settings = this.settingsOf(row);
    const supervisor = new PluginSupervisor({
      dir: plugin.path,
      entry: plugin.parsed.entry,
      instanceId,
      memoryMb: settings.memoryMb,
      defaultTimeoutMs: this.opts.supervisor?.rpcTimeoutMs ?? 30_000,
      initTimeoutMs: this.opts.supervisor?.initTimeoutMs,
      backoff: this.opts.supervisor?.backoff,
      // Re-read on every (re)start so connection changes and key rotation are picked up.
      loadInit: () => {
        live.version = bundleVersion(plugin.path);
        const current = this.row(instanceId);
        return { config: current.config as Record<string, unknown>, secrets: this.readSecrets(current) };
      },
      onStatus: (status, rawError) => {
        const error = rawError === undefined ? undefined : this.scrubError(instanceId, rawError);
        this.setStatus(instanceId, status, error);
        if (status === 'error' && error) {
          const slug =
            this.db.select().from(pluginInstances).where(eq(pluginInstances.id, instanceId)).get()?.slug ?? '';
          writeAudit(this.db, {
            kind: 'plugin',
            instanceId,
            decision: 'plugin_error',
            actorKind: 'system',
            detail: { error },
          });
          this.opts.events.emit('plugin.crashed', { instanceId, slug, error });
        }
      },
      onCatalogChanged: () => this.scheduleSync(instanceId),
    });
    const live: Live = { supervisor, lastVersionCheck: 0 };
    this.live.set(instanceId, live);
    await supervisor.start();
  }

  private async stop(instanceId: string) {
    const live = this.live.get(instanceId);
    if (!live) return;
    this.live.delete(instanceId);
    clearTimeout(live.catalogChangedTimer);
    await live.supervisor.stop();
  }

  // ── sync scheduling (design §10) ───────────────────────────────────────────────────────────────

  private scheduleSync(instanceId: string, delayMs = 2000) {
    const live = this.live.get(instanceId);
    if (!live) return;
    clearTimeout(live.catalogChangedTimer);
    live.catalogChangedTimer = setTimeout(() => void this.syncNow(instanceId).catch(() => undefined), delayMs);
  }

  /** Full catalog (+ registry) sync. Concurrent callers share one run (per-instance mutex). */
  syncNow(instanceId: string): Promise<SyncSummary> {
    const live = this.live.get(instanceId);
    if (!live) return Promise.reject(new PluginUnavailableError('The endpoint is not running'));
    if (live.syncing) return live.syncing;
    const run = (async () => {
      const row = this.row(instanceId);
      try {
        const client = live.supervisor.client;
        const manifest = this.plugin(row.pluginId).parsed;
        // The child that answers is the one whose version counts, not the plugin row's.
        const version = live.version;
        const summary = applyCatalogSync(this.db, instanceId, await client.call('syncCatalog'), this.now(), manifest);
        this.db
          .update(pluginInstances)
          .set({ catalogPluginVersion: live.version === version ? (version ?? null) : null })
          .where(eq(pluginInstances.id, instanceId))
          .run();
        if (manifest.capabilities.registry) {
          applyRegistrySync(this.db, instanceId, await client.call('syncRegistry'), this.now());
        }
        live.lastVersionCheck = Date.now();
        if (this.row(instanceId).status === 'error' && live.supervisor.status === 'ready')
          this.setStatus(instanceId, 'ready');
        this.opts.events.emit('sync.completed', {
          instanceId,
          slug: row.slug,
          added: summary.added,
          pendingReview: summary.pendingReview,
          newGroups: summary.newGroups,
          rulesDisabled: summary.rulesDisabled,
        });
        return summary;
      } catch (err) {
        const message = this.scrubError(instanceId, err instanceof Error ? err.message : String(err));
        this.db
          .update(pluginInstances)
          .set({ lastSyncStatus: `error: ${message}`.slice(0, 500) })
          .where(eq(pluginInstances.id, instanceId))
          .run();
        writeAudit(this.db, {
          kind: 'plugin',
          instanceId,
          decision: 'catalog_sync_failed',
          actorKind: 'system',
          detail: { error: message },
        });
        this.opts.events.emit('sync.failed', { instanceId, slug: row.slug, error: message });
        // Without any catalog the endpoint can't serve at all: show that, not a misleading "ready".
        if (!row.lastSyncedAt && live.supervisor.status === 'ready')
          this.setStatus(instanceId, 'error', `First catalog sync failed: ${message}`.slice(0, 500));
        throw err;
      } finally {
        live.syncing = undefined;
      }
    })();
    live.syncing = run;
    return run;
  }

  /** Before serving MCP traffic: sync now if never synced or synced from other code (failure refuses
   * service), sync if stale (serving the last catalog on failure), else sync on an upstream version change. */
  async ensureFresh(instanceId: string, opts: { forceVersionCheck?: boolean } = {}): Promise<void> {
    const row = this.row(instanceId);
    const live = this.live.get(instanceId);
    if (!live || live.supervisor.status !== 'ready') throw new PluginUnavailableError('The endpoint is not ready');
    if (!row.lastSyncedAt || !live.version || row.catalogPluginVersion !== live.version) {
      await this.syncNow(instanceId);
      return;
    }
    const settings = this.settingsOf(row);
    if (Date.now() - row.lastSyncedAt.getTime() > settings.syncMaxAgeMs) {
      await this.syncNow(instanceId).catch(() => undefined);
      return;
    }
    const interval = opts.forceVersionCheck ? 60_000 : (this.opts.versionCheckIntervalMs ?? 30 * 60_000);
    if (Date.now() - live.lastVersionCheck < interval) return;
    live.lastVersionCheck = Date.now();
    try {
      const version = await live.supervisor.client.call('getUpstreamVersion');
      if (version !== row.upstreamVersion) await this.syncNow(instanceId).catch(() => undefined);
    } catch {
      // Upstream unreachable: keep serving the last catalog; calls will surface their own errors.
    }
  }

  /** Daily backstop (design §10): sync anything that hasn't synced in 24 h. */
  async syncStale(maxAgeMs = 24 * 60 * 60_000) {
    for (const [id, live] of this.live) {
      if (live.supervisor.status !== 'ready') continue;
      const row = this.db.select().from(pluginInstances).where(eq(pluginInstances.id, id)).get();
      if (!row?.lastSyncedAt || Date.now() - row.lastSyncedAt.getTime() > maxAgeMs) {
        await this.syncNow(id).catch(() => undefined);
      }
    }
  }
}
