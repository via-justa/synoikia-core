import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/app.js';
import { SessionGrantService } from '../src/approvals/grants.js';
import type { ParkedApproval } from '../src/approvals/service.js';
import { eq } from 'drizzle-orm';
import { setGroupLevel, updateOperation } from '../src/catalog/groups.js';
import { openDatabase } from '../src/db/index.js';
import { auditLog, operations, pluginInstances } from '../src/db/schema.js';
import type { CallerContext } from '../src/gate/pipeline.js';
import { ExecutionRegistry, PARKED_LIMIT, RESULT_TTL_MS } from '../src/runtime/executions.js';
import type { PendingResult } from '../src/runtime/executions.js';
import { executeCode, resumeExecution, sandboxesRunning, searchCode } from '../src/runtime/index.js';
import { createTestApp } from './helpers.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const approval = (id: string): ParkedApproval => ({
  approvalId: id,
  path: `/a/${id}`,
  operationKey: 'echo.set',
  summary: 'set',
  expiresAt: new Date(Date.now() + 60_000),
});

describe('ExecutionRegistry', () => {
  it('caps parked runs per client and endpoint, per endpoint and in total', () => {
    const reg = new ExecutionRegistry();
    for (let i = 0; i < PARKED_LIMIT.perPrincipalInstance; i++)
      reg.adopt({ id: `a${i}`, owner: 'alice', instanceId: 'i1', approval: approval(`p${i}`), abort: () => {} });
    expect(reg.hasRoom('alice', 'i1')).toBe(false);
    expect(reg.hasRoom('bob', 'i1')).toBe(true);
    expect(reg.hasRoom('alice', 'i2')).toBe(true);
    for (let i = 0; i < PARKED_LIMIT.perInstance; i++)
      reg.adopt({ id: `b${i}`, owner: `u${i}`, instanceId: 'i3', approval: approval(`q${i}`), abort: () => {} });
    expect(reg.hasRoom('someone', 'i3')).toBe(false);
    // A finished run no longer counts.
    reg.finish('a0', { ok: true, value: 1, truncated: false, logs: [] });
    expect(reg.hasRoom('alice', 'i1')).toBe(true);
    expect(reg.running).toBe(PARKED_LIMIT.perPrincipalInstance - 1 + PARKED_LIMIT.perInstance);
  });

  it('answers only its owner, waits for a change, refuses a second waiter and drops stale results', async () => {
    let now = Date.now();
    const reg = new ExecutionRegistry(() => now);
    const abort = vi.fn();
    reg.adopt({ id: 'x', owner: 'alice', instanceId: 'i1', approval: approval('p1'), abort });
    expect(reg.status('x', 'bob', 'i1')).toBeUndefined();
    expect(reg.status('x', 'alice', 'i2')).toBeUndefined();
    expect(reg.status('x', 'alice', 'i1')).toMatchObject({ state: 'pending' });
    expect(await reg.wait('x', 'bob', 'i1', 10)).toBe('not_found');

    // Nothing changes: the wait ends with the same approval.
    const still = (await reg.wait('x', 'alice', 'i1', 20)) as PendingResult;
    expect(still).toMatchObject({ status: 'awaiting_approval', approval: { approvalId: 'p1' } });

    const first = reg.wait('x', 'alice', 'i1', 5_000);
    expect(await reg.wait('x', 'alice', 'i1', 10)).toBe('busy');
    reg.settled('x', 'p1', { outcome: 'approved', decidedBy: 'admin' });
    expect(reg.status('x', 'alice', 'i1')).toEqual({ state: 'approved' }); // no approver name to the client
    reg.awaiting('x', approval('p2'));
    expect(await first).toMatchObject({ status: 'awaiting_approval', approval: { approvalId: 'p2' } });

    reg.settled('x', 'p2', { outcome: 'denied', decidedBy: 'admin' });
    expect(reg.status('x', 'alice', 'i1')).toMatchObject({ state: 'denied' });
    const running = (await reg.wait('x', 'alice', 'i1', 10)) as PendingResult;
    expect(running).toMatchObject({ status: 'running', error: { code: 'STILL_RUNNING' } });

    reg.abort('i2');
    expect(abort).not.toHaveBeenCalled();
    reg.abort('i1');
    expect(abort).toHaveBeenCalledOnce();
    reg.finish('x', { ok: false, error: { code: 'PERMISSION_DENIED', message: 'no' }, logs: [] });
    expect(reg.status('x', 'alice', 'i1')).toMatchObject({ state: 'done', decision: 'denied' });

    now += RESULT_TTL_MS + 1;
    expect(await reg.wait('x', 'alice', 'i1', 10)).toBe('not_found');
  });

  it('returns a finished result once, then forgets it; a waiter wakes on abort of its request', async () => {
    const reg = new ExecutionRegistry();
    reg.adopt({ id: 'y', owner: 'alice', instanceId: 'i1', approval: approval('p1'), abort: () => {} });
    const ac = new AbortController();
    const waiting = reg.wait('y', 'alice', 'i1', 60_000, ac.signal);
    ac.abort();
    expect(await waiting).toMatchObject({ status: 'awaiting_approval' });
    reg.finish('y', { ok: true, value: 'done', truncated: false, logs: [] });
    expect(await reg.wait('y', 'alice', 'i1', 10)).toMatchObject({ ok: true, value: 'done' });
    expect(await reg.wait('y', 'alice', 'i1', 10)).toBe('not_found');
  });
});

describe('SessionGrantService', () => {
  it('keeps one grant per client and endpoint, ends it at expiry, on revoke and per endpoint, and audits each', () => {
    const db = openDatabase(':memory:');
    let now = Date.now();
    const grants = new SessionGrantService(db, () => new Date(now));
    const base = { instanceId: 'i1', principal: 'alice', createdBy: 'admin', approvalId: 'a1' };
    const g1 = grants.create({ ...base, expiresAt: new Date(now + 60_000) });
    const g2 = grants.create({ ...base, expiresAt: new Date(now + 120_000) });
    expect(grants.active('i1', 'alice')?.id).toBe(g2.id);
    expect(grants.get(g1.id)).toBeUndefined();
    expect(grants.active('i1', 'bob')).toBeUndefined();

    now += 120_001;
    expect(grants.active('i1', 'alice')).toBeUndefined();

    const g3 = grants.create({ ...base, expiresAt: new Date(now + 60_000) });
    expect(grants.revoke(g3.id, { actorKind: 'user', actorId: 'u1' })).toBe(true);
    expect(grants.revoke(g3.id, { actorKind: 'user', actorId: 'u1' })).toBe(false);

    grants.create({ ...base, expiresAt: new Date(now + 60_000) });
    grants.create({ ...base, instanceId: 'i2', expiresAt: new Date(now + 60_000) });
    grants.endForInstance('i1', 'endpoint_stopped');
    expect(grants.list().map((g) => g.instanceId)).toEqual(['i2']);

    const reasons = db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.decision === 'session_grant.ended')
      .map((a) => (a.detail as { reason: string }).reason);
    expect(reasons).toEqual(['replaced', 'expired', 'revoked', 'endpoint_stopped']);
  });
});

describe('parked executions', () => {
  async function setup() {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'synoikia-park-'));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const ctx: AppContext = await createTestApp({ DATA_DIR: dataDir }, { memoryDb: true });
    cleanup.push(() => ctx.stop());
    const instance = await ctx.instances.create({ pluginId: 'echo', slug: 'echo', connection: {} });
    await ctx.instances.syncNow(instance.id);
    setGroupLevel(ctx.db, instance.id, 'echo', 'ask');
    const caller = (id = 'chat', extra: Partial<CallerContext> = {}): CallerContext => ({
      client: { kind: 'mcp_client', id },
      principal: { ceiling: 'write' as const, roleId: 'admin' },
      parkable: true,
      ...extra,
    });
    const exec = (code: string, c = caller(), signal?: AbortSignal) =>
      executeCode(ctx.gateDeps(), ctx.instances.runtime(instance.id), c, code, signal);
    const resume = (id: string, c = caller()) =>
      resumeExecution(ctx.gateDeps(), ctx.instances.runtime(instance.id), c, id);
    return { ctx, instanceId: instance.id, caller, exec, resume };
  }
  const SET = `return (await echo.call('echo.set', { name: 'vol/a' })).key;`;
  const pendingId = (ctx: AppContext, r: unknown) =>
    ctx.links.resolve((r as PendingResult).approval!.path.slice(3))!.approvalId;

  it('outlives the request that started it, and keeps running at the decision', async () => {
    const t = await setup();
    const request = new AbortController();
    const parked = (await t.exec(SET, t.caller(), request.signal)) as PendingResult;
    expect(parked).toMatchObject({ ok: false, status: 'awaiting_approval' });
    request.abort(); // the tool call is over
    expect(sandboxesRunning()).toBeGreaterThan(0);
    t.ctx.approvals.decide(pendingId(t.ctx, parked), { approve: true, decidedBy: 'admin' });
    expect(await t.resume(parked.executionId)).toMatchObject({ ok: true, value: 'echo.set' });
  });

  it('does not park for callers that cannot, and denies past the cap', async () => {
    const t = await setup();
    expect(await t.exec(SET, t.caller('script', { parkable: false }))).toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('cannot show approval prompts') },
    });
    const parked = [];
    for (let i = 0; i < PARKED_LIMIT.perPrincipalInstance; i++) parked.push(await t.exec(SET));
    expect(await t.exec(SET)).toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('too many earlier calls') },
    });
    // Prompts still come first: a URL-prompt client is never parked.
    const viaUrl = t.exec(
      SET,
      t.caller('url-client', {
        prompts: {
          url: async (req) => {
            setTimeout(() => t.ctx.approvals.decide(req.approvalId, { approve: true, decidedBy: 'admin' }), 5);
            return { action: 'accept' };
          },
        },
      }),
    );
    expect(await viaUrl).toMatchObject({ ok: true });
    for (const p of parked) t.ctx.approvals.decide(pendingId(t.ctx, p), { approve: false, decidedBy: 'admin' });
  });

  it('ends parked runs when the endpoint stops, and tells resume the call was cancelled', async () => {
    const t = await setup();
    const parked = (await t.exec(SET)) as PendingResult;
    t.ctx.events.emit('instance.status', { instanceId: t.instanceId, slug: 'echo', status: 'stopped' });
    expect(await t.resume(parked.executionId)).toMatchObject({
      ok: false,
      error: { code: expect.stringMatching(/PERMISSION_DENIED|EXECUTION_ENDED/) },
    });
  });

  it('reports an unknown execution without telling whose it is', async () => {
    const t = await setup();
    const parked = (await t.exec(SET)) as PendingResult;
    expect(await t.resume(parked.executionId, t.caller('someone-else'))).toMatchObject({
      error: { code: 'EXECUTION_NOT_FOUND' },
    });
    expect(await t.resume('00000000-0000-4000-8000-000000000000')).toMatchObject({
      error: { code: 'EXECUTION_NOT_FOUND' },
    });
    t.ctx.approvals.decide(pendingId(t.ctx, parked), { approve: false, decidedBy: 'admin' });
  });

  it('stops asking after an approval is not given, so a retry loop cannot hold a parked slot', async () => {
    const t = await setup();
    const parked = (await t.exec(`const codes = [];
      for (let i = 0; i < 3; i++) {
        try { await echo.call('echo.set', { name: 'x' + i }); codes.push('ok'); } catch (e) { codes.push(e.code); }
      }
      return codes;`)) as PendingResult;
    t.ctx.approvals.decide(pendingId(t.ctx, parked), { approve: false, decidedBy: 'admin' });
    expect(await t.resume(parked.executionId)).toMatchObject({
      ok: true,
      value: ['PERMISSION_DENIED', 'PERMISSION_DENIED', 'PERMISSION_DENIED'],
    });
    const refused = t.ctx.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.decision === 'denied');
    expect(refused.length).toBe(3);
    expect(t.ctx.executions.hasRoom('chat', t.instanceId)).toBe(true);
  });

  it('refuses the approved call when the credential was revoked while it waited', async () => {
    const t = await setup();
    let live = true;
    const c = t.caller('chat', { stillAuthorized: () => live });
    const parked = (await t.exec(SET, c)) as PendingResult;
    live = false;
    t.ctx.approvals.decide(pendingId(t.ctx, parked), { approve: true, decidedBy: 'admin' });
    expect(await t.resume(parked.executionId, c)).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_DISABLED', message: expect.stringContaining('revoked') },
    });
  });

  it('a grant still respects the write rate limit and never covers typed-confirmation operations', async () => {
    const t = await setup();
    t.ctx.grants.create({
      instanceId: t.instanceId,
      principal: 'chat',
      createdBy: 'admin',
      approvalId: 'x',
      expiresAt: new Date(Date.now() + 60_000),
    });
    t.ctx.db
      .update(pluginInstances)
      .set({ settings: { writesPerMinute: 1 } })
      .run();
    expect(await t.exec(SET)).toMatchObject({ ok: true });
    expect(await t.exec(SET)).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });

    // A typed confirmation (here without a literal from the plugin) goes to a human, not the grant.
    t.ctx.db.update(pluginInstances).set({ settings: {} }).run();
    t.ctx.db.update(operations).set({ typedConfirmation: true }).where(eq(operations.key, 'echo.set')).run();
    expect(await t.exec(SET, t.caller('chat'))).toMatchObject({
      ok: false,
      error: { code: 'PLUGIN_ERROR', message: expect.stringContaining('confirmation value') },
    });
  });

  it('a grant never covers typed-confirmation or locked operations, nor a read-only credential', async () => {
    const t = await setup();
    t.ctx.grants.create({
      instanceId: t.instanceId,
      principal: 'chat',
      createdBy: 'admin',
      approvalId: 'x',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await t.exec(SET)).toMatchObject({ ok: true });
    // echo.delete is locked and asks for a typed confirmation: it still parks.
    const del = t.ctx.db.select().from(operations).where(eq(operations.key, 'echo.delete')).get()!;
    updateOperation(t.ctx.db, t.instanceId, del.id, { level: 'ask' });
    const locked = await t.exec(`await echo.call('echo.delete', { name: 'vol/x' });`);
    expect(locked).toMatchObject({ status: 'awaiting_approval' });
    t.ctx.approvals.decide(pendingId(t.ctx, locked), { approve: false, decidedBy: 'admin' });
    const readOnly = await t.exec(SET, { ...t.caller(), principal: { ceiling: 'read' as const, roleId: 'admin' } });
    expect(readOnly).toMatchObject({ ok: false, error: { code: 'OPERATION_DISABLED' } });
    // The catalog tells the agent the grant makes the write run straight away.
    const found = await searchCode(
      t.ctx.gateDeps(),
      t.ctx.instances.runtime(t.instanceId),
      t.caller(),
      `return (await catalog.get('echo.set')).approval;`,
    );
    expect(found).toMatchObject({ ok: true, value: 'auto' });
  });
});
