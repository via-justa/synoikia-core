import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest } from '@synoikia/plugin-sdk';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalLinkService } from '../src/approvals/links.js';
import { ApprovalService } from '../src/approvals/service.js';
import type { ClientPrompts, FormPromptRequest, UrlPromptRequest } from '../src/approvals/service.js';
import { setGroupLevel, updateOperation } from '../src/catalog/groups.js';
import { applyCatalogSync } from '../src/catalog/sync.js';
import { openDatabase } from '../src/db/index.js';
import { approvalLinks, auditLog, guides, operations, pendingApprovals, preApprovalRules } from '../src/db/schema.js';
import type { AccessCeiling, AccessLevel } from '../src/gate/access.js';
import { issueAttestationKey } from '../src/gate/attestation.js';
import type { CallerContext, GateDeps, InstanceRuntime } from '../src/gate/pipeline.js';
import { SlidingWindowLimiter } from '../src/gate/rate-limit.js';
import { createInstanceRedactor, createRedactor, GLOBAL_SENSITIVE_KEYS } from '../src/gate/redact.js';
import { parseInstanceSettings } from '../src/instances/settings.js';
import type { InstanceSettings } from '../src/instances/settings.js';
import { PluginProcess } from '../src/plugins/process.js';
import { executeCode, SANDBOX_CONCURRENCY, searchCode } from '../src/runtime/index.js';
import { seedInstance } from './helpers.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/plugins/echo');
const manifest = parseManifest(JSON.parse(readFileSync(path.join(FIXTURE, 'manifest.json'), 'utf8')));

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(settings: Partial<InstanceSettings> = {}) {
  const { db, instanceId } = seedInstance(openDatabase(':memory:'), 'echo');
  const proc = new PluginProcess({ dir: FIXTURE, entry: manifest.entry, instanceId, defaultTimeoutMs: 5000 });
  proc.start();
  cleanup.push(() => proc.stop(500));
  await proc.call('init', { instanceId, config: {}, secrets: {}, sdkVersion: '0.1.0' });
  applyCatalogSync(db, instanceId, await proc.call('syncCatalog'));

  const approvals = new ApprovalService(db, new ApprovalLinkService(db));
  cleanup.push(() => approvals.cancelAll());
  const deps: GateDeps = { db, approvals, limiter: new SlidingWindowLimiter(), attestationKey: randomBytes(32) };
  /** What `catalogVersion()` reports: the running bundle's version while the catalog was synced from it. */
  const bundle: { catalog: string | undefined } = { catalog: '1.0.0' };
  const rt: InstanceRuntime = {
    instanceId,
    slug: 'echo',
    manifest,
    settings: { ...parseInstanceSettings({}), ...settings },
    redact: createRedactor(GLOBAL_SENSITIVE_KEYS, manifest.sensitiveKeys),
    plugin: () => proc,
    catalogVersion: () => bundle.catalog,
  };
  const opId = (key: string) => db.select().from(operations).where(eq(operations.key, key)).get()!.id;
  const setLevel = (level: AccessLevel) => setGroupLevel(db, instanceId, 'echo', level);
  const caller = (prompts?: ClientPrompts, ceiling: AccessCeiling = 'write'): CallerContext => ({
    client: { kind: 'mcp_client', id: 'claude-test' },
    principal: { ceiling },
    prompts,
  });
  const exec = (code: string, prompts?: ClientPrompts, ceiling?: AccessCeiling) =>
    executeCode(deps, rt, caller(prompts, ceiling), code);
  const audits = () => db.select().from(auditLog).where(eq(auditLog.kind, 'call')).all();
  const pending = () => db.select().from(pendingApprovals).where(eq(pendingApprovals.status, 'pending')).all();
  return { db, instanceId, proc, deps, rt, opId, setLevel, exec, audits, approvals, caller, pending, bundle };
}

/**
 * A client that supports URL prompts. `onOpen` plays the human on the approval page; without it the
 * page is opened and nobody decides.
 */
function urlClient(onOpen?: (req: UrlPromptRequest) => void, action: 'accept' | 'decline' | 'cancel' = 'accept') {
  const opened: UrlPromptRequest[] = [];
  const completed: string[] = [];
  const prompts: ClientPrompts = {
    url: async (req) => {
      opened.push(req);
      if (onOpen) setTimeout(() => onOpen(req), 5);
      return { action };
    },
    urlComplete: (id) => completed.push(id),
  };
  return { prompts, opened, completed };
}

/** A form-only client that says yes to everything it is shown, the self-approval the review found. */
function formClient() {
  const asked: FormPromptRequest[] = [];
  const prompts: ClientPrompts = {
    form: async (req) => {
      asked.push(req);
      return { action: 'accept', content: { approve: true, confirm: 'vol/x' } as { approve: unknown } };
    },
  };
  return { prompts, asked };
}

const waitFor = async (pred: () => boolean, ms = 3000) => {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('execute → gate → plugin', () => {
  it('runs reads immediately, redacts results, and audits', async () => {
    const t = await setup();
    const r = await t.exec(`return await echo.call('echo.query', { q: 1 });`);
    expect(r).toMatchObject({ ok: true, value: { key: 'echo.query', params: { q: 1 }, password: '[REDACTED]' } });
    expect(t.audits()).toMatchObject([
      {
        operationKey: 'echo.query',
        classification: 'read',
        decision: 'auto-executed',
        resultStatus: 'ok',
        actorId: 'claude-test',
      },
    ]);
  });

  it("masks the operation's declared result secrets in core, before the instance redactor", async () => {
    const t = await setup();
    // `key` is no sensitive key name; only the operation's declaration hides it.
    t.db
      .update(operations)
      .set({ sensitiveResult: { keys: ['key'] } })
      .where(eq(operations.id, t.opId('echo.query')))
      .run();
    const r = await t.exec(`return await echo.call('echo.query', { q: 1 });`);
    expect(r).toMatchObject({ ok: true, value: { key: '[REDACTED]', params: { q: 1 }, password: '[REDACTED]' } });

    t.db
      .update(operations)
      .set({ sensitiveResult: 'whole' })
      .where(eq(operations.id, t.opId('echo.query')))
      .run();
    await expect(t.exec(`return await echo.call('echo.query', { q: 1 });`)).resolves.toMatchObject({
      ok: true,
      value: '[REDACTED]',
    });
  });

  it('treats a write in a group at Read as off, with a catchable reason', async () => {
    const t = await setup();
    t.setLevel('read');
    const r = await t.exec(
      `try { await echo.call('echo.set', { name: 'x' }); } catch (e) { return [e.code, e.message]; }`,
    );
    expect(r).toMatchObject({
      ok: true,
      value: ['OPERATION_DISABLED', 'echo.set is disabled on this endpoint (access level None)'],
    });
    expect(t.audits()[0]).toMatchObject({ decision: 'rejected:level_none', resultStatus: 'rejected' });
  });

  it('rejects everything at level None', async () => {
    const t = await setup();
    t.setLevel('none');
    await expect(t.exec(`await echo.call('echo.query');`)).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_DISABLED', message: expect.stringContaining('access level None') },
    });
  });

  it('rejects operations the plugin does not know', async () => {
    const t = await setup();
    const r = await t.exec(`await echo.call('echo.nope');`);
    expect(r).toMatchObject({ ok: false, error: { code: 'UNKNOWN_OPERATION' } });
    expect(t.audits()[0]).toMatchObject({ decision: 'rejected:unknown_operation' });
  });

  describe('level Write', () => {
    it('runs acknowledged writes without asking anyone', async () => {
      const t = await setup();
      t.setLevel('write');
      const client = urlClient();
      const r = await t.exec(`return (await echo.call('echo.set', { name: 'x' })).key;`, client.prompts);
      expect(r).toMatchObject({ ok: true, value: 'echo.set' });
      expect(client.opened).toEqual([]);
      expect(t.db.select().from(pendingApprovals).all()).toEqual([]);
      expect(t.audits()[0]).toMatchObject({ decision: 'auto-approved:level', classification: 'write' });
    });

    it('asks for a write nobody acknowledged yet', async () => {
      const t = await setup();
      t.setLevel('write');
      updateOperation(t.db, t.instanceId, t.opId('echo.set'), { acknowledged: false });
      const client = urlClient((req) => t.approvals.decide(req.approvalId, { approve: true, decidedBy: 'admin' }));
      await expect(t.exec(`await echo.call('echo.set', { name: 'x' });`, client.prompts)).resolves.toMatchObject({
        ok: true,
      });
      expect(client.opened).toHaveLength(1);
      expect(t.audits()[0]).toMatchObject({ decision: 'human-approved', decidedVia: 'url' });
    });

    it('never auto-runs a locked operation', async () => {
      const t = await setup();
      t.setLevel('write');
      await expect(t.exec(`await echo.call('echo.delete', { name: 'vol/x' });`)).resolves.toMatchObject({
        ok: false,
        error: { code: 'OPERATION_DISABLED', message: expect.stringContaining('protected operation') },
      });
      updateOperation(t.db, t.instanceId, t.opId('echo.delete'), { level: 'ask' });
      await expect(t.exec(`await echo.call('echo.delete', { name: 'vol/x' });`)).resolves.toMatchObject({
        ok: false,
        error: { code: 'PERMISSION_DENIED' }, // it asked; this client has no way to answer
      });
    });
  });

  describe('level Ask: approvals', () => {
    it('asks for a read given its own Ask, through a read-only connection too, without using the write budget', async () => {
      const t = await setup({ writesPerMinute: 1 });
      updateOperation(t.db, t.instanceId, t.opId('echo.query'), { level: 'ask' });
      const client = urlClient((req) => t.approvals.decide(req.approvalId, { approve: true, decidedBy: 'admin' }));
      for (let i = 0; i < 2; i++) {
        const r = await t.exec(`return await echo.call('echo.query', { n: ${i} });`, client.prompts, 'read');
        expect(r).toMatchObject({ ok: true, value: { key: 'echo.query' } });
      }
      expect(client.opened).toHaveLength(2);
      expect(t.audits().map((a) => [a.decision, a.classification])).toEqual([
        ['human-approved', 'read'],
        ['human-approved', 'read'],
      ]);
    });

    it('refuses an approved call when the plugin changed while it waited, without invoking it', async () => {
      const t = await setup();
      t.setLevel('ask');
      // The admin updates the plugin (or it restarts onto other code) while the approval is open.
      const client = urlClient((req) => {
        t.bundle.catalog = undefined;
        t.approvals.decide(req.approvalId, { approve: true, decidedBy: 'admin' });
      });
      const r = await t.exec(
        `try { await echo.call('echo.set', { name: 'vol/a' }); } catch (e) { return e.code; }`,
        client.prompts,
      );
      expect(r).toMatchObject({ ok: true, value: 'PLUGIN_UNAVAILABLE' });
      expect(t.audits()[0]).toMatchObject({ decision: 'error:PLUGIN_UNAVAILABLE', resultStatus: 'error' });

      // Synced again from the new code: a fresh call runs.
      t.bundle.catalog = '2.0.0';
      const again = urlClient((req) => t.approvals.decide(req.approvalId, { approve: true, decidedBy: 'admin' }));
      await expect(
        t.exec(`return await echo.call('echo.set', { name: 'vol/a' });`, again.prompts),
      ).resolves.toMatchObject({
        ok: true,
      });
    });

    it('refuses a call gated while the catalog did not describe the running code', async () => {
      const t = await setup();
      t.bundle.catalog = undefined;
      const r = await t.exec(`try { await echo.call('echo.query'); } catch (e) { return e.code; }`);
      expect(r).toMatchObject({ ok: true, value: 'PLUGIN_UNAVAILABLE' });
    });

    it('sends the human to the approval page (URL prompt) and runs the call once approved there', async () => {
      const t = await setup();
      t.setLevel('ask');
      const client = urlClient((req) => t.approvals.decide(req.approvalId, { approve: true, decidedBy: 'admin' }));
      const r = await t.exec(`return await echo.call('echo.set', { name: 'vol/a', password: 'pw' });`, client.prompts);
      expect(r).toMatchObject({ ok: true, value: { key: 'echo.set' } });

      const [req] = client.opened;
      expect(req?.path).toMatch(/^\/a\/[A-Za-z0-9_-]{20,}$/);
      expect(req?.message).toContain('echo.set');
      expect(req?.message).not.toContain('pw');
      expect(client.completed).toEqual([req?.approvalId]);
      // The page link is single-use: burnt once decided.
      expect(t.db.select().from(approvalLinks).get()?.usedAt).toBeInstanceOf(Date);
      expect(t.audits()[0]).toMatchObject({
        decision: 'human-approved',
        decidedVia: 'url',
        decidedBy: 'admin',
        classification: 'write',
      });
      const row = t.db.select().from(pendingApprovals).get()!;
      expect(row).toMatchObject({ status: 'approved', paramsDisplay: { name: 'vol/a', password: '[REDACTED]' } });
      expect(row.paramsHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('treats a declined or dismissed URL prompt as a denial', async () => {
      for (const action of ['decline', 'cancel'] as const) {
        const t = await setup();
        t.setLevel('ask');
        const r = await t.exec(
          `try { await echo.call('echo.set', { name: 'x' }); } catch (e) { return [e.code, e.message]; }`,
          urlClient(undefined, action).prompts,
        );
        expect(r).toMatchObject({ ok: true, value: ['PERMISSION_DENIED', 'echo.set was declined in the client'] });
        expect(t.audits()[0]).toMatchObject({ decision: 'denied', decidedVia: 'elicitation' });
      }
    });

    it('never lets a form-only client approve its own call, whatever it answers', async () => {
      const t = await setup();
      t.setLevel('ask');
      const client = formClient();
      const r = await t.exec(`await echo.call('echo.set', { name: 'x' });`, client.prompts);
      expect(r).toMatchObject({
        ok: false,
        error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('only supports form prompts') },
      });
      expect(client.asked).toEqual([]);
    });

    it('lets form prompts approve plain writes only where the endpoint opted in', async () => {
      const t = await setup({ formElicitationApprovals: 'writes' });
      t.setLevel('ask');
      const client = formClient();
      await expect(
        t.exec(`return (await echo.call('echo.set', { name: 'x' })).key;`, client.prompts),
      ).resolves.toMatchObject({ ok: true, value: 'echo.set' });
      expect(client.asked[0]?.requestedSchema).toEqual({
        type: 'object',
        properties: { approve: { type: 'boolean', title: 'Approve this call?' } },
        required: ['approve'],
      });
      expect(t.audits()[0]).toMatchObject({ decidedVia: 'elicitation', decidedBy: 'claude-test' });

      // Locked (typed-confirmation) operations still need the approval page.
      updateOperation(t.db, t.instanceId, t.opId('echo.delete'), { level: 'ask' });
      await expect(t.exec(`await echo.call('echo.delete', { name: 'vol/x' });`, client.prompts)).resolves.toMatchObject(
        {
          ok: false,
          error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('only supports form') },
        },
      );
      expect(client.asked).toHaveLength(1);

      // A read the admin put at its own Ask always needs a human, whatever the setting allows for writes.
      updateOperation(t.db, t.instanceId, t.opId('echo.query'), { level: 'ask' });
      await expect(t.exec(`await echo.call('echo.query', { q: 1 });`, client.prompts)).resolves.toMatchObject({
        ok: false,
        error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('only supports form') },
      });
      expect(client.asked).toHaveLength(1);
    });

    it('rejects a read whose own Ask was lowered while its approval waited', async () => {
      const t = await setup();
      updateOperation(t.db, t.instanceId, t.opId('echo.query'), { level: 'ask' });
      const client = urlClient((req) => {
        updateOperation(t.db, t.instanceId, t.opId('echo.query'), { level: 'none' });
        t.approvals.decide(req.approvalId, { approve: true, decidedBy: 'admin' });
      });
      await expect(t.exec(`await echo.call('echo.query', { q: 1 });`, client.prompts)).resolves.toMatchObject({
        ok: false,
        error: { code: 'OPERATION_DISABLED' },
      });
      expect(t.audits()[0]).toMatchObject({ decision: 'rejected:access_changed' });
    });

    it('hides params the plugin declared sensitive by path from the approval and the audit log', async () => {
      const t = await setup();
      t.setLevel('ask');
      const client = urlClient((req) => t.approvals.decide(req.approvalId, { approve: true, decidedBy: 'admin' }));
      const r = await t.exec(
        `return (await echo.call('echo.set', { name: 'x', pin: '4711' })).params;`,
        client.prompts,
      );
      // The plugin's invoke still gets the real value.
      expect(r).toMatchObject({ ok: true, value: { name: 'x', pin: '4711' } });
      expect(client.opened[0]?.message).not.toContain('4711');
      expect(t.db.select().from(pendingApprovals).get()?.paramsDisplay).toEqual({ name: 'x', pin: '[REDACTED]' });
      expect(t.audits()[0]?.params).toEqual({ name: 'x', pin: '[REDACTED]' });
    });

    it('hides secrets in a config diff from the approval, the stored row and a form prompt', async () => {
      const t = await setup({ formElicitationApprovals: 'writes' });
      t.setLevel('ask');
      // Make echo.set a config write whose prepareWrite returns a diff that touches secrets.
      t.db.update(operations).set({ kind: 'config' }).where(eq(operations.key, 'echo.set')).run();
      t.rt.manifest = { ...t.rt.manifest, capabilities: { ...t.rt.manifest.capabilities, configTransform: true } };
      const real = t.rt.plugin();
      t.rt.plugin = () =>
        ({
          call: (method: string, params: unknown, ...rest: unknown[]) =>
            method === 'prepareWrite'
              ? Promise.resolve({
                  params: (params as { params: unknown }).params,
                  diff: [
                    { path: '/smtp/password', before: 'old-smtp-secret', after: 'new-smtp-secret' },
                    { path: '/pin', after: '4711' },
                    { path: '/name', before: 'a', after: 'b' },
                  ],
                  expectedHash: 'h1',
                })
              : (real.call as (...a: unknown[]) => Promise<unknown>)(method, params, ...rest),
        }) as unknown as ReturnType<typeof t.rt.plugin>;
      const client = formClient();
      await t.exec(`await echo.call('echo.set', { name: 'x', pin: '4711' });`, client.prompts);
      const row = t.db.select().from(pendingApprovals).get()!;
      expect(row.diff).toEqual([
        { path: '/smtp/password', before: '[REDACTED]', after: '[REDACTED]' },
        { path: '/pin', after: '[REDACTED]' },
        { path: '/name', before: 'a', after: 'b' },
      ]);
      expect(client.asked).toHaveLength(1);
      expect(client.asked[0]?.message).toContain('/smtp/password');
      const shown = JSON.stringify(client.asked);
      for (const secret of ['old-smtp-secret', 'new-smtp-secret', '4711']) expect(shown).not.toContain(secret);
    });

    it('keeps a __proto__ param visible to the approver', async () => {
      const t = await setup();
      t.setLevel('ask');
      const client = urlClient((req) => t.approvals.decide(req.approvalId, { approve: false, decidedBy: 'admin' }));
      await t.exec(
        `await echo.call('echo.set', JSON.parse('{"name":"x","__proto__":{"force":true}}'));`,
        client.prompts,
      );
      const shown = JSON.stringify(t.db.select().from(pendingApprovals).get()?.paramsDisplay);
      expect(shown).toContain('"__proto__":{"force":true}');
    });

    it('denies at once when the client cannot show prompts', async () => {
      const t = await setup();
      t.setLevel('ask');
      await expect(t.exec(`await echo.call('echo.set', { name: 'x' });`)).resolves.toMatchObject({
        ok: false,
        error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('cannot show approval prompts') },
      });
    });

    it('denies when the client fails to show the prompt', async () => {
      const t = await setup();
      t.setLevel('ask');
      const prompts: ClientPrompts = { url: () => Promise.reject(new Error('boom')) };
      await expect(t.exec(`await echo.call('echo.set', { name: 'x' });`, prompts)).resolves.toMatchObject({
        ok: false,
        error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('could not show') },
      });
    });

    it('times out unanswered approvals as denials, without spending the sandbox budget', async () => {
      const t = await setup({
        approvalTimeoutMs: 300,
        sandbox: { timeoutMs: 150, memoryMb: 64, maxResultBytes: 65536 },
      });
      t.setLevel('ask');
      const r = await t.exec(
        `try { await echo.call('echo.set', { name: 'x' }); } catch (e) { return e.message; }`,
        urlClient().prompts,
      );
      expect(r).toMatchObject({ ok: true, value: 'Approval for echo.set timed out and was denied' });
      expect(t.audits()[0]).toMatchObject({ decision: 'timed-out' });
      expect(t.db.select().from(pendingApprovals).get()?.status).toBe('timed_out');
    });

    it('refuses an approved call whose access was lowered while it waited', async () => {
      const t = await setup();
      t.setLevel('ask');
      const client = urlClient((req) => {
        t.setLevel('read');
        t.approvals.decide(req.approvalId, { approve: true, decidedBy: 'admin' });
      });
      await expect(t.exec(`await echo.call('echo.set', { name: 'x' });`, client.prompts)).resolves.toMatchObject({
        ok: false,
        error: { code: 'OPERATION_DISABLED', message: 'echo.set was disabled while waiting for approval' },
      });
      expect(t.audits()[0]).toMatchObject({ decision: 'rejected:access_changed' });
    });

    it('serializes calls: a second write waits until the first is decided', async () => {
      const t = await setup();
      t.setLevel('ask');
      const run = t.exec(
        `return await Promise.all([echo.call('echo.set', { name: 'a' }), echo.call('echo.set', { name: 'b' })]);`,
        urlClient().prompts,
      );
      await waitFor(() => t.pending().length === 1);
      await new Promise((r) => setTimeout(r, 100));
      expect(t.pending()).toHaveLength(1);
      const first = t.pending()[0]!;
      t.approvals.decide(first.id, { approve: true, decidedBy: 'admin' });
      await waitFor(() => t.pending().length === 1 && t.pending()[0]!.id !== first.id);
      const second = t.pending()[0]!;
      expect(second.paramsHash).not.toBe(first.paramsHash); // each approval is scoped to its own params
      t.approvals.decide(second.id, { approve: true, decidedBy: 'admin' });
      await expect(run).resolves.toMatchObject({
        ok: true,
        value: [{ params: { name: 'a' } }, { params: { name: 'b' } }],
      });
    });
  });

  describe('ending an execution', () => {
    it('refuses calls the script left behind once it has returned', async () => {
      const t = await setup();
      t.setLevel('write');
      const r = await t.exec(`echo.call('echo.set', { name: 'x' }); return 'returned';`);
      expect(r).toMatchObject({ ok: true, value: 'returned' });
      await waitFor(() => t.audits().length === 1);
      expect(t.audits()[0]).toMatchObject({ operationKey: 'echo.set', decision: 'rejected:execution_ended' });
    });

    it('never leaves an approval open for a script that returned', async () => {
      const t = await setup();
      t.setLevel('ask');
      const client = urlClient();
      const r = await t.exec(`echo.call('echo.set', { name: 'x' }); return 'returned';`, client.prompts);
      expect(r).toMatchObject({ ok: true, value: 'returned' });
      await waitFor(() => t.audits().length === 1);
      expect(t.audits()[0]).toMatchObject({ decision: 'rejected:execution_ended' });
      expect(t.pending()).toEqual([]);
    });

    it('ends when the MCP request is cancelled while an approval is open', async () => {
      const t = await setup();
      t.setLevel('ask');
      const abort = new AbortController();
      const client = urlClient(() => abort.abort());
      const r = await executeCode(
        t.deps,
        t.rt,
        t.caller(client.prompts),
        `await echo.call('echo.set', { name: 'x' });`,
        abort.signal,
      );
      expect(r).toMatchObject({ ok: false, error: { code: 'EXECUTION_ENDED' } });
      expect(t.db.select().from(pendingApprovals).get()?.status).toBe('cancelled');
    });
  });

  describe('targets', () => {
    it('refuses an approved call whose targets changed while it waited', async () => {
      const t = await setup();
      t.setLevel('ask');
      const client = urlClient((req) => t.approvals.decide(req.approvalId, { approve: true, decidedBy: 'admin' }));
      const r = await t.exec(`await echo.call('echo.set', { name: 'x', drift: true });`, client.prompts);
      expect(r).toMatchObject({ ok: false, error: { code: 'TARGETS_CHANGED' } });
      const approval = t.db.select().from(pendingApprovals).get()!;
      expect(approval.resolvedTargets).toMatchObject([{ id: 'widget.e1' }]);
      expect(t.audits()[0]).toMatchObject({
        decision: 'rejected:targets_changed',
        detail: expect.objectContaining({ targetsNow: [expect.objectContaining({ id: 'widget.e2' })] }),
      });
    });

    it('hands the plugin exactly the targets that were approved', async () => {
      const t = await setup();
      t.setLevel('ask');
      const client = urlClient((req) => t.approvals.decide(req.approvalId, { approve: true, decidedBy: 'admin' }));
      const r = await t.exec(`return await echo.call('echo.set', { name: 'x', action: 'context' });`, client.prompts);
      expect(r).toMatchObject({ ok: true, value: { targets: [], callId: expect.any(String) } });
    });
  });

  describe('locked operations', () => {
    it('stay unreachable until the operation itself is set to Ask', async () => {
      const t = await setup();
      t.setLevel('ask');
      await expect(t.exec(`await echo.call('echo.delete', { name: 'vol/x' });`)).resolves.toMatchObject({
        ok: false,
        error: { code: 'OPERATION_DISABLED' },
      });
    });

    it('require the typed confirmation literal on the approval page', async () => {
      const t = await setup();
      updateOperation(t.db, t.instanceId, t.opId('echo.delete'), { level: 'ask' });
      const client = urlClient((req) => {
        expect(() => t.approvals.decide(req.approvalId, { approve: true, confirm: 'vol/y', decidedBy: 'a' })).toThrow(
          /Type "vol\/x" exactly/,
        );
        t.approvals.decide(req.approvalId, { approve: true, confirm: 'vol/x', decidedBy: 'a' });
      });
      const r = await t.exec(`return (await echo.call('echo.delete', { name: 'vol/x' })).key;`, client.prompts);
      expect(r).toMatchObject({ ok: true, value: 'echo.delete' });
    });

    it('are refused when the plugin gives no confirmation literal', async () => {
      const t = await setup();
      updateOperation(t.db, t.instanceId, t.opId('echo.nolit'), { level: 'ask' });
      const r = await t.exec(`await echo.call('echo.nolit', {});`, urlClient().prompts);
      expect(r).toMatchObject({ ok: false, error: { code: 'PLUGIN_ERROR' } });
    });

    it('are never pre-approved, even by a rule that slipped into the DB', async () => {
      const t = await setup();
      updateOperation(t.db, t.instanceId, t.opId('echo.delete'), { level: 'ask' });
      t.db
        .insert(preApprovalRules)
        .values({ id: randomUUID(), instanceId: t.instanceId, operationId: t.opId('echo.delete'), reason: 'x' })
        .run();
      const r = await t.exec(`await echo.call('echo.delete', { name: 'vol/x' });`);
      expect(r).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    });
  });

  describe('pre-approval rules', () => {
    function addRule(t: Awaited<ReturnType<typeof setup>>, extra: Partial<typeof preApprovalRules.$inferInsert> = {}) {
      const id = randomUUID();
      t.db
        .insert(preApprovalRules)
        .values({
          id,
          instanceId: t.instanceId,
          operationId: t.opId('echo.set'),
          match: [{ field: '/name', op: 'prefix', value: 'vol/media/' }],
          reason: 'media volumes',
          ...extra,
        })
        .run();
      return id;
    }

    it('auto-approve matching calls at Ask and send the rest to a human', async () => {
      const t = await setup();
      t.setLevel('ask');
      const ruleId = addRule(t);
      await expect(
        t.exec(`return (await echo.call('echo.set', { name: 'vol/media/tv' })).key;`),
      ).resolves.toMatchObject({ ok: true });
      await expect(t.exec(`await echo.call('echo.set', { name: 'vol/other' });`)).resolves.toMatchObject({
        ok: false,
        error: { code: 'PERMISSION_DENIED' },
      });
      expect(t.audits().map((a) => a.decision)).toEqual([`auto-approved:rule:${ruleId}`, 'denied']);
      expect(t.db.select().from(pendingApprovals).all()).toHaveLength(1); // only the non-matching call
    });

    it('can cover a read the admin put at its own Ask', async () => {
      const t = await setup();
      updateOperation(t.db, t.instanceId, t.opId('echo.query'), { level: 'ask' });
      const ruleId = addRule(t, { operationId: t.opId('echo.query'), match: [{ field: '/q', op: 'eq', value: 1 }] });
      await expect(t.exec(`return (await echo.call('echo.query', { q: 1 })).key;`)).resolves.toMatchObject({
        ok: true,
        value: 'echo.query',
      });
      expect(t.audits()[0]).toMatchObject({ decision: `auto-approved:rule:${ruleId}`, classification: 'read' });
    });

    it('fall back to a human once the rate limit is hit', async () => {
      const t = await setup();
      t.setLevel('ask');
      const ruleId = addRule(t, { rateLimit: 1, windowSeconds: 3600 });
      await t.exec(`await echo.call('echo.set', { name: 'vol/media/a' });`);
      const client = urlClient((req) => t.approvals.decide(req.approvalId, { approve: true, decidedBy: 'admin' }));
      const r = await t.exec(`return (await echo.call('echo.set', { name: 'vol/media/b' })).key;`, client.prompts);
      expect(r).toMatchObject({ ok: true });
      const [first, second] = t.audits();
      expect(first?.decision).toBe(`auto-approved:rule:${ruleId}`);
      expect(second).toMatchObject({
        decision: 'human-approved',
        detail: expect.objectContaining({ rateLimitedRules: [ruleId] }),
      });
    });

    it('send calls with parameters the rule does not accept to a human, and say so on the rule', async () => {
      const t = await setup();
      t.setLevel('ask');
      const ruleId = addRule(t);
      await expect(t.exec(`await echo.call('echo.set', { name: 'vol/media/tv', quota: 5 });`)).resolves.toMatchObject({
        ok: false,
        error: { code: 'PERMISSION_DENIED' },
      });
      const rule = t.db.select().from(preApprovalRules).where(eq(preApprovalRules.id, ruleId)).get()!;
      expect(rule.strictMissAt).toBeInstanceOf(Date);
      expect(rule.lastTriggeredAt).toBeNull();
    });

    it('ignore expired and disabled rules', async () => {
      const t = await setup();
      t.setLevel('ask');
      addRule(t, { expiresAt: new Date(Date.now() - 1000) });
      addRule(t, { enabled: false });
      await expect(t.exec(`await echo.call('echo.set', { name: 'vol/media/a' });`)).resolves.toMatchObject({
        ok: false,
        error: { code: 'PERMISSION_DENIED' },
      });
    });
  });

  describe('read-only principals', () => {
    it('cannot call writes at any level, but still read', async () => {
      const t = await setup();
      t.setLevel('write');
      await expect(t.exec(`await echo.call('echo.set', { name: 'x' });`, undefined, 'read')).resolves.toMatchObject({
        ok: false,
        error: { code: 'OPERATION_DISABLED', message: expect.stringContaining('read-only access') },
      });
      expect(t.audits()[0]).toMatchObject({ decision: 'rejected:token_read_only' });
      await expect(t.exec(`return (await echo.call('echo.query')).key;`, undefined, 'read')).resolves.toMatchObject({
        ok: true,
      });
    });
  });

  it('requires a current best-practice key for attested operations', async () => {
    const t = await setup();
    t.setLevel('write');
    const opId = t.opId('echo.guided');
    const call = (key?: string) =>
      t.exec(`return (await echo.call('echo.guided', ${JSON.stringify(key ? { best_practice_key: key } : {})})).key;`);

    await expect(call()).resolves.toMatchObject({ ok: false, error: { code: 'ATTESTATION_REQUIRED' } });
    t.db
      .insert(guides)
      .values({
        id: randomUUID(),
        instanceId: t.instanceId,
        operationId: opId,
        version: 'v1',
        content: 'x',
        fetchedAt: new Date(1000),
      })
      .run();
    const v1 = issueAttestationKey(t.deps.attestationKey, t.instanceId, 'echo.guided', 'v1');
    await expect(call('forged')).resolves.toMatchObject({ ok: false, error: { code: 'ATTESTATION_REQUIRED' } });
    await expect(call(v1)).resolves.toMatchObject({ ok: true, value: 'echo.guided' });

    t.db
      .insert(guides)
      .values({
        id: randomUUID(),
        instanceId: t.instanceId,
        operationId: opId,
        version: 'v2',
        content: 'y',
        fetchedAt: new Date(2000),
      })
      .run();
    await expect(call(v1)).resolves.toMatchObject({ ok: false, error: { code: 'ATTESTATION_REQUIRED' } });

    // The key is bound to the MCP session that read the guide (review M17).
    const inSession = (sessionId: string, key: string) =>
      executeCode(
        t.deps,
        t.rt,
        { ...t.caller(), mcpSessionId: sessionId },
        `return (await echo.call('echo.guided', ${JSON.stringify({ best_practice_key: key })})).key;`,
      );
    const s1 = issueAttestationKey(t.deps.attestationKey, t.instanceId, 'echo.guided', 'v2', 'session-1');
    await expect(inSession('session-1', s1)).resolves.toMatchObject({ ok: true, value: 'echo.guided' });
    await expect(inSession('session-2', s1)).resolves.toMatchObject({
      ok: false,
      error: { code: 'ATTESTATION_REQUIRED' },
    });
    await expect(call(s1)).resolves.toMatchObject({ ok: false, error: { code: 'ATTESTATION_REQUIRED' } });
  });

  it('limits execute and search runs per principal, not binding calls', async () => {
    const t = await setup({ executePerMinute: 2 });
    const three = `const out = []; for (let i = 0; i < 3; i++) out.push((await echo.call('echo.query')).key); return out.length;`;
    await expect(t.exec(three)).resolves.toMatchObject({ ok: true, value: 3 });
    await expect(searchCode(t.deps, t.rt, t.caller(), 'return 1')).resolves.toMatchObject({ ok: true });
    await expect(t.exec('return 1')).resolves.toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    // Another principal has its own budget.
    const other = { ...t.caller(), client: { kind: 'mcp_client' as const, id: 'other-client' } };
    await expect(executeCode(t.deps, t.rt, other, 'return 1')).resolves.toMatchObject({ ok: true });
  });

  it('charges write budgets per principal, and only for writes that run (review L20)', async () => {
    const t = await setup({ executePerMinute: 1000, writesPerMinute: 2 });
    const write = `return (await echo.call('echo.set', { name: 'vol/a' })).key;`;
    // Denied writes (no way to ask anyone) don't use the budget.
    t.setLevel('ask');
    for (let i = 0; i < 3; i++)
      await expect(t.exec(write)).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });

    t.setLevel('write');
    await expect(t.exec(write)).resolves.toMatchObject({ ok: true });
    await expect(t.exec(write)).resolves.toMatchObject({ ok: true });
    await expect(t.exec(write)).resolves.toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    // Another client has its own budget.
    const other = { ...t.caller(), client: { kind: 'mcp_client' as const, id: 'other-client' } };
    await expect(executeCode(t.deps, t.rt, other, write)).resolves.toMatchObject({ ok: true });
  });

  it('caps how many scripts run at once', async () => {
    const t = await setup({ executePerMinute: 1000 });
    const saved = { ...SANDBOX_CONCURRENCY };
    SANDBOX_CONCURRENCY.perInstance = 2;
    try {
      t.setLevel('ask');
      const hold = urlClient(); // opens the page, nobody decides: the script stays running
      const a = t.exec(`await echo.call('echo.set', { name: 'a' });`, hold.prompts);
      const b = t.exec(`await echo.call('echo.set', { name: 'b' });`, hold.prompts);
      await waitFor(() => hold.opened.length === 2);
      await expect(t.exec('return 1')).resolves.toMatchObject({ ok: false, error: { code: 'BUSY' } });
      t.approvals.cancelAll();
      await Promise.all([a, b]);
      await expect(t.exec('return 1')).resolves.toMatchObject({ ok: true });
    } finally {
      Object.assign(SANDBOX_CONCURRENCY, saved);
    }
  });

  it('scrubs the instance secrets out of upstream error messages', async () => {
    const t = await setup();
    t.rt.redact = createInstanceRedactor({ keyLists: [GLOBAL_SENSITIVE_KEYS], secretValues: ['tok-9f8e7d6c5b'] });
    const r = await t.exec(
      `try { await echo.call('echo.query', { action: 'upstream-echo', text: 'token tok-9f8e7d6c5b is invalid' }); } catch (e) { return e.message; }`,
    );
    expect(r).toMatchObject({ ok: true, value: 'upstream rejected: token [REDACTED] is invalid' });
  });

  it('maps upstream and plugin failures to structured errors', async () => {
    const t = await setup();
    const denied = await t.exec(`await echo.call('echo.query', { action: 'upstream-denied' });`);
    expect(denied).toMatchObject({ ok: false, error: { code: 'UPSTREAM_DENIED', message: 'insufficient permission' } });
    expect(t.audits()[0]).toMatchObject({ decision: 'error:UPSTREAM_DENIED', resultStatus: 'error' });

    await t.proc.stop(500);
    const down = await t.exec(`await echo.call('echo.query');`);
    expect(down).toMatchObject({ ok: false, error: { code: 'PLUGIN_UNAVAILABLE' } });
  });
});

describe('ApprovalService', () => {
  it('denies approvals left pending by a previous process', async () => {
    const t = await setup();
    t.setLevel('ask');
    const run = t.exec(`await echo.call('echo.set', { name: 'x' });`, urlClient().prompts);
    await waitFor(() => t.pending().length === 1);
    // Simulate a restart: a fresh process sees the row but has none of the in-memory state.
    expect(ApprovalService.denyOrphans(t.db)).toBe(1);
    expect(t.db.select().from(pendingApprovals).get()?.status).toBe('denied');
    const row = t.db.select().from(pendingApprovals).get()!;
    const fresh = new ApprovalService(t.db, new ApprovalLinkService(t.db));
    expect(() => fresh.decide(row.id, { approve: true, decidedBy: 'a' })).toThrow(/already denied/);
    t.approvals.cancelAll();
    await run;
  });

  it('refuses decisions on a closed approval', async () => {
    const t = await setup();
    t.setLevel('ask');
    const client = urlClient((req) => t.approvals.decide(req.approvalId, { approve: true, decidedBy: 'admin' }));
    await t.exec(`await echo.call('echo.set', { name: 'x' });`, client.prompts);
    const row = t.db.select().from(pendingApprovals).get()!;
    expect(() => t.approvals.decide(row.id, { approve: false, decidedBy: 'admin' })).toThrow(/already approved/);
    expect(() => t.approvals.decide('nope', { approve: false, decidedBy: 'admin' })).toThrow(/No such approval/);
  });
});

describe('search', () => {
  it('lists callable operations by default and explains hidden ones on request', async () => {
    const t = await setup();
    const search = (code: string, ceiling?: AccessCeiling) =>
      searchCode(t.deps, t.rt, t.caller(undefined, ceiling), code);
    t.setLevel('read');

    await expect(search(`return (await catalog.find()).map((o) => o.key);`)).resolves.toMatchObject({
      value: ['echo.query'],
    });
    const all = await search(
      `return (await catalog.find({ includeDisabled: true })).map((o) => [o.key, o.classification, o.reason ?? null]);`,
    );
    expect(all).toMatchObject({
      value: [
        ['echo.delete', 'locked', 'locked_not_opted_in'],
        ['echo.guided', 'write', 'level_none'],
        ['echo.nolit', 'locked', 'locked_not_opted_in'],
        ['echo.query', 'read', null],
        ['echo.set', 'write', 'level_none'],
      ],
    });
    await expect(
      search(`return (await catalog.groups()).map((g) => [g.key, g.level, g.counts]);`),
    ).resolves.toMatchObject({
      value: [['echo', 'read', { read: 1, write: 2, locked: 2, pendingReview: 0, overridden: 0 }]],
    });
    await expect(search(`return typeof echo;`)).resolves.toMatchObject({ value: 'undefined' }); // no upstream access from search

    // What a call would do: run, ask, or auto-approve.
    t.setLevel('ask');
    await expect(search(`return (await catalog.get('echo.set')).approval;`)).resolves.toMatchObject({
      value: 'required',
    });
    t.setLevel('write');
    await expect(search(`return (await catalog.get('echo.set')).approval;`)).resolves.toMatchObject({ value: 'auto' });
    await expect(search(`return (await catalog.get('echo.query')).approval;`)).resolves.toMatchObject({
      value: 'none',
    });
    // A read-only principal doesn't see writes at all.
    await expect(search(`return (await catalog.find()).map((o) => o.key);`, 'read')).resolves.toMatchObject({
      value: ['echo.query'],
    });
    expect(t.db.select().from(auditLog).where(eq(auditLog.kind, 'search')).all()).toHaveLength(8);
  });
});
