import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { UrlPromptRequest } from '../src/approvals/service.js';
import { currentStep, totpAt } from '../src/auth/totp.js';
import { setGroupLevel, updateOperation } from '../src/catalog/groups.js';
import { updateSettings } from '../src/settings.js';
import { auditLog, operations, pluginInstances } from '../src/db/schema.js';
import { createMcpApp } from '../src/http/mcp-app.js';
import { executeCode } from '../src/runtime/index.js';
import { createTestApp } from './helpers.js';

const PASSWORD = 'correct horse battery';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function formBrowser(app: Pick<Hono, 'request'>) {
  const jar = new Map<string, string>();
  return async (url: string, fields?: Record<string, string>) => {
    const headers: Record<string, string> = {};
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (fields) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await app.request(url, {
      method: fields ? 'POST' : 'GET',
      headers,
      body: fields ? new URLSearchParams(fields).toString() : undefined,
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const i = pair!.indexOf('=');
      const value = pair!.slice(i + 1);
      if (value) jar.set(pair!.slice(0, i), value);
      else jar.delete(pair!.slice(0, i));
    }
    return res;
  };
}
const hidden = (page: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(page)?.[1] ?? '';

/** An echo endpoint at Ask, an admin (with TOTP unless `totp: false`) and one call awaiting approval. */
async function withPendingCall(code: string, opts: { totp?: boolean; lockedAsk?: boolean } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'synoikia-approval-'));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  let clock = Date.now();
  const ctx = await createTestApp({ DATA_DIR: dataDir }, { memoryDb: true, now: () => new Date(clock) });
  cleanup.push(() => ctx.stop());

  const admin = await ctx.users.create({ username: 'admin', password: PASSWORD });
  let secret = '';
  let recoveryCodes: string[] = [];
  const step = currentStep();
  if (opts.totp !== false) {
    secret = ctx.users.beginTotp(admin.id).secret;
    recoveryCodes = ctx.users.confirmTotp(admin.id, totpAt(secret, step - 1));
  }

  const instance = await ctx.instances.create({ pluginId: 'echo', slug: 'echo', connection: {} });
  await ctx.instances.syncNow(instance.id);
  setGroupLevel(ctx.db, instance.id, 'echo', 'ask');
  if (opts.lockedAsk) {
    const del = ctx.db.select().from(operations).where(eq(operations.key, 'echo.delete')).get()!;
    updateOperation(ctx.db, instance.id, del.id, { level: 'ask' });
  }

  const opened: UrlPromptRequest[] = [];
  const run = executeCode(
    ctx.gateDeps(),
    ctx.instances.runtime(instance.id),
    {
      client: { kind: 'mcp_client', id: 'claude' },
      principal: { ceiling: 'write' },
      prompts: {
        url: async (req) => {
          opened.push(req);
          return { action: 'accept' };
        },
      },
    },
    code,
  );
  for (let i = 0; i < 200 && opened.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  const browse = formBrowser(createMcpApp(ctx));

  /** Signs in through the MCP-port login (password, then the current TOTP step). */
  const signIn = async (page: string) => {
    const login = await (await browse(page)).text();
    expect(login).toContain('Sign in to review this approval request');
    const afterPassword = await browse('/oauth/login', {
      username: 'admin',
      password: PASSWORD,
      csrf: hidden(login, 'csrf'),
      continue: page,
    });
    if (opts.totp === false) return afterPassword;
    const totpForm = await afterPassword.text();
    return browse('/oauth/login/totp', {
      mfa: hidden(totpForm, 'mfa'),
      csrf: hidden(totpForm, 'csrf'),
      continue: page,
      code: totpAt(secret, step),
    });
  };
  return {
    ctx,
    run,
    browse,
    signIn,
    page: opened[0]!.path,
    nextCode: () => totpAt(secret, step + 1),
    recoveryCodes,
    adminId: admin.id,
    advance: (ms: number) => (clock += ms),
  };
}

describe('approval page', () => {
  it('needs a signed-in user with TOTP and a POST: opening the link alone decides nothing', async () => {
    const t = await withPendingCall(
      `return (await echo.call('echo.set', { name: 'vol/a', password: 'hunter2' })).key;`,
    );
    expect(t.page).toMatch(/^\/a\/[\w-]+$/);

    const signedIn = await t.signIn(t.page);
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get('location')).toBe(t.page);
    expect(t.ctx.db.select().from(auditLog).where(eq(auditLog.decidedVia, 'url')).all()).toHaveLength(0);

    const pageHtml = await (await t.browse(t.page)).text();
    expect(pageHtml).toContain('echo.set');
    expect(pageHtml).not.toContain('hunter2');
    expect(pageHtml).toContain('Signed in as <strong>admin</strong>');
    expect(pageHtml).not.toContain('Authenticator code'); // this session already proved TOTP

    // Without the CSRF field the POST is refused.
    expect((await t.browse(t.page, { decision: 'approve' })).status).toBe(400);
    const done = await t.browse(t.page, { decision: 'approve', csrf: hidden(pageHtml, 'csrf') });
    expect(await done.text()).toContain('was approved');
    await expect(t.run).resolves.toMatchObject({ ok: true, value: 'echo.set' });
    const audit = t.ctx.db.select().from(auditLog).where(eq(auditLog.decidedVia, 'url')).all();
    expect(audit.map((a) => [a.decision, a.actorId, a.decidedBy])).toEqual([['human-approved', 'claude', 'admin']]);

    // The link is burnt once decided.
    expect((await t.browse(t.page)).status).toBe(404);
  });

  it('asks locked operations for a fresh TOTP and the typed confirmation, and can deny', async () => {
    const t = await withPendingCall(`return (await echo.call('echo.delete', { name: 'vol/x' })).key;`, {
      lockedAsk: true,
    });
    await t.signIn(t.page);
    // Sign-in proved TOTP a moment ago: no second code yet.
    expect(await (await t.browse(t.page)).text()).not.toContain('Authenticator code');

    t.advance(6 * 60_000);
    const pageHtml = await (await t.browse(t.page)).text();
    expect(pageHtml).toContain('Type <code>vol/x</code> to approve');
    expect(pageHtml).toContain('Authenticator code');
    const csrf = hidden(pageHtml, 'csrf');

    const noCode = await t.browse(t.page, { decision: 'approve', confirm: 'vol/x', csrf });
    expect(noCode.status).toBe(400);
    expect(await noCode.text()).toContain('valid authenticator code');

    const wrongLiteral = await t.browse(t.page, { decision: 'approve', confirm: 'nope', totp: t.nextCode(), csrf });
    expect(wrongLiteral.status).toBe(400);
    expect(await wrongLiteral.text()).toContain('exactly to approve');

    // The code above was accepted, so only the decision is left; deny it.
    expect(await (await t.browse(t.page, { decision: 'deny', csrf })).text()).toContain('was denied');
    await expect(t.run).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });

  it('never accepts or uses up a recovery code in place of a TOTP code', async () => {
    const t = await withPendingCall(`return (await echo.call('echo.delete', { name: 'vol/x' })).key;`, {
      lockedAsk: true,
    });
    await t.signIn(t.page);
    t.advance(6 * 60_000);
    const csrf = hidden(await (await t.browse(t.page)).text(), 'csrf');
    const before = t.ctx.users.get(t.adminId).recoveryCodesHash?.length;
    const res = await t.browse(t.page, {
      decision: 'approve',
      confirm: 'vol/x',
      totp: t.recoveryCodes[0]!,
      csrf,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('valid authenticator code');
    expect(t.ctx.users.get(t.adminId).recoveryCodesHash?.length).toBe(before);
    // Still good for signing in.
    expect(t.ctx.users.verifySecondFactor(t.adminId, t.recoveryCodes[0]!)).toBe('recovery');
    t.ctx.approvals.cancelAll();
    await t.run;
  });

  it('refuses users without TOTP', async () => {
    const t = await withPendingCall(`await echo.call('echo.set', { name: 'x' });`, { totp: false });
    await t.signIn(t.page);
    const res = await t.browse(t.page);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Two-factor authentication required');
    t.ctx.approvals.cancelAll();
    await t.run;
  });

  it('enforces "require two-factor" on the MCP-port sign-in (it faces the internet)', async () => {
    const t = await withPendingCall(`await echo.call('echo.set', { name: 'x' });`, { totp: false });
    updateSettings(t.ctx.db, 'security', { requireTotp: true });
    const res = await t.signIn(t.page);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('requires two-factor authentication');
    // No session was started: the page still asks to sign in.
    expect(await (await t.browse(t.page)).text()).toContain('Sign in to review this approval request');
    t.ctx.approvals.cancelAll();
    await t.run;
  });

  it('keeps approval sign-ins apart from OAuth consent sign-ins (review L14)', async () => {
    const t = await withPendingCall(`return (await echo.call('echo.set', { name: 'vol/a' })).key;`);
    const signedIn = await t.signIn(t.page);
    const cookie = signedIn.headers.getSetCookie().find((c) => c.startsWith('syn_mcp_approve='))!;
    expect(cookie).toMatch(/Path=\/a(;|$)/);
    expect(cookie).toMatch(/HttpOnly/);
    const raw = cookie.slice('syn_mcp_approve='.length).split(';')[0]!;
    const limits = { idleMs: 60 * 60_000, absoluteMs: 24 * 60 * 60_000 };
    expect(t.ctx.sessions.validate(raw, 'approval_ui', limits)).not.toBeNull();
    // The same session can't stand in for a consent sign-in.
    expect(t.ctx.sessions.validate(raw, 'oauth_ui', limits)).toBeNull();
    expect(signedIn.headers.getSetCookie().some((c) => c.startsWith('syn_mcp_oauth='))).toBe(false);
  });

  it('offers "Approve for this session"; the grant then covers that client’s later Ask calls', async () => {
    const t = await withPendingCall(`return (await echo.call('echo.set', { name: 'vol/a' })).key;`);
    await t.signIn(t.page);
    const html = await (await t.browse(t.page)).text();
    expect(html).toContain('Approve once');
    expect(html).toContain('Approve for this session');
    expect(html).toMatch(/<option value="1"/);
    expect(html).toMatch(/<option value="4"/);
    // Approving once stays the main action; a session grant is the deliberate one.
    expect(html).toMatch(/class="primary" type="submit" name="decision" value="approve"/);
    expect(html).toContain('<strong>claude</strong>');

    // A length the page did not offer is refused.
    const bad = await t.browse(t.page, { csrf: hidden(html, 'csrf'), decision: 'approve_session', grant: '99' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('Choose a session length');

    const res = await t.browse(t.page, { csrf: hidden(html, 'csrf'), decision: 'approve_session', grant: '1' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('run without asking until');
    expect(await t.run).toMatchObject({ ok: true, value: 'echo.set' });
    const [grant] = t.ctx.grants.list();
    expect(grant).toMatchObject({ principal: 'claude', createdBy: 'admin' });
    expect(grant!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(3_600_000 + 5_000);

    const instanceId = grant!.instanceId;
    const caller = { client: { kind: 'mcp_client' as const, id: 'claude' }, principal: { ceiling: 'write' as const } };
    const again = await executeCode(
      t.ctx.gateDeps(),
      t.ctx.instances.runtime(instanceId),
      caller,
      `return (await echo.call('echo.set', { name: 'vol/b' })).key;`,
    );
    expect(again).toMatchObject({ ok: true, value: 'echo.set' });
    const last = t.ctx.db.select().from(auditLog).all().at(-1)!;
    expect(last.decision).toBe(`auto-approved:grant:${grant!.id}`);

    // Another client is not covered.
    const stranger = await executeCode(
      t.ctx.gateDeps(),
      t.ctx.instances.runtime(instanceId),
      { ...caller, client: { kind: 'mcp_client', id: 'other' } },
      `return (await echo.call('echo.set', { name: 'vol/c' })).key;`,
    );
    expect(stranger).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(
      t.ctx.db
        .select()
        .from(auditLog)
        .all()
        .some((a) => a.decision === 'session_grant.created'),
    ).toBe(true);
  });

  it('never offers a session grant for locked operations, or when the endpoint turns it off', async () => {
    const locked = await withPendingCall(`await echo.call('echo.delete', { name: 'vol/x' });`, { lockedAsk: true });
    await locked.signIn(locked.page);
    expect(await (await locked.browse(locked.page)).text()).not.toContain('Approve for this session');
    locked.ctx.approvals.cancelAll();
    await locked.run;

    const off = await withPendingCall(`await echo.call('echo.set', { name: 'x' });`);
    // Straight to the row: an update through the manager restarts the endpoint and cancels the approval.
    off.ctx.db
      .update(pluginInstances)
      .set({ settings: { sessionGrantMaxHours: 0 } })
      .run();
    await off.signIn(off.page);
    const html = await (await off.browse(off.page)).text();
    expect(html).not.toContain('Approve for this session');
    // Even a forged POST gets no grant.
    const res = await off.browse(off.page, { csrf: hidden(html, 'csrf'), decision: 'approve_session', grant: '1' });
    expect(res.status).toBe(400);
    expect(off.ctx.grants.list()).toEqual([]);
    off.ctx.approvals.cancelAll();
    await off.run;
  });

  it('keeps the approval browser signed in for hours and asks for TOTP only once', async () => {
    const t = await withPendingCall(`return (await echo.call('echo.set', { name: 'vol/a' })).key;`);
    await t.signIn(t.page);
    const html = await (await t.browse(t.page)).text();
    await t.browse(t.page, { csrf: hidden(html, 'csrf'), decision: 'approve' });
    await t.run;

    t.advance(3 * 60 * 60_000); // past the old 60-minute limit, within 12 h idle
    const opened: UrlPromptRequest[] = [];
    const instanceId = t.ctx.instances.list()[0]!.id;
    const run = executeCode(
      t.ctx.gateDeps(),
      t.ctx.instances.runtime(instanceId),
      {
        client: { kind: 'mcp_client', id: 'claude' },
        principal: { ceiling: 'write' },
        prompts: { url: async (req) => (opened.push(req), { action: 'accept' }) },
      },
      `return (await echo.call('echo.set', { name: 'vol/b' })).key;`,
    );
    for (let i = 0; i < 200 && opened.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const second = await (await t.browse(opened[0]!.path)).text();
    expect(second).toContain('Signed in as <strong>admin</strong>');
    expect(second).not.toContain('Authenticator code');
    await t.browse(opened[0]!.path, { csrf: hidden(second, 'csrf'), decision: 'approve' });
    expect(await run).toMatchObject({ ok: true });

    // The approval session follows the admin's settings.
    updateSettings(t.ctx.db, 'security', { approvalSessionIdleHours: 1 });
    t.advance(2 * 60 * 60_000);
    const cancelled = executeCode(
      t.ctx.gateDeps(),
      t.ctx.instances.runtime(instanceId),
      {
        client: { kind: 'mcp_client', id: 'claude' },
        principal: { ceiling: 'write' },
        prompts: { url: async (req) => (opened.push(req), { action: 'accept' }) },
      },
      `await echo.call('echo.set', { name: 'vol/c' });`,
    );
    for (let i = 0; i < 200 && opened.length === 1; i++) await new Promise((r) => setTimeout(r, 10));
    expect(await (await t.browse(opened[1]!.path)).text()).toContain('Sign in to review this approval request');
    t.ctx.approvals.cancelAll();
    await cancelled;
  });

  it('rejects unknown tokens', async () => {
    const t = await withPendingCall(`await echo.call('echo.set', { name: 'x' });`);
    expect((await t.browse('/a/not-a-real-token-at-all-000000')).status).toBe(404);
    expect((await t.browse('/a/short')).status).toBe(404);
    t.ctx.approvals.cancelAll();
    await t.run;
  });
});
