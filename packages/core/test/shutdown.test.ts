import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, describe, expect, it } from 'vitest';
import { setGroupLevel } from '../src/catalog/groups.js';
import { pendingApprovals } from '../src/db/schema.js';
import { sessionLimits } from '../src/http/admin/auth.js';
import { startServers } from '../src/server.js';
import { createTestApp } from './helpers.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('graceful shutdown (review M16)', () => {
  it('finishes promptly with an admin SSE stream, an MCP session and a pending approval open', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'synoikia-shutdown-'));
    dirs.push(dataDir);
    const ctx = await createTestApp(
      {
        DATA_DIR: dataDir,
        MCP_HOST: '127.0.0.1',
        MCP_PORT: '0',
        ADMIN_HOST: '127.0.0.1',
        ADMIN_PORT: '0',
      },
      { memoryDb: true },
    );
    const user = await ctx.users.create({ username: 'admin', password: 'correct horse battery' });
    const servers = await startServers(ctx);
    const base = `http://127.0.0.1:${servers.mcp.port}`;
    const instanceId = (await ctx.instances.create({ pluginId: 'echo', slug: 'echo', connection: {} })).id;
    await ctx.instances.syncNow(instanceId);
    setGroupLevel(ctx.db, instanceId, 'echo', 'ask');

    // The portal's live event stream, which never ends on its own.
    const cookie = `syn_admin=${ctx.sessions.create(user.id, 'admin', sessionLimits(ctx))}`;
    const sse = await fetch(`http://127.0.0.1:${servers.admin.port}/api/events`, { headers: { cookie } });
    expect(sse.status).toBe(200);
    const sseDone = sse.text().then(
      () => 'ended',
      () => 'cut',
    );

    // An MCP client whose user opened the approval page but never decides.
    const { token } = ctx.tokens.create({ name: 't', scope: [instanceId], access: 'write' }, { userId: user.id });
    const client = new Client({ name: 't', version: '1' }, { capabilities: { elicitation: { url: {} } } });
    let prompted!: () => void;
    const shown = new Promise<void>((r) => (prompted = r));
    client.setRequestHandler(ElicitRequestSchema, async () => {
      prompted();
      return { action: 'accept' };
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/echo`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const call = client
      .callTool({ name: 'execute', arguments: { code: `return await echo.call('echo.set', { name: 'a' });` } })
      .then(
        (r) => JSON.stringify(r),
        (e: unknown) => String(e),
      );
    await shown;
    expect(
      ctx.db
        .select()
        .from(pendingApprovals)
        .all()
        .map((a) => a.status),
    ).toEqual(['pending']);

    const t0 = Date.now();
    await ctx.drain();
    await servers.close(2000);
    const statuses = ctx.db
      .select()
      .from(pendingApprovals)
      .all()
      .map((a) => a.status);
    await ctx.stop();
    expect(Date.now() - t0).toBeLessThan(2000);

    expect(statuses).toEqual(['cancelled']);
    expect(await sseDone).toBe('ended');
    // The waiting tool call is answered (denied by the shutdown) before its session closes.
    expect(await call).toContain('denied (shutdown)');
    await client.close().catch(() => undefined);
  }, 20_000);
});
