import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isSdkCompatible } from '@synoikia/plugin-sdk';
import { asc, eq } from 'drizzle-orm';
import semver from 'semver';
import * as tar from 'tar';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import type { Db } from '../db/index.js';
import { pluginInstances, pluginRepos, plugins, settings } from '../db/schema.js';
import { ConflictError, NotFoundError, ServiceError, ValidationError } from '../errors.js';
import { CORE_VERSION } from '../version.js';
import { inspectPluginDir } from './discovery.js';
import { MinisignError, parsePublicKey, verifySignature } from './minisign.js';

/** Plugin repositories and installs (design §4.2–4.3): explicit installs of pinned versions, verified by
 * sha256 and, for signed repos, a minisign signature from the admin-pinned key. */

const LIMITS = {
  indexBytes: 2 * 1024 * 1024,
  tarballBytes: 50 * 1024 * 1024,
  extractedBytes: 200 * 1024 * 1024,
  entries: 5000,
};

const VersionSchema = z.object({
  version: z.string().refine((v) => semver.valid(v) !== null, 'must be a semver version'),
  sdk: z.string().refine((v) => semver.validRange(v) !== null, 'must be a semver range'),
  minCoreVersion: z.string().optional(),
  url: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i, 'must be a hex sha256'),
  signature: z.string().optional(),
});

export const IndexSchema = z.object({
  schema: z.literal(1),
  name: z.string().max(200),
  homepage: z.string().optional(),
  publicKey: z.string().optional(),
  plugins: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
        name: z.string().max(200),
        description: z.string().max(2000).optional(),
        versions: z.array(VersionSchema).min(1),
      }),
    )
    .max(500),
});
export type RepoIndex = z.infer<typeof IndexSchema>;

const AddRepoSchema = z.object({
  url: z.url(),
  signingMode: z.enum(['signed', 'unsigned']),
  /** The full public key (`RW…`) as advertised out of band; a key id alone could be reused by another key. */
  confirmPublicKey: z.string().optional(),
});

export const InstallSchema = z.object({
  repoId: z.string(),
  pluginId: z.string(),
  version: z.string(),
  /** Unsigned repos: must equal the plugin id. */
  confirm: z.string().optional(),
});

const MAX_REDIRECTS = 5;

/** `settings` row recording that the pre-configured repository was added once. */
const DEFAULT_REPO_MARKER = 'plugin_repos.preconfigured';

export type FetchBytes = (url: string, init?: { signal?: AbortSignal; redirect?: 'manual' }) => Promise<Response>;

type RepoRow = typeof pluginRepos.$inferSelect;
type Actor = { userId?: string };

export interface RepoServiceOptions {
  db: Db;
  dataDir: string;
  fetch?: FetchBytes;
  /** Only for tests and lab mirrors: allow http:// index and tarball URLs. */
  allowHttp?: boolean;
  now?: () => Date;
  /** Re-scan plugin directories into the registry. */
  discover: () => unknown;
  /** Stop every instance of a plugin row before its files change. */
  stopPlugin: (pluginRowId: string) => Promise<void>;
  /** Start (and resync) every servable instance of a plugin row. */
  startPlugin: (pluginRowId: string) => Promise<void>;
}

/** The parts of a manifest that change what a plugin may do; an update touching them needs review. */
function permissionChanges(before: unknown, after: unknown): string[] {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const pick: Record<string, (m: Record<string, unknown>) => unknown> = {
    binding: (m) => m.binding,
    capabilities: (m) => m.capabilities,
    sensitiveKeys: (m) => [...((m.sensitiveKeys as string[] | undefined) ?? [])].sort(),
    'network.hosts': (m) => [...(((m.network as { hosts?: string[] } | undefined)?.hosts ?? []) as string[])].sort(),
  };
  return Object.entries(pick)
    .filter(([, get]) => canonical(get(b)) !== canonical(get(a)))
    .map(([name]) => name);
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => p.localeCompare(q)))
      : x,
  ) ?? 'null';

/** Swaps `next` in for `target`, restoring the previous copy if the move fails. */
export function swapDirectory(
  next: string,
  target: string,
  backup: string,
  rename: (from: string, to: string) => void = renameSync,
) {
  const hadOld = existsSync(target);
  if (hadOld) rename(target, backup);
  try {
    rename(next, target);
  } catch (err) {
    if (hadOld) rename(backup, target);
    throw err;
  }
  rmSync(backup, { recursive: true, force: true });
}

export class PluginRepoService {
  private readonly installing = new Set<string>();

  constructor(private readonly opts: RepoServiceOptions) {}

  private get db() {
    return this.opts.db;
  }
  private now() {
    return this.opts.now?.() ?? new Date();
  }

  // ── fetching ──

  private checkUrl(raw: string, base?: string): string {
    let url: URL;
    try {
      url = new URL(raw, base);
    } catch {
      throw new ValidationError('invalid_url', `Not a URL: ${raw}`);
    }
    if (url.protocol !== 'https:' && !(this.opts.allowHttp && url.protocol === 'http:')) {
      throw new ValidationError('insecure_url', `Only https:// URLs are allowed (${url.origin})`);
    }
    return url.toString();
  }

  private async download(url: string, max: number): Promise<Buffer> {
    const doFetch: FetchBytes = this.opts.fetch ?? ((u, init) => fetch(u, init));
    const signal = AbortSignal.timeout(60_000);
    let res: Response;
    // Redirects are followed by hand, so every hop passes the same URL check (no https → http downgrade).
    for (let hop = 0; ; hop++) {
      try {
        res = await doFetch(url, { signal, redirect: 'manual' });
      } catch (err) {
        throw new ServiceError(
          400,
          'fetch_failed',
          `Could not fetch ${url}: ${err instanceof Error ? err.message : err}`,
        );
      }
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      if (hop >= MAX_REDIRECTS) throw new ServiceError(400, 'fetch_failed', `Too many redirects from ${url}`);
      await res.body?.cancel().catch(() => undefined);
      url = this.checkUrl(location, url);
    }
    if (!res.ok) throw new ServiceError(400, 'fetch_failed', `Could not fetch ${url}: HTTP ${res.status}`);
    if (Number(res.headers.get('content-length') ?? 0) > max)
      throw new ValidationError('too_large', `${url} is too large`);
    const chunks: Buffer[] = [];
    let size = 0;
    if (res.body) {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > max) throw new ValidationError('too_large', `${url} is too large`);
        chunks.push(Buffer.from(chunk));
      }
    }
    return Buffer.concat(chunks);
  }

  private async fetchIndex(url: string): Promise<RepoIndex> {
    const bytes = await this.download(url, LIMITS.indexBytes);
    let json: unknown;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new ValidationError('invalid_index', 'index.json is not valid JSON');
    }
    const parsed = IndexSchema.safeParse(json);
    if (!parsed.success) {
      throw new ValidationError(
        'invalid_index',
        'index.json does not match the repository schema',
        parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    }
    return parsed.data;
  }

  private keyOf(index: RepoIndex) {
    if (!index.publicKey)
      throw new ValidationError(
        'no_public_key',
        'This repository publishes no publicKey, so it cannot be added as signed',
      );
    try {
      return parsePublicKey(index.publicKey);
    } catch (err) {
      throw new ValidationError('invalid_public_key', (err as Error).message);
    }
  }

  // ── repositories ──

  private repoRow(id: string): RepoRow {
    const row = this.db.select().from(pluginRepos).where(eq(pluginRepos.id, id)).get();
    if (!row) throw new NotFoundError('repo_not_found', 'No such repository');
    return row;
  }

  private publicRepo(row: RepoRow) {
    const index = row.indexCache as RepoIndex | null;
    const offered = index?.publicKey && row.signingMode === 'signed' ? safeKey(index.publicKey) : null;
    return {
      id: row.id,
      url: row.url,
      name: row.name,
      signingMode: row.signingMode,
      publicKey: row.publicKey,
      keyId: row.keyFingerprint,
      keyStatus: row.keyStatus,
      /** When the key changed: the new key awaiting confirmation. */
      offeredKey:
        row.keyStatus === 'key_changed' && offered ? { publicKey: offered.base64, keyId: offered.keyId } : null,
      pluginCount: index?.plugins.length ?? 0,
      lastFetchedAt: row.lastFetchedAt,
      lastFetchError: row.lastFetchError,
    };
  }

  list() {
    return this.db
      .select()
      .from(pluginRepos)
      .orderBy(asc(pluginRepos.url))
      .all()
      .map((r) => this.publicRepo(r));
  }

  /** Adds a repository; a signed one answers 409 `confirm_key` until repeated with `confirmPublicKey`. */
  async add(raw: unknown, actor: Actor = {}) {
    const input = AddRepoSchema.parse(raw);
    const url = this.checkUrl(input.url);
    if (this.db.select().from(pluginRepos).where(eq(pluginRepos.url, url)).get()) {
      throw new ConflictError('repo_exists', 'This repository is already added');
    }
    const index = await this.fetchIndex(url);
    let key: ReturnType<typeof parsePublicKey> | undefined;
    if (input.signingMode === 'signed') {
      key = this.keyOf(index);
      if (!sameKey(input.confirmPublicKey, key.base64)) {
        throw new ConflictError('confirm_key', `Confirm the repository public key ${key.base64}`, {
          publicKey: key.base64,
          keyId: key.keyId,
          name: index.name,
        });
      }
    }
    const id = randomUUID();
    this.db.transaction((tx) => {
      tx.insert(pluginRepos)
        .values({
          id,
          url,
          name: index.name,
          signingMode: input.signingMode,
          publicKey: key?.base64 ?? null,
          keyFingerprint: key?.keyId ?? null,
          keyStatus: 'ok',
          indexCache: index,
          lastFetchedAt: this.now(),
        })
        .run();
      writeAudit(tx, {
        kind: 'config',
        decision: 'plugin_repo_added',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { id, url, name: index.name, signingMode: input.signingMode, keyId: key?.keyId ?? null },
      });
    });
    return this.publicRepo(this.repoRow(id));
  }

  /** Adds a signed repo whose key ships with core, once per `marker`, so a removed repo stays removed. */
  addPreconfigured(repo: { url: string; name: string; publicKey: string }, marker = DEFAULT_REPO_MARKER) {
    if (this.db.select().from(settings).where(eq(settings.key, marker)).get()) return null;
    const url = this.checkUrl(repo.url);
    const key = parsePublicKey(repo.publicKey);
    const exists = this.db.select().from(pluginRepos).where(eq(pluginRepos.url, url)).get();
    const id = randomUUID();
    this.db.transaction((tx) => {
      tx.insert(settings)
        .values({ key: marker, value: { url, addedAt: this.now().toISOString() } })
        .run();
      if (exists) return;
      tx.insert(pluginRepos)
        .values({
          id,
          url,
          name: repo.name,
          signingMode: 'signed',
          publicKey: key.base64,
          keyFingerprint: key.keyId,
          keyStatus: 'ok',
        })
        .run();
      writeAudit(tx, {
        kind: 'config',
        decision: 'plugin_repo_added',
        actorKind: 'system',
        detail: { id, url, name: repo.name, signingMode: 'signed', keyId: key.keyId, preconfigured: true },
      });
    });
    return exists ? null : this.publicRepo(this.repoRow(id));
  }

  /** Re-reads the index. A changed signing key blocks installs until re-confirmed. */
  async refresh(id: string) {
    const row = this.repoRow(id);
    try {
      const index = await this.fetchIndex(row.url);
      let keyStatus = row.keyStatus;
      if (row.signingMode === 'signed') {
        const offered = index.publicKey ? safeKey(index.publicKey) : null;
        const changed = offered?.base64 !== row.publicKey;
        if (changed && keyStatus !== 'key_changed') {
          keyStatus = 'key_changed';
          writeAudit(this.db, {
            kind: 'config',
            decision: 'plugin_repo_key_changed',
            actorKind: 'system',
            detail: { id, url: row.url, pinned: row.keyFingerprint, offered: offered?.keyId ?? null },
          });
        } else if (!changed) keyStatus = 'ok';
      }
      this.db
        .update(pluginRepos)
        .set({ indexCache: index, name: index.name, keyStatus, lastFetchedAt: this.now(), lastFetchError: null })
        .where(eq(pluginRepos.id, id))
        .run();
    } catch (err) {
      this.db
        .update(pluginRepos)
        .set({
          lastFetchError: (err instanceof Error ? err.message : String(err)).slice(0, 300),
          lastFetchedAt: this.now(),
        })
        .where(eq(pluginRepos.id, id))
        .run();
      throw err;
    }
    return this.publicRepo(this.repoRow(id));
  }

  /** Daily refresh (design §10); failed repos retry hourly, and failures are recorded, never thrown. */
  async refreshStale(maxAgeMs = 24 * 60 * 60_000) {
    for (const row of this.db.select().from(pluginRepos).all()) {
      const fresh = row.lastFetchedAt && this.now().getTime() - row.lastFetchedAt.getTime() < maxAgeMs;
      if (fresh && !row.lastFetchError) continue;
      await this.refresh(row.id).catch(() => undefined);
    }
  }

  /** Pins the key a refreshed index now offers, after the admin checked it against the publisher's. */
  confirmKey(id: string, publicKey: string, actor: Actor = {}) {
    const row = this.repoRow(id);
    if (row.signingMode !== 'signed') throw new ValidationError('not_signed', 'This repository is unsigned');
    const index = row.indexCache as RepoIndex;
    const key = this.keyOf(index);
    if (!sameKey(publicKey, key.base64)) {
      throw new ConflictError('confirm_key', `Confirm the repository public key ${key.base64}`, {
        publicKey: key.base64,
        keyId: key.keyId,
      });
    }
    this.db.transaction((tx) => {
      tx.update(pluginRepos)
        .set({ publicKey: key.base64, keyFingerprint: key.keyId, keyStatus: 'ok' })
        .where(eq(pluginRepos.id, id))
        .run();
      writeAudit(tx, {
        kind: 'config',
        decision: 'plugin_repo_key_confirmed',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { id, url: row.url, previous: row.keyFingerprint, keyId: key.keyId },
      });
    });
    return this.publicRepo(this.repoRow(id));
  }

  remove(id: string, actor: Actor = {}) {
    const row = this.repoRow(id);
    const installed = this.db.select().from(plugins).where(eq(plugins.repoId, id)).all();
    if (installed.length) {
      throw new ConflictError('repo_in_use', 'Uninstall the plugins installed from this repository first', {
        plugins: installed.map((p) => p.pluginId),
      });
    }
    this.db.transaction((tx) => {
      tx.delete(pluginRepos).where(eq(pluginRepos.id, id)).run();
      writeAudit(tx, {
        kind: 'config',
        decision: 'plugin_repo_removed',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { id, url: row.url },
      });
    });
  }

  /** Every plugin offered by every repo, with install/update state. */
  available() {
    const installed = new Map(
      this.db
        .select()
        .from(plugins)
        .all()
        .map((p) => [p.pluginId, p]),
    );
    const out = [];
    for (const repo of this.db.select().from(pluginRepos).orderBy(asc(pluginRepos.url)).all()) {
      const index = repo.indexCache as RepoIndex | null;
      for (const p of index?.plugins ?? []) {
        const compatible = p.versions
          .filter((v) => isSdkCompatible(v) && (!v.minCoreVersion || semver.gte(CORE_VERSION, v.minCoreVersion)))
          .map((v) => v.version);
        const latest = semver.rsort([...compatible])[0] ?? null;
        const current = installed.get(p.id);
        const fromHere = !!current && current.repoId === repo.id;
        out.push({
          repoId: repo.id,
          repoName: repo.name,
          signingMode: repo.signingMode,
          pluginId: p.id,
          name: p.name,
          description: p.description ?? null,
          versions: p.versions.map((v) => ({ version: v.version, compatible: compatible.includes(v.version) })),
          latest,
          installed: current ? { version: current.version, fromThisRepo: fromHere, managed: !!current.repoId } : null,
          updateAvailable: !!(fromHere && latest && semver.gt(latest, current.version)),
          blocked:
            current?.repoId && !fromHere
              ? 'installed_from_elsewhere'
              : repo.keyStatus === 'key_changed'
                ? 'key_changed'
                : null,
        });
      }
    }
    return out;
  }

  // ── install / uninstall ──

  private get pluginsDir() {
    return path.join(this.opts.dataDir, 'plugins');
  }
  private get stagingDir() {
    return path.join(this.opts.dataDir, 'plugins-staging');
  }

  /** Extracts regular files and directories only; links, devices and escaping paths fail the install. */
  private async extract(tarball: Buffer, into: string) {
    mkdirSync(into, { recursive: true });
    let entries = 0;
    let bytes = 0;
    const problems: string[] = [];
    await pipeline(
      Readable.from([tarball]),
      tar.x({
        cwd: into,
        strict: true,
        preserveOwner: false,
        noMtime: true,
        filter: (p, entry) => {
          const type = 'type' in entry ? entry.type : 'File';
          const size = 'size' in entry ? Number(entry.size) : 0;
          entries++;
          bytes += size;
          if (type !== 'File' && type !== 'OldFile' && type !== 'Directory') {
            problems.push(`${p}: ${type} entries are not allowed`);
            return false;
          }
          if (entries > LIMITS.entries || bytes > LIMITS.extractedBytes) {
            problems.push('archive is too large');
            return false;
          }
          return true;
        },
      }),
    ).catch((err: unknown) => {
      throw new ValidationError(
        'invalid_archive',
        `Could not extract the archive: ${err instanceof Error ? err.message : err}`,
      );
    });
    if (problems.length) throw new ValidationError('invalid_archive', problems[0]!, problems.slice(0, 20));
    // Accept both a flat archive and npm-pack style (a single top-level directory, e.g. `package/`).
    if (existsSync(path.join(into, 'manifest.json'))) return into;
    const top = readdirSync(into);
    if (
      top.length === 1 &&
      statSync(path.join(into, top[0]!)).isDirectory() &&
      existsSync(path.join(into, top[0]!, 'manifest.json'))
    ) {
      return path.join(into, top[0]!);
    }
    throw new ValidationError('invalid_archive', 'The archive has no manifest.json at its root');
  }

  async install(raw: unknown, actor: Actor = {}) {
    const input = InstallSchema.parse(raw);
    if (this.installing.has(input.pluginId)) {
      throw new ConflictError('install_in_progress', `"${input.pluginId}" is already being installed`);
    }
    this.installing.add(input.pluginId);
    try {
      return await this.installLocked(input, actor);
    } finally {
      this.installing.delete(input.pluginId);
    }
  }

  private async installLocked(input: z.infer<typeof InstallSchema>, actor: Actor) {
    const repo = this.repoRow(input.repoId);
    if (repo.keyStatus === 'key_changed') {
      throw new ConflictError(
        'key_changed',
        'The repository signing key changed; confirm the new key before installing',
      );
    }
    const index = repo.indexCache as RepoIndex | null;
    const entry = index?.plugins.find((p) => p.id === input.pluginId);
    const version = entry?.versions.find((v) => v.version === input.version);
    if (!entry || !version)
      throw new NotFoundError('version_not_found', `${input.pluginId}@${input.version} is not in this repository`);
    if (!isSdkCompatible(version)) {
      throw new ConflictError('incompatible', `${input.pluginId}@${input.version} needs plugin SDK ${version.sdk}`);
    }
    if (version.minCoreVersion && !semver.gte(CORE_VERSION, version.minCoreVersion)) {
      throw new ConflictError(
        'incompatible',
        `${input.pluginId}@${input.version} needs core ${version.minCoreVersion} or newer`,
      );
    }
    const current = this.db.select().from(plugins).where(eq(plugins.pluginId, input.pluginId)).get();
    if (current?.repoId && current.repoId !== repo.id) {
      throw new ConflictError(
        'installed_from_elsewhere',
        `"${input.pluginId}" is installed from another repository; uninstall it first`,
      );
    }
    // A plugin no repository manages (a built-in plugin from before 0.3.0, or one copied in by hand) is
    // adopted: this install replaces its files and keeps its row, so its endpoints carry over.
    const adopting = !!current && !current.repoId;
    if (repo.signingMode === 'unsigned' && input.confirm !== input.pluginId) {
      throw new ConflictError(
        'confirm_required',
        `This repository is unsigned. Type "${input.pluginId}" to install anyway`,
      );
    }

    const tarballUrl = this.checkUrl(version.url, repo.url);
    const tarball = await this.download(tarballUrl, LIMITS.tarballBytes);
    const sha256 = createHash('sha256').update(tarball).digest('hex');
    if (sha256 !== version.sha256.toLowerCase()) {
      throw new ValidationError('checksum_mismatch', 'The download does not match the sha256 in the index');
    }
    let signatureVerified = false;
    if (repo.signingMode === 'signed') {
      if (!version.signature)
        throw new ValidationError('signature_missing', 'The index has no signature for this version');
      try {
        verifySignature(tarball, version.signature, parsePublicKey(repo.publicKey!));
      } catch (err) {
        if (err instanceof MinisignError) throw new ValidationError('signature_invalid', err.message);
        throw err;
      }
      signatureVerified = true;
    }

    const work = path.join(this.stagingDir, randomUUID());
    try {
      const root = await this.extract(tarball, work);
      const inspected = inspectPluginDir(root);
      if (inspected.status !== 'ok') throw new ValidationError('invalid_plugin', inspected.error);
      if (inspected.manifest.id !== input.pluginId || inspected.manifest.version !== input.version) {
        throw new ValidationError(
          'manifest_mismatch',
          `The archive contains ${inspected.manifest.id}@${inspected.manifest.version}, not ${input.pluginId}@${input.version}`,
        );
      }

      // Swap directories with instances stopped, then let discovery update the registry row.
      if (current) await this.opts.stopPlugin(current.id);
      mkdirSync(this.pluginsDir, { recursive: true });
      const target = path.join(this.pluginsDir, input.pluginId);
      try {
        swapDirectory(root, target, path.join(this.stagingDir, `${randomUUID()}-old`));
      } catch (err) {
        // The old version is back in place: bring its instances back up before reporting the failure.
        if (current) await this.opts.startPlugin(current.id);
        throw err;
      }
      this.opts.discover();

      const row = this.db.select().from(plugins).where(eq(plugins.pluginId, input.pluginId)).get()!;
      // New installs start disabled, and an update that changes what the plugin may do is disabled
      // again: enabling it is the admin's review of its binding, capabilities and hosts (design §4.2).
      const review = current ? permissionChanges(current.manifest, inspected.manifest) : [];
      // Adopted code comes from a new source, so it waits for the admin's review like a new install.
      const enabled = current && !adopting ? current.enabled && review.length === 0 : false;
      this.db.transaction((tx) => {
        tx.update(plugins)
          .set({ repoId: repo.id, sha256, signatureVerified, enabled })
          .where(eq(plugins.id, row.id))
          .run();
        writeAudit(tx, {
          kind: 'config',
          decision: adopting ? 'plugin_adopted' : current ? 'plugin_updated' : 'plugin_installed',
          actorKind: 'user',
          actorId: actor.userId,
          detail: {
            pluginId: input.pluginId,
            version: input.version,
            previousVersion: current?.version ?? null,
            repo: repo.url,
            sha256,
            signatureVerified,
            enabled,
            ...(review.length ? { needsReview: review } : {}),
          },
        });
      });
      if (enabled) await this.opts.startPlugin(row.id);
      return this.db.select().from(plugins).where(eq(plugins.id, row.id)).get()!;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** Removes an installed plugin. Blocked while any instance uses it. */
  uninstall(pluginRowOrId: string, actor: Actor = {}) {
    const row =
      this.db.select().from(plugins).where(eq(plugins.id, pluginRowOrId)).get() ??
      this.db.select().from(plugins).where(eq(plugins.pluginId, pluginRowOrId)).get();
    if (!row) throw new NotFoundError('plugin_not_found', 'No such plugin');
    const instances = this.db.select().from(pluginInstances).where(eq(pluginInstances.pluginId, row.id)).all();
    if (instances.length) {
      throw new ConflictError('plugin_has_instances', 'Delete this plugin’s endpoints first', {
        instances: instances.map((i) => i.slug),
      });
    }
    // Only ever delete inside DATA_DIR/plugins.
    const dir = path.resolve(row.path);
    if (dir.startsWith(path.resolve(this.pluginsDir) + path.sep)) rmSync(dir, { recursive: true, force: true });
    this.db.transaction((tx) => {
      tx.delete(plugins).where(eq(plugins.id, row.id)).run();
      writeAudit(tx, {
        kind: 'config',
        decision: 'plugin_uninstalled',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { pluginId: row.pluginId, version: row.version },
      });
    });
  }
}

function sameKey(submitted: string | undefined, expected: string) {
  const key = submitted ? safeKey(submitted) : null;
  return !!key && key.base64 === expected;
}

function safeKey(publicKey: string) {
  try {
    return parsePublicKey(publicKey);
  } catch {
    return null;
  }
}
