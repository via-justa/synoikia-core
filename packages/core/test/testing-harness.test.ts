import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { plugins } from '../src/db/schema.js';
import { startPluginHarness } from '../src/testing/index.js';
import type { PluginHarness } from '../src/testing/index.js';

/** The plugin harness, exercised with the echo fixture so core's suite never names a plugin. */

const ECHO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/plugins/echo');

let h: PluginHarness;

beforeAll(async () => {
  h = await startPluginHarness({ pluginDir: ECHO, connection: { token: 'tok-secret' }, slug: 'echo-e2e' });
}, 30_000);

afterAll(async () => {
  await h?.stop();
});

describe('startPluginHarness', () => {
  it('loads only the given plugin from a staged copy and syncs its catalog', () => {
    expect(h.manifest.id).toBe('echo');
    expect(h.instance()).toMatchObject({ slug: 'echo-e2e', lastSyncStatus: 'ok' });
    expect(h.operations().map((o) => o.key)).toEqual(expect.arrayContaining(['echo.query', 'echo.set', 'echo.delete']));
    expect(h.operation('echo.delete')).toMatchObject({ locked: true });
    expect(() => h.operation('echo.nope')).toThrow(/No operation echo.nope/);
    // The child runs from the staged copy under the permission model: it reads its own manifest only.
    expect(h.ctx.db.select().from(plugins).get()).toMatchObject({
      path: path.join(h.ctx.config.DATA_DIR, 'plugins', 'echo'),
      enabled: true,
    });
  });

  it('starts groups at Ask, runs reads, redacts results and refuses writes at Read', async () => {
    expect(h.operation('echo.set')).toBeDefined();
    h.setGroupLevel('echo', 'read');
    await expect(h.execute(`return await echo.call('echo.query', { n: 1 });`)).resolves.toMatchObject({
      ok: true,
      value: { key: 'echo.query', params: { n: 1 }, password: '[REDACTED]' },
    });
    await expect(h.execute(`return await echo.call('echo.set', { name: 'a' });`)).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_DISABLED' },
    });
    await expect(h.search(`return (await catalog.find({ text: 'echo.query' })).length > 0;`)).resolves.toMatchObject({
      ok: true,
      value: true,
    });
  });

  it('hands approvals to onApproval, which approves or denies them', async () => {
    h.setGroupLevel('echo', 'ask');
    const seen: string[] = [];
    const approved = await h.execute(`return (await echo.call('echo.set', { name: 'a' })).params;`, {
      onApproval: (a) => {
        seen.push(a.message, a.operationKey);
        a.approve();
      },
    });
    expect(approved).toMatchObject({ ok: true, value: { name: 'a' } });
    expect(seen).toEqual([expect.stringContaining('echo.set'), 'echo.set']);

    const denied = await h.execute(`return await echo.call('echo.set', { name: 'b' });`, {
      onApproval: (a) => a.deny(),
    });
    expect(denied).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    // Without a handler the caller can't be prompted: denied.
    await expect(h.execute(`return await echo.call('echo.set', { name: 'c' });`)).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    });
  });

  it('enforces typed confirmations and records a handler that fails', async () => {
    h.setOperationLevel('echo.delete', 'ask');
    const attempts: string[] = [];
    const ok = await h.execute(`return (await echo.call('echo.delete', { name: 'box' })).params;`, {
      onApproval: (a) => {
        try {
          a.approve('wrong');
        } catch (err) {
          attempts.push((err as Error).message);
          a.approve('box');
        }
      },
    });
    expect(attempts[0]).toMatch(/Type "box" exactly/);
    expect(ok).toMatchObject({ ok: true, value: { name: 'box' } });

    const before = h.approvalErrors.length;
    const failed = await h.execute(`return await echo.call('echo.delete', { name: 'box' });`, {
      onApproval: (a) => a.approve('wrong'),
    });
    expect(failed).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(h.approvalErrors).toHaveLength(before + 1);
    h.setOperationLevel('echo.delete', null);
  });

  it('adds rules by operation key and reads the audit log', async () => {
    h.setGroupLevel('echo', 'ask');
    h.addRule({ operation: 'echo.set', match: [{ field: '/name', op: 'prefix', value: 'ok/' }], reason: 'harness' });
    await expect(h.execute(`return (await echo.call('echo.set', { name: 'ok/1' })).params;`)).resolves.toMatchObject({
      ok: true,
      value: { name: 'ok/1' },
    });
    expect(h.audit({ operationKey: 'echo.set' }).map((a) => a.decision)).toEqual(
      expect.arrayContaining(['human-approved', 'denied', expect.stringMatching(/^auto-approved:rule:/)]),
    );
  });

  it('raises a group to write, acknowledging its writes as the portal does', async () => {
    h.setGroupLevel('echo', 'write');
    await expect(h.execute(`return (await echo.call('echo.set', { name: 'w' })).params;`)).resolves.toMatchObject({
      ok: true,
      value: { name: 'w' },
    });
    h.setGroupLevel('echo', 'read');
  });

  it('tests a candidate connection in a throwaway child', async () => {
    await expect(h.testConnection({ token: 'other' })).resolves.toMatchObject({ ok: true });
  });
});

describe('startPluginHarness failures', () => {
  it('refuses an unbuilt plugin instead of skipping, and cleans up', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'synoikia-unbuilt-'));
    try {
      cpSync(path.join(ECHO, 'manifest.json'), path.join(dir, 'manifest.json'));
      await expect(startPluginHarness({ pluginDir: dir, connection: {} })).rejects.toThrow(
        /entry index.mjs not found .* Build the plugin first/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes its working directory on stop', async () => {
    const t = await startPluginHarness({ pluginDir: ECHO, connection: {}, sync: false });
    const staged = t.ctx.config.DATA_DIR;
    expect(existsSync(path.join(staged, 'plugins', 'echo', 'index.mjs'))).toBe(true);
    expect(t.operations()).toEqual([]);
    await t.stop();
    expect(existsSync(staged)).toBe(false);
  });
});
