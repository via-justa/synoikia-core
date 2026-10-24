import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { auditCsvChunks, queryAudit } from '../../audit-query.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import { CORE_EVENT_NAMES } from '../../events.js';
import { effectiveAuthMethods } from '../../instances/manager.js';
import { LIMITS } from '../../plugins/repos.js';
import { getSettings, isSettingsSection, updateSettings } from '../../settings.js';
import { readJson } from '../common.js';
import type { AdminEnv } from './auth.js';

/** Global Admin API routes (ADR-0010): overview, plugins, audit, tokens, users, settings, events. */
export function registerSystemRoutes(app: Hono<AdminEnv>, ctx: AppContext) {
  const actor = (c: { get: (k: 'user') => { id: string } }) => ({ userId: c.get('user').id });

  const mcpBase = () => ctx.config.PUBLIC_MCP_URL?.replace(/\/$/, '') ?? '';

  app.get('/api/overview', (c) => {
    const instances = ctx.instances.list().map((i) => ({
      ...i,
      endpointUrl: `${mcpBase()}/${i.slug}`,
      effectiveAuthMethods: effectiveAuthMethods(ctx.db, i.authMethods),
    }));
    return c.json({
      instances,
      plugins: ctx.instances
        .listPlugins()
        .map((p) => ({ id: p.id, pluginId: p.pluginId, status: p.status, enabled: p.enabled })),
      warnings: ctx.warnings,
      publicMcpUrl: ctx.config.PUBLIC_MCP_URL ?? null,
      version: ctx.version,
    });
  });

  // ── plugins ──

  app.get('/api/plugins', (c) => c.json(ctx.instances.listPlugins()));

  app.patch('/api/plugins/:id', async (c) => {
    const { enabled } = await readJson(c, z.object({ enabled: z.boolean() }));
    await ctx.instances.setPluginEnabled(c.req.param('id'), enabled, actor(c));
    return c.json(ctx.instances.findPlugin(c.req.param('id')));
  });

  app.post('/api/plugins/rescan', (c) => c.json(ctx.discoverPlugins()));
  app.post('/api/plugins/install', async (c) =>
    c.json(await ctx.repos.install(await readJson(c, z.unknown()), actor(c)), 201),
  );
  // Manual plugins (ADR-0013): the raw tarball is the body, its name a header or query param.
  app.post(
    '/api/plugins/uploads',
    bodyLimit({
      maxSize: LIMITS.tarballBytes,
      onError: () => {
        throw new ValidationError('too_large', 'The file is too large');
      },
    }),
    async (c) => {
      const header = c.req.header('x-file-name');
      const fileName = header === undefined ? c.req.query('fileName') : decodeHeader(header);
      const bytes = Buffer.from(await c.req.arrayBuffer());
      return c.json(await ctx.repos.stageUpload(bytes, fileName), 201);
    },
  );
  app.post('/api/plugins/uploads/:uploadId/install', async (c) =>
    c.json(await ctx.repos.installUpload(c.req.param('uploadId'), actor(c))),
  );
  app.post('/api/plugins/:id/revert', async (c) => c.json(await ctx.repos.revert(c.req.param('id'), actor(c))));
  app.delete('/api/plugins/:id', (c) => {
    ctx.repos.uninstall(c.req.param('id'), actor(c));
    return c.body(null, 204);
  });

  // ── plugin repositories (ADR-0013) ──

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

  // ── notification channels (ADR-0019) ──

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

  // ── MCP bearer tokens (ADR-0009) ──

  app.get('/api/tokens', (c) => c.json(ctx.tokens.list()));
  app.post('/api/tokens', async (c) => c.json(ctx.tokens.create(await readJson(c, z.unknown()), actor(c)), 201));
  app.delete('/api/tokens/:id', (c) => {
    ctx.tokens.revoke(c.req.param('id'), actor(c));
    return c.body(null, 204);
  });

  // ── OAuth clients & grants (ADR-0009) ──

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

  // ── users (ADR-0008, ADR-0010) ──

  app.get('/api/users', (c) => c.json(ctx.users.list()));
  app.post('/api/users', async (c) => {
    const body = await readJson(
      c,
      z.object({
        username: z.string(),
        password: z.string().optional(),
        roleId: z.string().min(1),
        kind: z.enum(['local', 'sso']).optional(),
        oidcEmail: z.string().max(320).optional(),
      }),
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
      if (body.disabled) ctx.users.assertSsoRemains({ losingUser: id });
      ctx.users.setDisabled(id, body.disabled, actor(c));
      if (body.disabled) {
        // Everything the user could still reach MCP with goes too; re-enabling revives none of it.
        ctx.sessions.revokeUser(id);
        ctx.oauth.revokeUserGrants(id, 'user_disabled', actor(c));
        ctx.tokens.revokeCreatedBy(id, actor(c));
        ctx.grants.endForUser(id, 'user_disabled');
      }
    }
    if (body.password !== undefined) {
      await ctx.users.setPassword(id, body.password, { actorId: c.get('user').id });
      ctx.sessions.revokeUser(id);
      ctx.oauth.revokeUserGrants(id, 'password_changed', actor(c));
    }
    return c.json(ctx.users.toPublic(ctx.users.get(id)));
  });
  app.delete('/api/users/:id', (c) => {
    const id = c.req.param('id');
    if (id === c.get('user').id) throw new ConflictError('self_delete', 'You cannot delete yourself');
    ctx.users.assertDeletable(id);
    // Credentials are revoked while their rows still name the user; the delete then clears the rest.
    ctx.sessions.revokeUser(id);
    ctx.oauth.revokeUserGrants(id, 'user_deleted', actor(c));
    ctx.tokens.revokeCreatedBy(id, actor(c), 'user_deleted');
    ctx.approvals.cancelForOwner(id, 'user_deleted');
    ctx.grants.endForUser(id, 'user_deleted');
    ctx.users.delete(id, actor(c));
    return c.body(null, 204);
  });
  app.post('/api/users/:id/reset-totp', (c) => {
    ctx.users.resetTotp(c.req.param('id'), actor(c));
    // An approval browser's sign-in must not outlive the authenticator it was made with.
    ctx.sessions.revokeKind(c.req.param('id'), 'approval_ui');
    return c.json(ctx.users.toPublic(ctx.users.get(c.req.param('id'))));
  });

  // ── settings ──

  app.get('/api/settings', (c) =>
    c.json({
      security: getSettings(ctx.db, 'security'),
      mcp: getSettings(ctx.db, 'mcp'),
      audit: getSettings(ctx.db, 'audit'),
      runtime: { ...getSettings(ctx.db, 'runtime'), total: ctx.runTotal() },
      oidc: ctx.oidc.getSettings(),
      forceLocalLogin: ctx.config.ADMIN_FORCE_LOCAL_LOGIN,
      publicMcpUrl: ctx.config.PUBLIC_MCP_URL ?? null,
      publicAdminUrl: ctx.config.PUBLIC_ADMIN_URL ?? null,
    }),
  );

  // Suggestions for the client policy (@id:client-policy): names seen at initialize since the server started.
  app.get('/api/settings/mcp/clients-seen', (c) => c.json(ctx.seenClients.list()));

  app.put('/api/settings/oidc', async (c) => {
    const body = await readJson(c, z.record(z.string(), z.unknown()));
    if (body.enabled === false) ctx.users.assertSsoRemains({ oidcOff: true });
    return c.json(ctx.oidc.updateSettings(body, actor(c)));
  });

  app.put('/api/settings/:section', async (c) => {
    const section = c.req.param('section');
    if (!isSettingsSection(section)) throw new NotFoundError('unknown_section', 'Unknown settings section');
    const body = await readJson(c, z.record(z.string(), z.unknown()));
    if (section === 'security' && typeof body.defaultRoleId === 'string') ctx.roles.get(body.defaultRoleId);
    // Disabling local login locks everyone out unless SSO works and someone can use it (ADR-0008).
    if (section === 'security' && body.disableLocalLogin === true) {
      if (!ctx.oidc.isEnabled() || !ctx.users.hasSsoAccount()) {
        throw new ValidationError(
          'oidc_required',
          'Enable OIDC and add at least one SSO account before disabling local login',
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

function decodeHeader(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ValidationError('invalid_file_name', 'x-file-name is not URI-encoded');
  }
}
