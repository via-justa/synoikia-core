import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { asc, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { auditCsvChunks, queryAudit } from '../../audit-query.js';
import { pluginInstances, plugins } from '../../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import { CORE_EVENT_NAMES } from '../../events.js';
import { getSettings, isSettingsSection, updateSettings } from '../../settings.js';
import { CORE_VERSION } from '../../version.js';
import { readJson } from '../common.js';
import { assertSsoRemains } from './auth.js';
import type { AdminEnv } from './auth.js';

/** Global Admin API routes (design §8.4): overview, plugins, audit, tokens, users, settings, events. */
export function registerSystemRoutes(app: Hono<AdminEnv>, ctx: AppContext) {
  const actor = (c: { get: (k: 'user') => { id: string } }) => ({ userId: c.get('user').id });

  const mcpBase = () => ctx.config.PUBLIC_MCP_URL?.replace(/\/$/, '') ?? '';

  app.get('/api/overview', (c) => {
    const mcpSettings = getSettings(ctx.db, 'mcp');
    const instances = ctx.instances.list().map((i) => ({
      ...i,
      endpointUrl: `${mcpBase()}/${i.slug}`,
      effectiveAuthMode: i.authMode ?? mcpSettings.defaultAuthMode,
    }));
    return c.json({
      instances,
      plugins: ctx.db
        .select()
        .from(plugins)
        .orderBy(asc(plugins.pluginId))
        .all()
        .map((p) => ({
          id: p.id,
          pluginId: p.pluginId,
          status: p.status,
          enabled: p.enabled,
        })),
      warnings: ctx.warnings,
      publicMcpUrl: ctx.config.PUBLIC_MCP_URL ?? null,
      version: CORE_VERSION,
    });
  });

  // ── plugins ──

  app.get('/api/plugins', (c) => {
    const counts = new Map(
      ctx.db
        .select({ pluginId: pluginInstances.pluginId, n: count() })
        .from(pluginInstances)
        .groupBy(pluginInstances.pluginId)
        .all()
        .map((r) => [r.pluginId, r.n]),
    );
    return c.json(
      ctx.db
        .select()
        .from(plugins)
        .orderBy(asc(plugins.pluginId))
        .all()
        .map((p) => ({ ...p, instances: counts.get(p.id) ?? 0 })),
    );
  });

  app.patch('/api/plugins/:id', async (c) => {
    const { enabled } = await readJson(c, z.object({ enabled: z.boolean() }));
    await ctx.instances.setPluginEnabled(c.req.param('id'), enabled, actor(c));
    return c.json(
      ctx.db
        .select()
        .from(plugins)
        .where(eq(plugins.id, c.req.param('id')))
        .get() ?? null,
    );
  });

  app.post('/api/plugins/rescan', (c) => c.json(ctx.discoverPlugins()));
  app.post('/api/plugins/install', async (c) =>
    c.json(await ctx.repos.install(await readJson(c, z.unknown()), actor(c)), 201),
  );
  app.delete('/api/plugins/:id', (c) => {
    ctx.repos.uninstall(c.req.param('id'), actor(c));
    return c.body(null, 204);
  });

  // ── plugin repositories (design §4.2–4.3) ──

  app.get('/api/plugin-repos', (c) => c.json(ctx.repos.list()));
  app.get('/api/plugin-repos/available', (c) => c.json(ctx.repos.available()));
  app.post('/api/plugin-repos', async (c) =>
    c.json(await ctx.repos.add(await readJson(c, z.unknown()), actor(c)), 201),
  );
  app.post('/api/plugin-repos/:id/refresh', async (c) => c.json(await ctx.repos.refresh(c.req.param('id'))));
  app.post('/api/plugin-repos/:id/confirm-key', async (c) => {
    const { publicKey } = await readJson(c, z.object({ publicKey: z.string() }));
    return c.json(ctx.repos.confirmKey(c.req.param('id'), publicKey, actor(c)));
  });
  app.delete('/api/plugin-repos/:id', (c) => {
    ctx.repos.remove(c.req.param('id'), actor(c));
    return c.body(null, 204);
  });

  // ── notification channels (design §9) ──

  app.get('/api/notifiers', (c) => c.json(ctx.notifier.list()));
  app.post('/api/notifiers', async (c) =>
    c.json(ctx.notifier.save(await readJson(c, z.unknown()), { actor: actor(c) }), 201),
  );
  app.patch('/api/notifiers/:id', async (c) =>
    c.json(ctx.notifier.save(await readJson(c, z.unknown()), { id: c.req.param('id'), actor: actor(c) })),
  );
  app.delete('/api/notifiers/:id', (c) => {
    ctx.notifier.remove(c.req.param('id'), actor(c));
    return c.body(null, 204);
  });
  app.post('/api/notifiers/:id/test', async (c) => c.json(await ctx.notifier.test(c.req.param('id'))));

  // ── audit ──

  app.get('/api/audit', (c) => c.json(queryAudit(ctx.db, c.req.query())));
  app.get('/api/audit/export.csv', (c) => {
    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    const chunks = auditCsvChunks(ctx.db, c.req.query());
    const encoder = new TextEncoder();
    return c.body(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        },
        cancel() {
          chunks.return(undefined);
        },
      }),
    );
  });

  // ── MCP bearer tokens (design §6.2) ──

  app.get('/api/tokens', (c) => c.json(ctx.tokens.list()));
  app.post('/api/tokens', async (c) => c.json(ctx.tokens.create(await readJson(c, z.unknown()), actor(c)), 201));
  app.delete('/api/tokens/:id', (c) => {
    ctx.tokens.revoke(c.req.param('id'), actor(c));
    return c.body(null, 204);
  });

  // ── OAuth clients & grants (design §6.2) ──

  app.get('/api/oauth/clients', (c) => c.json(ctx.oauth.listClients()));
  app.post('/api/oauth/clients', async (c) => {
    const body = await readJson(
      c,
      z.object({
        name: z.string().trim().min(1).max(100),
        redirectUris: z.array(z.string()).min(1).max(10),
        confidential: z.boolean().default(false),
      }),
    );
    return c.json(
      ctx.oauth.register(
        {
          client_name: body.name,
          redirect_uris: body.redirectUris,
          token_endpoint_auth_method: body.confidential ? 'client_secret_post' : 'none',
        },
        'admin',
        actor(c),
      ),
      201,
    );
  });
  app.delete('/api/oauth/clients/:id', (c) => {
    ctx.oauth.revokeClient(c.req.param('id'), actor(c));
    return c.body(null, 204);
  });
  app.get('/api/oauth/grants', (c) => c.json(ctx.oauth.listGrants()));
  app.delete('/api/oauth/grants/:id', (c) => {
    ctx.oauth.revokeGrant(c.req.param('id'), actor(c));
    return c.body(null, 204);
  });

  // ── users (design §6.1, §6.4) ──

  app.get('/api/users', (c) => c.json(ctx.users.list()));
  app.post('/api/users', async (c) => {
    const body = await readJson(
      c,
      z.object({ username: z.string(), password: z.string().optional(), roleId: z.string().min(1) }),
    );
    return c.json(await ctx.users.create(body, actor(c)), 201);
  });
  app.patch('/api/users/:id', async (c) => {
    const body = await readJson(
      c,
      z.object({ disabled: z.boolean().optional(), password: z.string().optional(), roleId: z.string().optional() }),
    );
    const id = c.req.param('id');
    if (body.roleId !== undefined) ctx.users.setRole(id, body.roleId, actor(c));
    if (body.disabled !== undefined) {
      if (id === c.get('user').id && body.disabled)
        throw new ConflictError('self_disable', 'You cannot disable yourself');
      if (body.disabled) assertSsoRemains(ctx, { losingUser: id });
      ctx.users.setDisabled(id, body.disabled, actor(c));
      if (body.disabled) {
        // Everything the user could still reach MCP with goes too; re-enabling revives none of it.
        ctx.sessions.revokeUser(id);
        ctx.oauth.revokeUserGrants(id, 'user_disabled', actor(c));
        ctx.tokens.revokeCreatedBy(id, actor(c));
      }
    }
    if (body.password !== undefined) {
      await ctx.users.setPassword(id, body.password, { actorId: c.get('user').id });
      ctx.sessions.revokeUser(id);
      ctx.oauth.revokeUserGrants(id, 'password_changed', actor(c));
    }
    return c.json(ctx.users.toPublic(ctx.users.get(id)));
  });
  app.post('/api/users/:id/reset-totp', (c) => {
    ctx.users.resetTotp(c.req.param('id'), actor(c));
    // An approval browser's TOTP proof must not outlive the authenticator it was made with.
    ctx.sessions.revokeKind(c.req.param('id'), 'approval_ui');
    return c.json(ctx.users.toPublic(ctx.users.get(c.req.param('id'))));
  });

  // ── settings ──

  app.get('/api/settings', (c) =>
    c.json({
      security: getSettings(ctx.db, 'security'),
      mcp: getSettings(ctx.db, 'mcp'),
      audit: getSettings(ctx.db, 'audit'),
      oidc: ctx.oidc.getSettings(),
      forceLocalLogin: ctx.config.ADMIN_FORCE_LOCAL_LOGIN,
      publicMcpUrl: ctx.config.PUBLIC_MCP_URL ?? null,
      publicAdminUrl: ctx.config.PUBLIC_ADMIN_URL ?? null,
    }),
  );

  app.put('/api/settings/oidc', async (c) => {
    const body = await readJson(c, z.record(z.string(), z.unknown()));
    if (body.enabled === false) assertSsoRemains(ctx, { oidcOff: true });
    return c.json(ctx.oidc.updateSettings(body, actor(c)));
  });

  app.put('/api/settings/:section', async (c) => {
    const section = c.req.param('section');
    if (!isSettingsSection(section)) throw new NotFoundError('unknown_section', 'Unknown settings section');
    const body = await readJson(c, z.record(z.string(), z.unknown()));
    if (section === 'security' && typeof body.defaultRoleId === 'string') ctx.roles.get(body.defaultRoleId);
    // Disabling local login locks everyone out unless SSO works and someone can use it (design §6.1).
    if (section === 'security' && body.disableLocalLogin === true) {
      if (!ctx.oidc.isEnabled() || !ctx.users.hasOidcLinkedUser()) {
        throw new ValidationError(
          'oidc_required',
          'Enable OIDC and link at least one user before disabling local login',
        );
      }
    }
    return c.json(updateSettings(ctx.db, section, body, actor(c)));
  });

  // ── live events for the portal (approvals, instance status, sync) ──

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const handlers = CORE_EVENT_NAMES.map((name) => {
        const handler = (payload: unknown) => void stream.writeSSE({ event: name, data: JSON.stringify(payload) });
        ctx.events.on(name, handler as never);
        return [name, handler] as const;
      });
      const heartbeat = setInterval(() => void stream.writeSSE({ event: 'ping', data: '{}' }), 25_000);
      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
        // Shutdown ends the stream so closing the listener doesn't wait for the browser to leave.
        if (ctx.shutdownSignal.aborted) resolve();
        else ctx.shutdownSignal.addEventListener('abort', () => resolve(), { once: true });
      });
      clearInterval(heartbeat);
      for (const [name, handler] of handlers) ctx.events.off(name, handler as never);
    }),
  );
}
