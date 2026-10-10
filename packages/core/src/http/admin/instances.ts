import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import {
  applyBulkLevel,
  listGroups,
  listOperations,
  mergeGroups,
  updateGroup,
  updateOperation,
} from '../../catalog/groups.js';
import { findRegistryEntries, scopesFromQuery } from '../../catalog/registry.js';
import { createRule, deleteRule, listRules, updateRule } from '../../catalog/rules.js';
import { NotFoundError, ValidationError } from '../../errors.js';
import { ACCESS_LEVELS } from '../../gate/access.js';
import { AUTH_MODES } from '../../instances/manager.js';
import { clientIp, readJson, readOptionalJson } from '../common.js';
import type { AdminEnv } from './auth.js';
import { createRedactor, GLOBAL_SENSITIVE_KEYS } from '../../gate/redact.js';

/** Instance-scoped Admin API routes (design §8.4). Every mutation is audited by the service layer. */
export function registerInstanceRoutes(app: Hono<AdminEnv>, ctx: AppContext) {
  const actor = (c: { get: (k: 'user') => { id: string } }) => ({ userId: c.get('user').id });
  const exists = (id: string) => ctx.instances.get(id); // throws 404

  const Connection = z.object({
    config: z.record(z.string(), z.unknown()).default({}),
    secrets: z.record(z.string(), z.string().nullable()).default({}),
  });

  app.get('/api/instances', (c) => c.json(ctx.instances.list()));

  app.post('/api/instances', async (c) => {
    const body = await readJson(
      c,
      z.object({
        pluginId: z.string().min(1),
        slug: z.string().min(1).max(63),
        displayName: z.string().max(100).optional(),
        connection: z.record(z.string(), z.unknown()).default({}),
        authMode: z.enum(AUTH_MODES).nullable().optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
        enabled: z.boolean().optional(),
      }),
    );
    return c.json(await ctx.instances.create(body, actor(c)), 201);
  });

  app.get('/api/instances/:id', (c) => c.json(exists(c.req.param('id'))));

  app.patch('/api/instances/:id', async (c) => {
    const body = await readJson(
      c,
      z.object({
        displayName: z.string().max(100).optional(),
        slug: z.string().max(63).optional(),
        enabled: z.boolean().optional(),
        authMode: z.enum(AUTH_MODES).nullable().optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
      }),
    );
    return c.json(await ctx.instances.update(c.req.param('id'), body, actor(c)));
  });

  app.delete('/api/instances/:id', async (c) => {
    const { confirm } = await readJson(c, z.object({ confirm: z.string() }));
    await ctx.instances.remove(c.req.param('id'), confirm, actor(c));
    ctx.oauth.forgetInstance(c.req.param('id'));
    return c.body(null, 204);
  });

  app.get('/api/instances/:id/connection', (c) => c.json(ctx.instances.getConnection(c.req.param('id'))));

  app.put('/api/instances/:id/connection', async (c) => {
    const body = await readJson(c, Connection);
    return c.json(await ctx.instances.updateConnection(c.req.param('id'), body, actor(c)));
  });

  // Testing a connection makes the server talk to arbitrary hosts; throttled so it can't be an oracle.
  app.post('/api/instances/:id/connection/test', async (c) => {
    if (!ctx.throttle.allowIp(clientIp(c, ctx.config.TRUST_PROXY))) {
      return c.json({ error: 'rate_limited', message: 'Too many attempts; try again later' }, 429);
    }
    const candidate = await readOptionalJson(c, Connection);
    return c.json(await ctx.instances.testConnection(c.req.param('id'), candidate));
  });

  app.post('/api/instances/:id/sync', async (c) => {
    exists(c.req.param('id'));
    return c.json(await ctx.instances.syncNow(c.req.param('id')));
  });

  // ── access groups & operations (design §5.2.1) ──

  app.get('/api/instances/:id/groups', (c) => {
    exists(c.req.param('id'));
    return c.json(listGroups(ctx.db, c.req.param('id')));
  });

  app.patch('/api/instances/:id/groups/:key', async (c) => {
    const id = c.req.param('id');
    exists(id);
    const body = await readJson(
      c,
      z.object({
        level: z.string().optional(),
        label: z.string().optional(),
      }),
    );
    return c.json(updateGroup(ctx.db, id, c.req.param('key'), body, { actor: actor(c) }));
  });

  app.post('/api/instances/:id/groups/merge', async (c) => {
    const id = c.req.param('id');
    exists(id);
    const body = await readJson(
      c,
      z.object({ from: z.array(z.string()).min(1), into: z.string().min(1), label: z.string().optional() }),
    );
    return c.json(mergeGroups(ctx.db, id, body, { actor: actor(c) }));
  });

  app.post('/api/instances/:id/groups/bulk-level', async (c) => {
    exists(c.req.param('id'));
    const body = await readJson(c, z.object({ level: z.string() }));
    return c.json(applyBulkLevel(ctx.db, c.req.param('id'), body.level, { actor: actor(c) }));
  });

  app.get('/api/instances/:id/operations', (c) => {
    const id = c.req.param('id');
    exists(id);
    return c.json(listOperations(ctx.db, id, c.req.query()));
  });

  app.patch('/api/instances/:id/operations/:opId', async (c) => {
    const body = await readJson(
      c,
      z.object({
        level: z.enum(ACCESS_LEVELS).nullable().optional(),
        acknowledged: z.boolean().optional(),
        attestationRequired: z.boolean().optional(),
      }),
    );
    return c.json(updateOperation(ctx.db, c.req.param('id'), c.req.param('opId'), body, { actor: actor(c) }));
  });

  // ── pickers ──

  app.get('/api/instances/:id/registry', (c) => {
    exists(c.req.param('id'));
    // Mirrored attributes can hold tokens (an `access_token`, say); the portal gets them redacted too.
    const query = c.req.query();
    const entries = findRegistryEntries(ctx.db, c.req.param('id'), { ...query, scopes: scopesFromQuery(query) });
    let redact = createRedactor(GLOBAL_SENSITIVE_KEYS);
    try {
      redact = ctx.instances.runtime(c.req.param('id')).redact;
    } catch {
      // Plugin not usable right now: the global keys still apply.
    }
    return c.json(redact(entries));
  });

  app.get('/api/instances/:id/options/:source', async (c) => {
    const rt = ctx.instances.runtime(c.req.param('id'));
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(c.req.param('source')))
      throw new ValidationError('invalid_source', 'Invalid options source');
    return c.json(await rt.plugin().call('optionsFor', { source: c.req.param('source'), query: c.req.query('q') }));
  });

  // ── pre-approval rules ──

  app.get('/api/instances/:id/rules', (c) => {
    exists(c.req.param('id'));
    return c.json(listRules(ctx.db, c.req.param('id')));
  });

  app.post('/api/instances/:id/rules', async (c) => {
    const rt = ctx.instances.runtime(c.req.param('id'));
    return c.json(createRule(ctx.db, rt.manifest, rt.instanceId, await readJson(c, z.unknown()), actor(c)), 201);
  });

  app.patch('/api/instances/:id/rules/:ruleId', async (c) => {
    const rt = ctx.instances.runtime(c.req.param('id'));
    return c.json(
      updateRule(ctx.db, rt.manifest, rt.instanceId, c.req.param('ruleId'), await readJson(c, z.unknown()), actor(c)),
    );
  });

  app.delete('/api/instances/:id/rules/:ruleId', (c) => {
    deleteRule(ctx.db, c.req.param('id'), c.req.param('ruleId'), actor(c));
    return c.body(null, 204);
  });

  // ── session grants (design §5.8) ──

  app.get('/api/instances/:id/session-grants', (c) => {
    exists(c.req.param('id'));
    return c.json(
      ctx.grants.list(c.req.param('id')).map((g) => ({
        id: g.id,
        client: g.client ?? null,
        createdBy: g.createdBy,
        createdAt: g.createdAt.toISOString(),
        expiresAt: g.expiresAt.toISOString(),
      })),
    );
  });

  app.delete('/api/instances/:id/session-grants/:grantId', (c) => {
    const grant = ctx.grants.get(c.req.param('grantId'));
    if (!grant || grant.instanceId !== c.req.param('id'))
      throw new NotFoundError('grant_not_found', 'No such session grant');
    ctx.grants.revoke(grant.id, { actorKind: 'user', actorId: c.get('user').id });
    return c.body(null, 204);
  });
}
