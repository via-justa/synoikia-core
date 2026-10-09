import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitationCompleteNotificationSchema, ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/app.js';
import { setGroupLevel, updateOperation } from '../src/catalog/groups.js';
import { setRoleLevel } from '../src/catalog/role-levels.js';
import { auditLog, operations } from '../src/db/schema.js';
import { hostAllowed, LogThrottle, MAX_SESSIONS_PER_PRINCIPAL } from '../src/http/mcp/endpoint.js';
import { createAdminApp } from '../src/http/admin-app.js';
import { createMcpApp } from '../src/http/mcp-app.js';
import { createLogger } from '../src/log.js';
import type { Logger, LogLevel } from '../src/log.js';
import { startServers } from '../src/server.js';
import type { RunningServers } from '../src/server.js';
import { updateSettings } from '../src/settings.js';
import { browser } from './admin-client.js';
import { createTestApp } from './helpers.js';

/** End to end over HTTP: MCP SDK client ↔ `/{slug}` ↔ gate ↔ plugin child, with bearer tokens, the
 * full OAuth 2.1 flow and URL-mode approvals. */

const PASSWORD = 'correct horse battery';

let ctx: AppContext;
let servers: RunningServers;
let dataDir: string;
let base: string;
let instanceId: string;
let otherInstanceId: string;
let adminId: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'synoikia-e2e-'));
  ctx = await createTestApp(
    {
      DATA_DIR: dataDir,
      MCP_HOST: '127.0.0.1',
      MCP_PORT: '0',
      ADMIN_HOST: '127.0.0.1',
      ADMIN_PORT: '0',
    },
    { memoryDb: true },
  );
  adminId = (await ctx.users.create({ username: 'admin', password: PASSWORD })).id;
  servers = await startServers(ctx);
  base = `http://127.0.0.1:${servers.mcp.port}`;
  // OAuth is off until the public URL is known (review M12); the port is only known now.
  (ctx.config as { PUBLIC_MCP_URL?: string }).PUBLIC_MCP_URL = base;
  instanceId = (await ctx.instances.create({ pluginId: 'echo', slug: 'echo', connection: {} })).id;
  otherInstanceId = (await ctx.instances.create({ pluginId: 'echo', slug: 'echo-two', connection: {} })).id;
  await ctx.instances.syncNow(instanceId);
  // Every write asks; the locked echo.delete is opened with its own Ask.
  setGroupLevel(ctx.db, instanceId, 'echo', 'ask');
  const del = ctx.db
    .select()
    .from(operations)
    .where(eq(operations.key, 'echo.delete'))
    .all()
    .find((o) => o.instanceId === instanceId)!;
  updateOperation(ctx.db, instanceId, del.id, { level: 'ask' });
}, 30_000);

afterAll(async () => {
  await servers?.close();
  await ctx?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

type ElicitParams = { mode?: string; message: string; url?: string; elicitationId?: string };

/** `form`: a client answering every form; `url`: a URL-prompt client whose `onElicit` plays the user. */
async function connect(
  slug: string,
  token: string,
  prompts?: { mode: 'form' | 'url'; onElicit: (params: ElicitParams) => Record<string, unknown> | 'decline' },
) {
  const capabilities = prompts ? { elicitation: prompts.mode === 'url' ? { url: {} } : {} } : {};
  const client = new Client({ name: 'e2e', version: '1.0.0' }, { capabilities });
  if (prompts) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const out = prompts.onElicit(req.params as ElicitParams);
      if (out === 'decline') return { action: 'decline' };
      return prompts.mode === 'url'
        ? { action: 'accept' }
        : { action: 'accept', content: out as Record<string, string | number | boolean> };
    });
  }
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/${slug}`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

/** The approval behind a parked result's page link. */
const approvalIdOf = (res: Record<string, unknown>) => {
  const url = (res.approval as { url: string }).url;
  return ctx.links.resolve(new URL(url).pathname.slice('/a/'.length))!.approvalId;
};

const parse = (res: unknown) =>
  JSON.parse((res as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>;

describe('MCP endpoint with bearer tokens', () => {
  it('exposes search, execute and resume (plus the card’s app-only tools), with plugin-specific descriptions', async () => {
    const { token } = ctx.tokens.create({ name: 'e2e', scope: [instanceId] }, { userId: adminId });
    const client = await connect('echo', token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'approval_status',
      'execute',
      'resume',
      'search',
      'session_grant_revoke',
    ]);
    const meta = (name: string) => tools.find((t) => t.name === name)?._meta as { ui?: Record<string, unknown> };
    expect(meta('execute').ui).toEqual({ resourceUri: 'ui://synoikia/approval' });
    expect(meta('approval_status').ui?.visibility).toEqual(['app']);
    expect(meta('session_grant_revoke').ui?.visibility).toEqual(['app']);
    const card = await client.readResource({ uri: 'ui://synoikia/approval' });
    const html = (card.contents[0] as { text: string; mimeType: string }).text;
    expect(card.contents[0]!.mimeType).toBe('text/html;profile=mcp-app');
    // No external origins, and the card has no way to approve.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/totp|approve_session/i);
    const called = [...html.matchAll(/name: '(\w+)'/g)].map((m) => m[1]);
    expect(new Set(called)).toEqual(new Set(['approval_status', 'session_grant_revoke']));
    expect(tools.find((t) => t.name === 'execute')?.description).toContain('echo.call(…)');
    expect(tools.find((t) => t.name === 'search')?.description).toContain('guides.get(key)');
    expect(tools.find((t) => t.name === 'search')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((t) => t.name === 'execute')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    await client.close();
  });

  it('runs search and read-only execute, redacting secrets', async () => {
    const { token } = ctx.tokens.create({ name: 'e2e', scope: ['*'] }, { userId: adminId });
    const client = await connect('echo', token);
    const found = parse(
      await client.callTool({
        name: 'search',
        arguments: { code: `return (await catalog.find({ classification: 'read' })).map((o) => o.key);` },
      }),
    );
    expect(found).toEqual({ result: ['echo.query'] });
    const res = parse(
      await client.callTool({
        name: 'execute',
        arguments: { code: `return await echo.call('echo.query', { q: 1 });` },
      }),
    );
    expect(res).toEqual({ result: { key: 'echo.query', params: { q: 1 }, password: '[REDACTED]' } });
    await client.close();
  });

  it('never takes a form-only client’s own answer as approval', async () => {
    const { token } = ctx.tokens.create({ name: 'e2e', scope: [instanceId], access: 'write' }, { userId: adminId });
    const shown: ElicitParams[] = [];
    const client = await connect('echo', token, {
      mode: 'form',
      onElicit: (p) => {
        shown.push(p);
        return { approve: true, confirm: 'vol/x' };
      },
    });
    for (const code of [
      `await echo.call('echo.set', { name: 'vol/a' });`,
      `await echo.call('echo.delete', { name: 'vol/x' });`,
    ]) {
      // The call parks with a link to the approval page instead of asking the client.
      const res = parse(await client.callTool({ name: 'execute', arguments: { code } }));
      expect(res).toMatchObject({ status: 'awaiting_approval', approval: { url: expect.stringMatching(/\/a\//) } });
      ctx.approvals.decide(approvalIdOf(res), { approve: false, decidedBy: 'admin' });
      const after = parse(await client.callTool({ name: 'resume', arguments: { executionId: res.executionId } }));
      expect(after).toMatchObject({ error: 'PERMISSION_DENIED' });
    }
    expect(shown).toEqual([]);
    await client.close();
  });

  it('parks a call for a client without prompts; each write runs once and resume returns the result', async () => {
    const { token } = ctx.tokens.create({ name: 'parker', scope: [instanceId], access: 'write' }, { userId: adminId });
    const client = await connect('echo', token);
    const first = parse(
      await client.callTool({
        name: 'execute',
        arguments: {
          code: `const a = await echo.call('echo.set', { name: 'vol/p' });
                 const b = await echo.call('echo.set', { name: 'vol/q' });
                 return [a.params.name, b.params.name];`,
        },
      }),
    );
    expect(first).toMatchObject({
      status: 'awaiting_approval',
      approval: { operationKey: 'echo.set', url: expect.stringContaining(`${base}/a/`) },
    });
    const executionId = first.executionId as string;
    const status = async () =>
      (await client.callTool({ name: 'approval_status', arguments: { executionId } })).structuredContent;
    expect(await status()).toMatchObject({ state: 'pending' });

    // Another credential can neither follow nor see it.
    const { token: other } = ctx.tokens.create({ name: 'other', scope: [instanceId], access: 'write' }, { userId: adminId });
    const stranger = await connect('echo', other);
    expect(parse(await stranger.callTool({ name: 'resume', arguments: { executionId } }))).toMatchObject({
      error: 'EXECUTION_NOT_FOUND',
    });
    expect(
      (await stranger.callTool({ name: 'approval_status', arguments: { executionId } })).structuredContent,
    ).toEqual({ state: 'not_found' });
    await stranger.close();

    const firstId = approvalIdOf(first);
    ctx.approvals.decide(firstId, { approve: true, decidedBy: 'admin' });
    const second = parse(await client.callTool({ name: 'resume', arguments: { executionId } }));
    expect(second).toMatchObject({ status: 'awaiting_approval', executionId });
    const secondId = approvalIdOf(second);
    expect(secondId).not.toBe(firstId);
    ctx.approvals.decide(secondId, { approve: true, decidedBy: 'admin' });
    const done = parse(await client.callTool({ name: 'resume', arguments: { executionId } }));
    expect(done).toEqual({ result: ['vol/p', 'vol/q'] });

    const trail = ctx.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => (a.detail as { executionId?: string } | null)?.executionId === executionId)
      .map((a) => `${a.decision}:${a.actorId}`);
    expect(trail.filter((d) => d.startsWith('awaiting_approval'))).toHaveLength(2);
    expect(trail.filter((d) => d.startsWith('human-approved'))).toHaveLength(2);
    // The stranger's attempt is audited too.
    expect(trail.filter((d) => d.startsWith('resumed')).sort()).toEqual([
      'resumed:token:other',
      'resumed:token:parker',
      'resumed:token:parker',
    ]);
    // Collected: the id is gone.
    expect(parse(await client.callTool({ name: 'resume', arguments: { executionId } }))).toMatchObject({
      error: 'EXECUTION_NOT_FOUND',
    });
    await client.close();
  });

  it('a session grant runs later Ask writes of that client without asking, never locked ones, until revoked', async () => {
    const { token } = ctx.tokens.create({ name: 'granted', scope: [instanceId], access: 'write' }, { userId: adminId });
    const client = await connect('echo', token);
    const exec = async (code: string) => parse(await client.callTool({ name: 'execute', arguments: { code } }));
    const first = await exec(`return (await echo.call('echo.set', { name: 'vol/g' })).key;`);
    ctx.approvals.decide(approvalIdOf(first), {
      approve: true,
      decidedBy: 'admin',
      sessionGrantUntil: new Date(Date.now() + 3_600_000),
    });
    const done = await client.callTool({ name: 'resume', arguments: { executionId: first.executionId as string } });
    expect(parse(done)).toEqual({ result: 'echo.set' });
    const grant = (done.structuredContent as { sessionGrant: { id: string } }).sessionGrant;
    expect(grant.id).toBeTruthy();

    expect(await exec(`return (await echo.call('echo.set', { name: 'vol/h' })).key;`)).toEqual({ result: 'echo.set' });
    const covered = ctx.db.select().from(auditLog).all().at(-1)!;
    expect(covered.decision).toBe(`auto-approved:grant:${grant.id}`);
    const locked = await exec(`return (await echo.call('echo.delete', { name: 'vol/x' })).key;`);
    expect(locked).toMatchObject({ status: 'awaiting_approval' });
    ctx.approvals.decide(approvalIdOf(locked), { approve: false, decidedBy: 'admin' });

    // Another credential can't end it.
    const { token: other } = ctx.tokens.create({ name: 'other2', scope: [instanceId], access: 'write' }, { userId: adminId });
    const stranger = await connect('echo', other);
    const tried = await stranger.callTool({ name: 'session_grant_revoke', arguments: { grantId: grant.id } });
    expect(parse(tried)).toEqual({ revoked: false });
    await stranger.close();

    await client.callTool({ name: 'session_grant_revoke', arguments: { grantId: grant.id } });
    const again = await exec(`return (await echo.call('echo.set', { name: 'vol/i' })).key;`);
    expect(again).toMatchObject({ status: 'awaiting_approval' });
    ctx.approvals.decide(approvalIdOf(again), { approve: false, decidedBy: 'admin' });
    await client.close();
  });

  it('sends the user to the approval page (URL prompt) and continues once a human decides there', async () => {
    const { token } = ctx.tokens.create({ name: 'e2e', scope: [instanceId], access: 'write' }, { userId: adminId });
    const shown: ElicitParams[] = [];
    const completed: string[] = [];
    const client = await connect('echo', token, {
      mode: 'url',
      onElicit: (p) => {
        shown.push(p);
        // The human approves on the page (here straight through the service the page calls).
        setTimeout(
          () =>
            ctx.approvals.decide(p.elicitationId!, {
              approve: true,
              confirm: p.message.includes('echo.delete') ? 'vol/x' : undefined,
              decidedBy: 'admin',
            }),
          20,
        );
        return {};
      },
    });
    client.setNotificationHandler(ElicitationCompleteNotificationSchema, (n) => {
      completed.push(n.params.elicitationId);
    });

    const set = parse(
      await client.callTool({
        name: 'execute',
        arguments: { code: `return (await echo.call('echo.set', { name: 'vol/a' })).key;` },
      }),
    );
    expect(set).toEqual({ result: 'echo.set' });
    const del = parse(
      await client.callTool({
        name: 'execute',
        arguments: { code: `return (await echo.call('echo.delete', { name: 'vol/x' })).key;` },
      }),
    );
    expect(del).toEqual({ result: 'echo.delete' });

    expect(shown.map((p) => p.mode)).toEqual(['url', 'url']);
    for (const p of shown) expect(p.url?.startsWith(`${base}/a/`)).toBe(true);
    // The client never sees the confirmation prompt.
    expect(JSON.stringify(shown)).not.toContain('to confirm');
    for (let i = 0; i < 50 && completed.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(completed).toEqual(shown.map((p) => p.elicitationId));
    const audit = ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.decidedVia, 'url'))
      .all()
      .filter((a) => a.decision === 'human-approved' && a.actorId === 'token:e2e');
    expect(audit.map((a) => [a.actorId, a.decidedBy])).toEqual([
      ['token:e2e', 'admin'],
      ['token:e2e', 'admin'],
    ]);
    await client.close();
  });

  it('cancels an open approval when its endpoint is stopped', async () => {
    const { token } = ctx.tokens.create({ name: 'stop', scope: [otherInstanceId], access: 'write' }, { userId: adminId });
    await ctx.instances.syncNow(otherInstanceId);
    setGroupLevel(ctx.db, otherInstanceId, 'echo', 'ask');
    let prompted!: (id: string) => void;
    const shown = new Promise<string>((r) => (prompted = r));
    const client = await connect('echo-two', token, {
      mode: 'url',
      onElicit: (p) => {
        prompted(p.elicitationId!);
        return {};
      },
    });
    const call = client.callTool({
      name: 'execute',
      arguments: { code: `return (await echo.call('echo.set', { name: 'vol/b' })).key;` },
    });
    const approvalId = await shown;
    await ctx.instances.update(otherInstanceId, { enabled: false });
    expect(parse(await call)).toMatchObject({
      error: 'PERMISSION_DENIED',
      message: expect.stringMatching(/endpoint was stopped/),
    });
    // Nobody can approve it on the page any more.
    expect(() => ctx.approvals.decide(approvalId, { approve: true, decidedBy: 'admin' })).toThrow(/already cancelled/);
    await client.close();
    await ctx.instances.update(otherInstanceId, { enabled: true });
    setGroupLevel(ctx.db, otherInstanceId, 'echo', 'read');
  });

  it('returns a structured tool error when the user declines the prompt', async () => {
    const { token } = ctx.tokens.create({ name: 'e2e', scope: [instanceId], access: 'write' }, { userId: adminId });
    const client = await connect('echo', token, { mode: 'url', onElicit: () => 'decline' });
    const res = await client.callTool({
      name: 'execute',
      arguments: { code: `await echo.call('echo.set', { name: 'x' });` },
    });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ error: 'PERMISSION_DENIED' });
    await client.close();
  });

  it('keeps read-only tokens away from writes', async () => {
    const { token } = ctx.tokens.create({ name: 'reader', scope: [instanceId] }, { userId: adminId }); // access defaults to read
    const client = await connect('echo', token, { mode: 'url', onElicit: () => ({}) });
    const found = parse(
      await client.callTool({
        name: 'search',
        arguments: { code: `return (await catalog.find()).map((o) => o.key);` },
      }),
    );
    expect(found).toEqual({ result: ['echo.query'] });
    const res = await client.callTool({
      name: 'execute',
      arguments: { code: `await echo.call('echo.set', { name: 'x' });` },
    });
    expect(parse(res)).toMatchObject({ error: 'OPERATION_DISABLED', message: expect.stringContaining('read-only') });
    await client.close();
  });

  it('rejects missing, wrong, out-of-scope and revoked tokens', async () => {
    const init = (auth?: string) =>
      fetch(`${base}/echo`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(auth ? { authorization: auth } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
        }),
      });
    const none = await init();
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/echo"`,
    );
    expect((await init('Bearer syn_nope')).status).toBe(401);
    const other = ctx.tokens.create({ name: 'other', scope: [otherInstanceId] }, { userId: adminId });
    expect((await init(`Bearer ${other.token}`)).status).toBe(403);
    ctx.tokens.revoke(other.id);
    expect((await init(`Bearer ${other.token}`)).status).toBe(401);
  });

  it('keys rate limits on the token, not its name: two tokens called "Claude" have separate budgets', async () => {
    await ctx.instances.update(instanceId, { settings: { executePerMinute: 1 } });
    try {
      const run = async (token: string) => {
        const client = await connect('echo', token);
        const res = parse(await client.callTool({ name: 'search', arguments: { code: 'return 1' } }));
        await client.close();
        return res;
      };
      const a = ctx.tokens.create({ name: 'Claude', scope: [instanceId] }, { userId: adminId }).token;
      const b = ctx.tokens.create({ name: 'Claude', scope: [instanceId] }, { userId: adminId }).token;
      expect(await run(a)).toEqual({ result: 1 });
      expect(await run(a)).toMatchObject({ error: 'RATE_LIMITED' });
      expect(await run(b)).toEqual({ result: 1 });
    } finally {
      await ctx.instances.update(instanceId, { settings: { executePerMinute: 30 } });
    }
  });

  it('caps open sessions per principal, closing the least recently used', async () => {
    const { token } = ctx.tokens.create({ name: 'many', scope: [instanceId] }, { userId: adminId });
    const clients = [];
    for (let i = 0; i <= MAX_SESSIONS_PER_PRINCIPAL; i++) clients.push(await connect('echo', token));
    // The first session was evicted by the one past the cap; the newest still works.
    await expect(clients[0]!.listTools()).rejects.toThrow();
    await expect(clients.at(-1)!.listTools()).resolves.toMatchObject({ tools: expect.any(Array) });
    for (const c of clients) await c.close().catch(() => undefined);
  });

  it('refuses rebound hosts and foreign origins (DNS rebinding)', async () => {
    const app = createMcpApp(ctx);
    const { token } = ctx.tokens.create({ name: 'rebind', scope: [instanceId] }, { userId: adminId });
    const init = (headers: Record<string, string>) =>
      app.request('/echo', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
        }),
      });
    expect((await init({ host: 'attacker.example' })).status).toBe(403);
    expect((await init({ host: '127.0.0.1:8080', origin: 'http://attacker.example' })).status).toBe(403);
    expect((await init({ host: '127.0.0.1:8080' })).status).toBe(200);
    expect((await init({ host: 'localhost', origin: 'http://localhost:3000' })).status).toBe(200);
    expect(hostAllowed({ ...ctx.config, MCP_ALLOWED_HOSTS: ['mcp.lan'] }, 'mcp.lan:8080')).toBe(true);
    expect(hostAllowed({ ...ctx.config, PUBLIC_MCP_URL: 'https://mcp.example.com' }, 'mcp.example.com')).toBe(true);
    expect(hostAllowed(ctx.config, '[::1]:8080')).toBe(true);
  });

  it('tells strangers nothing about which slugs exist or are disabled (review L16)', async () => {
    const post = (slug: string, token?: string) =>
      fetch(`${base}/${slug}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: '{}',
      });
    const { token } = ctx.tokens.create({ name: 'l16', scope: ['*'] }, { userId: adminId });
    await ctx.instances.update(otherInstanceId, { enabled: false });
    try {
      for (const slug of ['echo-two', 'no-such-endpoint', 'echo']) {
        const res = await post(slug);
        expect({ slug, status: res.status }).toEqual({ slug, status: 401 });
        expect((await res.json()) as object).toMatchObject({ error: 'unauthorized' });
      }
      expect((await post('echo-two', 'syn_wrong')).status).toBe(401);
      expect((await post('no-such-endpoint', 'syn_wrong')).status).toBe(401);
      // Holders of a live credential learn what is wrong.
      expect((await post('echo-two', token)).status).toBe(503);
      expect((await post('no-such-endpoint', token)).status).toBe(404);
    } finally {
      await ctx.instances.update(otherInstanceId, { enabled: true });
    }
  });

  it('binds sessions to the principal that created them', async () => {
    const a = ctx.tokens.create({ name: 'a', scope: ['*'] }, { userId: adminId });
    const b = ctx.tokens.create({ name: 'b', scope: ['*'] }, { userId: adminId });
    const client = await connect('echo', a.token);
    const sessionId = (client as unknown as { _transport: { sessionId: string } })._transport.sessionId;
    const hijack = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${b.token}`,
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(hijack.status).toBe(404);
    await client.close();
  });

  it('refuses anonymous external callers: every call belongs to a user', async () => {
    updateSettings(ctx.db, 'mcp', { trustedIdentityHeader: '' });
    await ctx.instances.update(otherInstanceId, { authMode: 'external' });
    try {
      const res = await fetch(`${base}/echo-two`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a', version: '1' } },
        }),
      });
      expect(res.status).toBe(401);
    } finally {
      await ctx.instances.update(otherInstanceId, { authMode: null });
    }
  });

  it('serves external mode with a trusted identity header, registering unknown names with the default role', async () => {
    updateSettings(ctx.db, 'mcp', { trustedIdentityHeader: 'remote-user' });
    await ctx.instances.update(otherInstanceId, { authMode: 'external' });
    await ctx.instances.syncNow(otherInstanceId);
    const initAs = (name: string) =>
      fetch(`${base}/echo-two`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'remote-user': name,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a', version: '1' } },
        }),
      });
    // Self-registration is off until an admin sets a default role.
    expect((await initAs('alice')).status).toBe(403);
    expect(ctx.users.byUsername('alice')).toBeUndefined();
    const viewers = ctx.roles.create({ name: 'Viewers' });
    ctx.roles.setInstances(viewers.id, [otherInstanceId]);
    setRoleLevel(ctx.db, viewers.id, otherInstanceId, { group: 'echo' }, 'read');
    updateSettings(ctx.db, 'security', { defaultRoleId: viewers.id });
    // The admin matches case-insensitively and keeps the Admin role.
    expect((await initAs('ADMIN')).status).toBe(200);
    const client = new Client({ name: 'e2e', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/echo-two`), {
        requestInit: { headers: { 'remote-user': 'alice' } },
      }),
    );
    await client.callTool({ name: 'execute', arguments: { code: `return await echo.call('echo.query');` } });
    const last = ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.instanceId, otherInstanceId))
      .all()
      .filter((a) => a.kind === 'call')
      .at(-1);
    expect(last?.actorId).toBe('external:alice');
    expect(ctx.users.byUsername('alice')?.roleId).toBe(viewers.id);
    // The role's maximum is Read: writes are out of reach and out of sight.
    const found = parse(
      await client.callTool({
        name: 'search',
        arguments: { code: `return (await catalog.find({ includeDisabled: true })).map((o) => o.key);` },
      }),
    );
    expect(found).toEqual({ result: expect.arrayContaining(['echo.query']) });
    expect((found as { result: string[] }).result).not.toContain('echo.set');
    await client.close();
    updateSettings(ctx.db, 'security', { defaultRoleId: null });
    await ctx.instances.update(otherInstanceId, { authMode: null });
  });
});

describe('OAuth 2.1 authorization server', () => {
  /** A tiny cookie-keeping browser for the MCP-port HTML flow. */
  function browserSession() {
    const jar = new Map<string, string>();
    return async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
      const res = await fetch(url.startsWith('http') ? url : `${base}${url}`, { ...init, headers, redirect: 'manual' });
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
  const form = (fields: Record<string, string | string[]>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) p.append(k, x);
    return { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: p.toString() };
  };
  const pkce = () => {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  };

  async function authorize(resources: string[], access?: 'read' | 'write', username = 'admin') {
    const reg = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }),
    });
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
    });
    for (const r of resources) q.append('resource', r);
    const browse = browserSession();

    const login = await (await browse(`/oauth/authorize?${q}`)).text();
    expect(login).toContain('Sign in to let Claude use your MCP endpoints');
    const afterLogin = await browse(
      '/oauth/login',
      form({
        username,
        password: PASSWORD,
        csrf: hidden(login, 'csrf'),
        continue: hidden(login, 'continue').replace(/&amp;/g, '&'),
      }),
    );
    expect(afterLogin.status).toBe(303);
    const consent = await (await browse(afterLogin.headers.get('location')!)).text();
    expect(consent).toContain('Authorize Claude');
    expect(consent).toContain(resources.length ? new URL(resources[0]!).pathname : '/echo');
    expect(consent).toMatch(/name="access" value="read" checked/);
    const approved = await browse(
      '/oauth/consent',
      form({ form: hidden(consent, 'form'), decision: 'approve', resource: resources, ...(access ? { access } : {}) }),
    );
    const redirect = new URL(approved.headers.get('location')!);
    expect(redirect.origin + redirect.pathname).toBe('https://claude.ai/api/mcp/auth_callback');
    expect(redirect.searchParams.get('state')).toBe('xyz');
    expect(redirect.searchParams.get('iss')).toBe(base);
    return { clientId: client.client_id, code: redirect.searchParams.get('code')!, verifier };
  }

  const token = (fields: Record<string, string>) =>
    fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  it('publishes RFC 8414 and RFC 9728 metadata', async () => {
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<
      string,
      unknown
    >;
    expect(as).toMatchObject({
      issuer: base,
      code_challenge_methods_supported: ['S256'],
      registration_endpoint: `${base}/oauth/register`,
    });
    const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource/echo`)).json();
    expect(pr).toMatchObject({ resource: `${base}/echo`, authorization_servers: [base] });
    expect(pr).not.toHaveProperty('resource_name');
  });

  it('stays off until PUBLIC_MCP_URL is set: no discovery from the Host header', async () => {
    const config = ctx.config as { PUBLIC_MCP_URL?: string };
    const saved = config.PUBLIC_MCP_URL;
    config.PUBLIC_MCP_URL = undefined;
    try {
      const as = await fetch(`${base}/.well-known/oauth-authorization-server`, {
        headers: { host: 'evil.example.com' },
      });
      expect(as.status).toBe(503);
      expect(((await as.json()) as { error: string }).error).toBe('temporarily_unavailable');
      expect((await fetch(`${base}/.well-known/oauth-protected-resource/echo`)).status).toBe(503);
      expect((await fetch(`${base}/oauth/register`, { method: 'POST', body: '{}' })).status).toBe(503);
      const res = await fetch(`${base}/echo`, { method: 'POST', body: '{}' });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).not.toContain('resource_metadata');
    } finally {
      config.PUBLIC_MCP_URL = saved;
    }
  });

  it('runs DCR → sign-in → consent → PKCE code exchange → MCP access, bound to the granted endpoint', async () => {
    // A wrong PKCE verifier fails, and burns the code (single use).
    const { clientId, code, verifier } = await authorize([`${base}/echo`]);
    expect(
      (
        await token({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
          code_verifier: 'x'.repeat(43),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await token({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
          code_verifier: verifier,
        })
      ).status,
    ).toBe(400);
    const second = await authorize([`${base}/echo`]);
    const res = await token({
      grant_type: 'authorization_code',
      client_id: second.clientId,
      code: second.code,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_verifier: second.verifier,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const tokens = (await res.json()) as { access_token: string; refresh_token: string };
    expect(tokens.access_token).toMatch(/^syno_/);

    const client = await connect('echo', tokens.access_token);
    expect(
      parse(
        await client.callTool({ name: 'execute', arguments: { code: `return (await echo.call('echo.query')).key;` } }),
      ),
    ).toEqual({ result: 'echo.query' });
    await client.close();
    const wrongEndpoint = await fetch(`${base}/echo-two`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
      }),
    });
    expect(wrongEndpoint.status).toBe(403);

    // Replaying a code revokes everything issued from it.
    expect(
      (
        await token({
          grant_type: 'authorization_code',
          client_id: second.clientId,
          code: second.code,
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
          code_verifier: second.verifier,
        })
      ).status,
    ).toBe(400);
    const revoked = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(revoked.status).toBe(401);
    void verifier;
  });

  it('limits a grant to the access chosen on the consent page, through refreshes', async () => {
    const exchange = async (access?: 'read' | 'write') => {
      const { clientId, code, verifier } = await authorize([`${base}/echo`], access);
      const res = await token({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_verifier: verifier,
      });
      return { clientId, ...((await res.json()) as { access_token: string; refresh_token: string }) };
    };
    const writesVisible = async (accessToken: string) => {
      const client = await connect('echo', accessToken);
      const found = parse(
        await client.callTool({ name: 'search', arguments: { code: `return (await catalog.find()).length;` } }),
      );
      await client.close();
      return (found.result as number) > 1;
    };

    const readOnly = await exchange(); // nothing picked: read only
    expect(await writesVisible(readOnly.access_token)).toBe(false);
    const refreshed = (await (
      await token({ grant_type: 'refresh_token', client_id: readOnly.clientId, refresh_token: readOnly.refresh_token })
    ).json()) as { access_token: string };
    expect(await writesVisible(refreshed.access_token)).toBe(false);

    const readWrite = await exchange('write');
    expect(await writesVisible(readWrite.access_token)).toBe(true);
  });

  it('binds grants to the endpoint, not its slug: rename keeps access, a re-used slug gets none', async () => {
    const moved = await ctx.instances.create({ pluginId: 'echo', slug: 'movable', connection: {} });
    await ctx.instances.syncNow(moved.id);
    const { clientId, code, verifier } = await authorize([`${base}/movable`]);
    const { access_token } = (await (
      await token({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_verifier: verifier,
      })
    ).json()) as { access_token: string };
    const init = (slug: string) =>
      fetch(`${base}/${slug}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${access_token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
        }),
      });
    expect((await init('movable')).status).toBe(200);

    // The endpoint the user consented to keeps working under its new slug…
    await ctx.instances.update(moved.id, { slug: 'moved' });
    expect((await init('moved')).status).toBe(200);
    // …and a new endpoint that takes over the old slug is not covered by the grant.
    const squatter = await ctx.instances.create({ pluginId: 'echo', slug: 'movable', connection: {} });
    await ctx.instances.syncNow(squatter.id);
    expect((await init('movable')).status).toBe(403);

    // Deleting the endpoint revokes a grant that covered nothing else.
    await ctx.instances.remove(moved.id, 'moved');
    ctx.oauth.forgetInstance(moved.id);
    // The revoked token is no credential at all, so the gone slug answers like any other (review L16).
    expect((await init('moved')).status).toBe(401);
    expect((await init('movable')).status).toBe(401);
    await ctx.instances.remove(squatter.id, 'movable');
  });

  it('revokes grants on a password change, and grants and bearer tokens when the user is disabled (review L9)', async () => {
    const bob = await ctx.users.create({ username: 'bob', password: PASSWORD });
    const admin = browser(createAdminApp(ctx));
    await admin.init();
    expect((await admin.post('/auth/login', { username: 'admin', password: PASSWORD })).status).toBe(200);

    const tokensFor = async () => {
      const { clientId, code, verifier } = await authorize([`${base}/echo`], undefined, 'bob');
      const pair = (await (
        await token({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
          code_verifier: verifier,
        })
      ).json()) as { access_token: string; refresh_token: string };
      return { clientId, ...pair };
    };
    const reaches = (accessToken: string) =>
      fetch(`${base}/echo`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
        }),
      }).then((r) => r.status);

    // A password change ends the grant: the refresh token no longer works.
    const before = await tokensFor();
    expect(await reaches(before.access_token)).toBe(200);
    expect((await admin.patch(`/api/users/${bob.id}`, { password: `${PASSWORD}!` })).status).toBe(200);
    expect(await reaches(before.access_token)).toBe(401);
    expect(
      (await token({ grant_type: 'refresh_token', client_id: before.clientId, refresh_token: before.refresh_token }))
        .status,
    ).toBe(400);
    expect((await admin.patch(`/api/users/${bob.id}`, { password: PASSWORD })).status).toBe(200);

    // Disabling ends grants and the bearer tokens bob created; re-enabling revives neither.
    const live = await tokensFor();
    const { token: bearer } = ctx.tokens.create({ name: 'bob', scope: [instanceId] }, { userId: bob.id });
    expect(await reaches(bearer)).toBe(200);
    expect((await admin.patch(`/api/users/${bob.id}`, { disabled: true })).status).toBe(200);
    expect((await admin.patch(`/api/users/${bob.id}`, { disabled: false })).status).toBe(200);
    expect(await reaches(live.access_token)).toBe(401);
    expect(await reaches(bearer)).toBe(401);
    expect(
      (await token({ grant_type: 'refresh_token', client_id: live.clientId, refresh_token: live.refresh_token }))
        .status,
    ).toBe(400);
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const { clientId, code, verifier } = await authorize([`${base}/echo`]);
    const first = (await (
      await token({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_verifier: verifier,
      })
    ).json()) as { refresh_token: string };
    const rotated = await token({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: first.refresh_token,
    });
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(first.refresh_token);

    const reuse = await token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token });
    expect(await reuse.json()).toMatchObject({ error: 'invalid_grant' });
    expect(
      (await token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: next.refresh_token })).status,
    ).toBe(400);
    expect(
      (await fetch(`${base}/echo`, { method: 'POST', headers: { authorization: `Bearer ${next.access_token}` } }))
        .status,
    ).toBe(401);
  });

  it('never redirects to unregistered URIs and requires PKCE', async () => {
    const reg = (await (
      await fetch(`${base}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'x', redirect_uris: ['https://app.example/cb'] }),
      })
    ).json()) as { client_id: string };
    const evil = await fetch(
      `${base}/oauth/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=https://evil.example/cb`,
      { redirect: 'manual' },
    );
    expect(evil.status).toBe(400);
    expect(await evil.text()).toContain('Invalid redirect');
    const noPkce = await fetch(
      `${base}/oauth/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=https://app.example/cb&state=s`,
      { redirect: 'manual' },
    );
    expect(noPkce.headers.get('location')).toContain('error=invalid_request');
    expect(noPkce.headers.get('location')).toContain('state=s');
    const js = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['javascript:alert(1)'] }),
    });
    expect(await js.json()).toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('can be closed to dynamic registration', async () => {
    updateSettings(ctx.db, 'mcp', { allowDynamicRegistration: false });
    const res = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()).not.toHaveProperty(
      'registration_endpoint',
    );
    updateSettings(ctx.db, 'mcp', { allowDynamicRegistration: true });
  });
});

describe('server log for refused connections', () => {
  // Refusals are throttled per client IP: each request here comes from its own (trusted-proxy) address.
  let nextIp = 0;
  const capture = () => {
    const lines: { level: LogLevel; line: string }[] = [];
    const saved = ctx.log;
    const config = ctx.config as { TRUST_PROXY: number | boolean };
    const savedProxy = config.TRUST_PROXY;
    config.TRUST_PROXY = 1;
    (ctx as { log: Logger }).log = createLogger('debug', (line, level) => lines.push({ level, line }));
    return {
      lines,
      restore: () => {
        (ctx as { log: Logger }).log = saved;
        config.TRUST_PROXY = savedProxy;
      },
    };
  };
  const post = (slug: string, headers: Record<string, string>, body: unknown) =>
    fetch(`${base}/${slug}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-forwarded-for': `192.0.2.${++nextIp}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const initialize = (slug: string, headers: Record<string, string> = {}) =>
    post(slug, headers, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'log', version: '1' } },
    });
  // Shaped like a token another issuer (a proxy's OAuth server) gave the client. Unsigned: only its
  // claims are read, for the log.
  const jwt = (claims: unknown) =>
    `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
  const foreignJwt = jwt({ iss: 'https://home.cloudflareaccess.com', aud: 'x' });

  it('explains a token the endpoint cannot use, without logging its value', async () => {
    const { lines, restore } = capture();
    try {
      const res = await initialize('echo', {
        authorization: `Bearer ${foreignJwt}`,
        'cf-access-jwt-assertion': foreignJwt,
      });
      expect(res.status).toBe(401);
      const warn = lines.find((l) => l.level === 'warn')!;
      expect(warn.line).toMatch(/^WARN MCP request refused method=POST slug=echo status=401 reason="got a JWT/);
      expect(warn.line).toContain('a JWT from another issuer (iss=https://home.cloudflareaccess.com)');
      expect(warn.line).toContain('set the endpoint to External auth');
      expect(warn.line).toContain('mode=bearer+oauth');
      expect(lines.map((l) => l.line).join('\n')).not.toContain(foreignJwt);
    } finally {
      restore();
    }
  });

  it('keeps hostile claims inside one quoted, clipped field, and answers 401 for non-string ones', async () => {
    const { lines, restore } = capture();
    try {
      const forged = jwt({ iss: `x\nINFO MCP session opened slug=echo client=token:admin ${'y'.repeat(10_000)}` });
      expect((await initialize('echo', { authorization: `Bearer ${forged}` })).status).toBe(401);
      expect((await initialize('echo', { authorization: `Bearer ${jwt({ iss: { toString: 1 } })}` })).status).toBe(401);
      const refused = lines.filter((l) => l.line.includes('MCP request refused'));
      expect(refused).toHaveLength(2);
      for (const { line } of refused) {
        expect(line).not.toContain('\n');
        expect(line.length).toBeLessThan(1000);
      }
      expect(lines.some((l) => l.line.startsWith('INFO MCP session opened'))).toBe(false);
    } finally {
      restore();
    }
  });

  it('names the mismatched Cloudflare Access claim in External mode', async () => {
    updateSettings(ctx.db, 'mcp', { cfAccess: { teamDomain: 'home.cloudflareaccess.com', aud: 'right-aud' } });
    await ctx.instances.update(otherInstanceId, { authMode: 'external' });
    const { lines, restore } = capture();
    try {
      expect((await initialize('echo-two', { 'cf-access-jwt-assertion': foreignJwt })).status).toBe(401);
      expect((await initialize('echo-two')).status).toBe(401);
      const [bad, missing] = lines.filter((l) => l.line.includes('MCP request refused'));
      expect(bad).toMatchObject({ level: 'warn' });
      expect(bad!.line).toContain('Cloudflare Access assertion rejected');
      expect(bad!.line).toContain('aud=x; expected iss=https://home.cloudflareaccess.com aud=right-aud');
      // No credentials at all: a probe, kept out of the default log.
      expect(missing).toMatchObject({ level: 'debug' });
      expect(missing!.line).toContain('no Cf-Access-Jwt-Assertion header');
    } finally {
      restore();
      updateSettings(ctx.db, 'mcp', { cfAccess: { teamDomain: '', aud: '' } });
      await ctx.instances.update(otherInstanceId, { authMode: null });
    }
  });

  it('keeps junk credentials and floods out of the default log', async () => {
    const { lines, restore } = capture();
    try {
      await initialize('echo', { authorization: 'Bearer junk' });
      const refusedJunk = lines.filter((l) => l.line.includes('MCP request refused'));
      expect(refusedJunk.map((l) => l.level)).toEqual(['debug']);
      // The same client and status again within the window: dropped, then counted.
      const throttle = new LogThrottle();
      expect(throttle.admit('k', 0)).toBe(0);
      expect(throttle.admit('k', 1000)).toBeNull();
      expect(throttle.admit('k', 2000)).toBeNull();
      expect(throttle.admit('k', 61_000)).toBe(2);
      expect(throttle.admit('other', 61_000)).toBe(0);
    } finally {
      restore();
    }
  });

  it('logs a refused Origin, an opened session and transport errors', async () => {
    const { token } = ctx.tokens.create({ name: 'log', scope: [instanceId] }, { userId: adminId });
    const { lines, restore } = capture();
    try {
      // fetch won't set Host; a foreign Origin goes through the same check.
      const origin = await initialize('echo', { origin: 'https://evil.example', authorization: `Bearer ${token}` });
      expect(origin.status).toBe(403);
      expect((await initialize('echo', { authorization: `Bearer ${token}` })).status).toBe(200);
      const notInit = await post(
        'echo',
        { accept: 'application/json', authorization: `Bearer ${token}` },
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      );
      expect(notInit.status).toBeGreaterThanOrEqual(400);
      const text = lines.map((l) => `${l.level} ${l.line}`).join('\n');
      expect(text).toMatch(/warn WARN MCP request refused .*reason="Host or Origin not allowed.* origin=/);
      expect(text).toMatch(/info INFO MCP session opened slug=echo client=token:log/);
      expect(text).toMatch(/warn WARN MCP request rejected by the transport method=POST slug=echo status=4\d\d error=/);
      expect(text).toContain('debug DEBUG MCP listener request method=POST path=/echo');
      expect(text).not.toContain(token);
    } finally {
      restore();
    }
  });
});
