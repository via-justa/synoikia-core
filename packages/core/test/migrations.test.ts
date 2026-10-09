import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAccess } from '../src/catalog/groups.js';
import { openDatabase } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** A database migrated only up to (and including) `lastTag`, as an older release left it. */
function databaseAt(lastTag: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'synoikia-migrate-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const partial = path.join(dir, 'migrations');
  cpSync(MIGRATIONS, partial, { recursive: true });
  const journalFile = path.join(partial, 'meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as { entries: { tag: string }[] };
  journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === lastTag) + 1);
  writeFileSync(journalFile, JSON.stringify(journal));

  const sqlite = new Database(path.join(dir, 'synoikia.sqlite'));
  migrate(drizzle(sqlite, { schema }), { migrationsFolder: partial });
  return { dir, sqlite };
}

describe('0002 access levels migration', () => {
  it('keeps what was reachable, and nothing starts running without approval', () => {
    const { dir, sqlite } = databaseAt('0001_totp_last_step');
    const now = Date.now();
    sqlite.exec(`
      INSERT INTO users (id, username) VALUES ('u1', 'admin');
      INSERT INTO plugins (id, plugin_id, version, source, path, manifest, status)
        VALUES ('p1', 'echo', '1.0.0', 'core', '/x', '{}', 'ok');
      INSERT INTO plugin_instances (id, plugin_id, slug, display_name) VALUES ('i1', 'p1', 'nas', 'NAS');
      INSERT INTO operation_groups (id, instance_id, key, label, level, first_seen_at) VALUES
        ('gw', 'i1', 'app', 'Apps', 'write', ${now}),
        ('gr', 'i1', 'store', 'Stores', 'read', ${now});
      INSERT INTO operations (id, instance_id, key, kind, plugin_group, group_id, classification, classification_source,
          inferred_classification, inferred_reason, locked, excluded, locked_opt_in, write_acknowledged,
          first_seen_at, last_seen_at) VALUES
        ('o1', 'i1', 'app.upgrade', 'method', 'app', 'gw', 'write', 'inferred', 'write', 'x', 0, 0, 0, 1, ${now}, ${now}),
        ('o2', 'i1', 'app.stop', 'method', 'app', 'gw', 'write', 'inferred', 'write', 'x', 0, 1, 0, 1, ${now}, ${now}),
        ('o3', 'i1', 'app.delete', 'method', 'app', 'gw', 'write', 'locked', 'write', 'x', 1, 0, 1, 1, ${now}, ${now}),
        ('o4', 'i1', 'store.export', 'method', 'store', 'gr', 'write', 'locked', 'write', 'x', 1, 0, 1, 1, ${now}, ${now}),
        ('o5', 'i1', 'store.query', 'method', 'store', 'gr', 'read', 'inferred', 'read', 'x', 0, 0, 0, 0, ${now}, ${now});
      INSERT INTO mcp_tokens (id, name, token_hash, scope) VALUES ('t1', 'old', 'h', '["*"]');
      INSERT INTO oauth_clients (id, client_id, name, redirect_uris, registered_via)
        VALUES ('c1', 'cid', 'Claude', '[]', 'dcr');
      INSERT INTO oauth_grants (id, client_id, user_id, resources) VALUES ('g1', 'c1', 'u1', '[]');
      INSERT INTO pending_approvals (id, instance_id, operation_id, params_hash, summary, requested_at, expires_at,
          status, decided_via) VALUES ('a1', 'i1', 'o1', 'h', 's', ${now}, ${now}, 'approved', 'portal');
    `);
    sqlite.close();

    const db = openDatabase({ dataDir: dir });
    cleanup.unshift(() => db.$client.close());
    const access = (key: string) => resolveAccess(db, 'i1', key);

    // The old `write` level asked for every write: it is `ask` now, not auto-approval.
    expect(
      db
        .select()
        .from(schema.operationGroups)
        .all()
        .map((g) => [g.key, g.level]),
    ).toEqual([
      ['app', 'ask'],
      ['store', 'read'],
    ]);
    expect(access('app.upgrade')).toEqual({ reachable: true, mode: 'approve', level: 'ask' });
    // Exclusions become an explicit None.
    expect(access('app.stop')).toEqual({ reachable: false, reason: 'level_none' });
    // An opted-in locked op stays callable (with approval) where it was: in a group that was at write.
    expect(access('app.delete')).toEqual({ reachable: true, mode: 'approve', level: 'ask' });
    // Its opt-in did nothing in a read-only group, so it isn't opened now either.
    expect(access('store.export')).toEqual({ reachable: false, reason: 'locked_not_opted_in' });
    expect(access('store.query')).toMatchObject({ reachable: true, mode: 'run' });

    // Credentials issued before ceilings existed keep their reach.
    expect(db.select().from(schema.mcpTokens).get()?.access).toBe('write');
    expect(db.select().from(schema.oauthGrants).get()?.access).toBe('write');
    expect(db.select().from(schema.pendingApprovals).get()?.decidedVia).toBe('url');
  });
});

describe('grant instance binding backfill', () => {
  it('maps each resource of an old grant to the instance that has its slug now', async () => {
    const { OAuthService } = await import('../src/auth/oauth.js');
    const { seedInstance } = await import('./helpers.js');
    const { db, instanceId } = seedInstance(openDatabase(':memory:'), 'nas');
    db.insert(schema.users).values({ id: 'u1', username: 'admin' }).run();
    db.insert(schema.oauthClients)
      .values({ id: 'c1', clientId: 'cid', name: 'x', redirectUris: [], registeredVia: 'dcr' })
      .run();
    db.insert(schema.oauthGrants)
      .values({
        id: 'g1',
        clientId: 'c1',
        userId: 'u1',
        resources: ['https://mcp.example/nas', 'https://mcp.example/gone'],
      })
      .run();
    // PUBLIC_MCP_URL with a path: the slug is still the last segment.
    db.insert(schema.oauthGrants)
      .values({ id: 'g2', clientId: 'c1', userId: 'u1', resources: ['https://example.com/mcp/nas'] })
      .run();
    const oauth = new OAuthService(db);
    expect(oauth.backfillInstanceIds([{ id: instanceId, slug: 'nas' }])).toBe(2);
    const ids = (id: string) =>
      db.select().from(schema.oauthGrants).where(eq(schema.oauthGrants.id, id)).get()?.instanceIds;
    expect(ids('g1')).toEqual([instanceId, '']);
    expect(ids('g2')).toEqual([instanceId]);
    expect(oauth.backfillInstanceIds([{ id: instanceId, slug: 'nas' }])).toBe(0); // only once
  });
});

describe('registry scopes migration', () => {
  it("moves each entry's domain into its scopes", () => {
    const { dir, sqlite } = databaseAt('0006_attestation_waived');
    const now = Date.now();
    sqlite.exec(`
      INSERT INTO plugins (id, plugin_id, version, source, path, manifest, status)
        VALUES ('p1', 'echo', '1.0.0', 'core', '/x', '{}', 'ok');
      INSERT INTO plugin_instances (id, plugin_id, slug, display_name) VALUES ('i1', 'p1', 'acme', 'Acme');
      INSERT INTO registry_entries (id, instance_id, kind, ext_id, name, domain, last_synced_at) VALUES
        ('r1', 'i1', 'item', 'widget.one', 'Widget One', 'widget', ${now}),
        ('r2', 'i1', 'zone', 'zone_a', 'Zone A', NULL, ${now});
    `);
    sqlite.close();

    const db = openDatabase({ dataDir: dir });
    const scopes = (id: string) =>
      db.select().from(schema.registryEntries).where(eq(schema.registryEntries.id, id)).get()?.scopes;
    expect(scopes('r1')).toEqual({ domain: 'widget' });
    expect(scopes('r2')).toBeNull();
  });
});

describe('plugin source migration', () => {
  it('drops the source column and keeps every plugin and its instances', () => {
    const { dir, sqlite } = databaseAt('0008_drop_registry_domain');
    sqlite.exec(`
      INSERT INTO plugins (id, plugin_id, version, source, path, manifest, status)
        VALUES ('p1', 'echo', '1.0.0', 'core', '/x', '{}', 'ok'), ('p2', 'other', '1.0.0', 'repo', '/y', '{}', 'ok');
      INSERT INTO plugin_instances (id, plugin_id, slug, display_name) VALUES ('i1', 'p1', 'acme', 'Acme');
    `);
    sqlite.close();

    const db = openDatabase({ dataDir: dir });
    expect(
      db
        .select()
        .from(schema.plugins)
        .all()
        .map((p) => p.pluginId),
    ).toEqual(['echo', 'other']);
    expect(db.select().from(schema.pluginInstances).get()).toMatchObject({ id: 'i1', pluginId: 'p1' });
  });
});

describe('0010 access by kind migration', () => {
  it('fits own levels to each kind and drops classification overrides, without widening anything', () => {
    const { dir, sqlite } = databaseAt('0009_drop_plugin_source');
    const now = Date.now();
    const row = (
      id: string,
      key: string,
      group: string,
      cls: string,
      source: string,
      inferred: string,
      locked: number,
      level: string | null,
    ) =>
      `('${id}', 'i1', '${key}', 'method', 'g', '${group}', '${cls}', '${source}', '${inferred}', 'x', ${locked}, ${level === null ? 'NULL' : `'${level}'`}, 1, ${now}, ${now})`;
    sqlite.exec(`
      INSERT INTO plugins (id, plugin_id, version, path, manifest, status) VALUES ('p1', 'echo', '1.0.0', '/x', '{}', 'ok');
      INSERT INTO plugin_instances (id, plugin_id, slug, display_name) VALUES ('i1', 'p1', 'nas', 'NAS');
      INSERT INTO operation_groups (id, instance_id, key, label, level, first_seen_at) VALUES
        ('ga', 'i1', 'a', 'A', 'ask', ${now}), ('gr', 'i1', 'r', 'R', 'read', ${now}), ('gn', 'i1', 'n', 'N', 'none', ${now});
      INSERT INTO operations (id, instance_id, key, kind, plugin_group, group_id, classification, classification_source,
          inferred_classification, inferred_reason, locked, level_override, write_acknowledged, first_seen_at, last_seen_at) VALUES
        ${[
          row('o1', 'read.ask', 'ga', 'read', 'inferred', 'read', 0, 'ask'),
          row('o2', 'read.write', 'ga', 'read', 'inferred', 'read', 0, 'write'),
          row('o3', 'write.read', 'ga', 'write', 'inferred', 'write', 0, 'read'),
          row('o4', 'locked.read', 'ga', 'write', 'locked', 'write', 1, 'read'),
          row('o5', 'locked.write', 'ga', 'write', 'locked', 'write', 1, 'write'),
          // Overrides: a read the admin marked write, in a group at Read (hidden) and at Ask (asked).
          row('o6', 'ovr.hidden', 'gr', 'write', 'override', 'read', 0, null),
          row('o7', 'ovr.asked', 'ga', 'write', 'override', 'read', 0, null),
          // A write the admin marked read: it ran; in a group at None it was off.
          row('o8', 'ovr.ran', 'gr', 'read', 'override', 'write', 0, null),
          row('o9', 'ovr.off', 'gn', 'read', 'override', 'write', 0, null),
          row('o10', 'ovr.same', 'ga', 'write', 'override', 'write', 0, 'write'),
        ].join(',\n')};
    `);
    sqlite.close();

    const db = openDatabase({ dataDir: dir });
    const byKey = Object.fromEntries(
      db
        .select()
        .from(schema.operations)
        .all()
        .map((o) => [o.key, o]),
    );
    const view = (k: string) => [byKey[k]?.classification, byKey[k]?.classificationSource, byKey[k]?.levelOverride];
    expect(view('read.ask')).toEqual(['read', 'inferred', 'read']);
    expect(view('read.write')).toEqual(['read', 'inferred', 'read']);
    expect(view('write.read')).toEqual(['write', 'inferred', 'none']);
    expect(view('locked.read')).toEqual(['write', 'locked', 'none']);
    expect(view('locked.write')).toEqual(['write', 'locked', 'ask']);
    expect(view('ovr.hidden')).toEqual(['read', 'inferred', 'none']);
    expect(view('ovr.asked')).toEqual(['read', 'inferred', 'ask']);
    expect(view('ovr.ran')).toEqual(['write', 'inferred', 'ask']);
    expect(view('ovr.off')).toEqual(['write', 'inferred', 'none']);
    expect(view('ovr.same')).toEqual(['write', 'inferred', 'write']);
    // What used to run still runs; nothing that was off or asking now runs without asking.
    expect(resolveAccess(db, 'i1', 'read.ask')).toMatchObject({ reachable: true, mode: 'run' });
    expect(resolveAccess(db, 'i1', 'write.read')).toEqual({ reachable: false, reason: 'level_none' });
    expect(resolveAccess(db, 'i1', 'ovr.asked')).toMatchObject({ mode: 'approve' });
    expect(resolveAccess(db, 'i1', 'ovr.ran')).toMatchObject({ mode: 'approve' });
  });
});

describe('0011 sensitive params migration', () => {
  it('adds the column, empty for existing operations', () => {
    const { dir, sqlite } = databaseAt('0010_access_by_kind');
    const now = Date.now();
    sqlite.exec(`
      INSERT INTO plugins (id, plugin_id, version, path, manifest, status) VALUES ('p1', 'echo', '1.0.0', '/x', '{}', 'ok');
      INSERT INTO plugin_instances (id, plugin_id, slug, display_name) VALUES ('i1', 'p1', 'nas', 'NAS');
      INSERT INTO operation_groups (id, instance_id, key, label, level, first_seen_at) VALUES ('g', 'i1', 'a', 'A', 'ask', ${now});
      INSERT INTO operations (id, instance_id, key, kind, plugin_group, group_id, classification, classification_source,
          inferred_classification, inferred_reason, first_seen_at, last_seen_at)
        VALUES ('o1', 'i1', 'a.set', 'method', 'a', 'g', 'write', 'inferred', 'write', 'x', ${now}, ${now});
    `);
    sqlite.close();
    const db = openDatabase({ dataDir: dir });
    expect(db.select().from(schema.operations).get()).toMatchObject({ key: 'a.set', sensitiveParams: null });
  });
});

describe('0012 sensitive result migration', () => {
  it('adds the columns and records the installed plugin version for successfully synced instances only', () => {
    const { dir, sqlite } = databaseAt('0011_sensitive_params');
    const now = Date.now();
    sqlite.exec(`
      INSERT INTO plugins (id, plugin_id, version, path, manifest, status) VALUES ('p1', 'echo', '1.4.0', '/x', '{}', 'ok');
      INSERT INTO plugin_instances (id, plugin_id, slug, display_name, last_synced_at, last_sync_status)
        VALUES ('i1', 'p1', 'nas', 'NAS', ${now}, 'ok');
      INSERT INTO plugin_instances (id, plugin_id, slug, display_name) VALUES ('i2', 'p1', 'fresh', 'Never synced');
      INSERT INTO plugin_instances (id, plugin_id, slug, display_name, last_synced_at, last_sync_status)
        VALUES ('i3', 'p1', 'failed', 'Last sync failed', ${now}, 'error: upstream down');
      INSERT INTO operation_groups (id, instance_id, key, label, level, first_seen_at) VALUES ('g', 'i1', 'a', 'A', 'ask', ${now});
      INSERT INTO operations (id, instance_id, key, kind, plugin_group, group_id, classification, classification_source,
          inferred_classification, inferred_reason, first_seen_at, last_seen_at)
        VALUES ('o1', 'i1', 'a.token', 'method', 'a', 'g', 'write', 'inferred', 'write', 'x', ${now}, ${now});
    `);
    sqlite.close();
    const db = openDatabase({ dataDir: dir });
    expect(db.select().from(schema.operations).get()).toMatchObject({ key: 'a.token', sensitiveResult: null });
    const version = (id: string) =>
      db.select().from(schema.pluginInstances).where(eq(schema.pluginInstances.id, id)).get()?.catalogPluginVersion;
    expect(version('i1')).toBe('1.4.0');
    // Never synced: its first call syncs anyway.
    expect(version('i2')).toBeNull();
    // Its last sync failed (an update whose sync failed?): the stored catalog may be an older
    // bundle's, so it syncs before serving.
    expect(version('i3')).toBeNull();
  });
});

describe('0013 user roles migration', () => {
  it('creates the Admin role, keeps every user an admin and gives owner-less tokens an owner', () => {
    const { dir, sqlite } = databaseAt('0012_sensitive_result');
    sqlite.exec(`
      INSERT INTO users (id, username, created_at) VALUES ('u2', 'second', 2000);
      INSERT INTO users (id, username, created_at) VALUES ('u1', 'first', 1000);
      INSERT INTO mcp_tokens (id, name, token_hash, scope, created_by) VALUES ('t1', 'orphan', 'h1', '["*"]', NULL);
      INSERT INTO mcp_tokens (id, name, token_hash, scope, created_by) VALUES ('t2', 'owned', 'h2', '["*"]', 'u2');
    `);
    sqlite.close();
    const db = openDatabase({ dataDir: dir });
    expect(db.select().from(schema.roles).all()).toEqual([
      expect.objectContaining({ id: 'admin', name: 'Admin', builtIn: true }),
    ]);
    expect(
      db
        .select()
        .from(schema.users)
        .all()
        .map((u) => u.roleId),
    ).toEqual(['admin', 'admin']);
    const owner = (id: string) =>
      db.select().from(schema.mcpTokens).where(eq(schema.mcpTokens.id, id)).get()?.createdBy;
    expect(owner('t1')).toBe('u1');
    expect(owner('t2')).toBe('u2');
  });
});
