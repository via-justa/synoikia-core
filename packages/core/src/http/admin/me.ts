import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { findRegistryEntries, scopesFromQuery } from '../../catalog/registry.js';
import {
  checkOwnOptionsSource,
  checkOwnRegistryKind,
  createOwnRule,
  deleteOwnRule,
  listOwnRules,
  updateOwnRule,
} from '../../catalog/rules.js';
import type { RuleOwner } from '../../catalog/rules.js';
import { NotFoundError } from '../../errors.js';
import { ACCESS_LEVELS } from '../../gate/access.js';
import { readJson } from '../common.js';
import type { AdminEnv } from './auth.js';

/** What every signed-in user may use (design §6.4, §8.4): their endpoints and levels, their own levels
 * and rules where the role allows them, and their own tokens and OAuth grants. */
export function registerMeRoutes(app: Hono<AdminEnv>, ctx: AppContext) {
  const me = (c: Context<AdminEnv>) => c.get('user');
  const mcpBase = () => ctx.config.PUBLIC_MCP_URL?.replace(/\/$/, '') ?? '';
  const myInstance = (c: Context<AdminEnv>) => ctx.instances.get(ctx.users.ownEndpoint(me(c), c.req.param('id') ?? ''));
  const need = (c: Context<AdminEnv>, cap: 'canSetOwnLevels' | 'canManageOwnRules') =>
    ctx.users.assertAllowed(me(c), cap);
  const owner = (c: Context<AdminEnv>, instanceId: string): RuleOwner => ({
    userId: me(c).id,
    operations: ctx.users.levels(me(c), instanceId).operations,
  });

  app.get('/api/me/endpoints', (c) => c.json(ctx.instances.listForRole(ctx.users.roleOf(me(c)), mcpBase())));

  app.get('/api/me/endpoints/:id/access', (c) => c.json(ctx.users.levels(me(c), myInstance(c).id)));

  const Level = z.object({ level: z.enum(ACCESS_LEVELS).nullable() });

  app.put('/api/me/endpoints/:id/groups/:key', async (c) => {
    need(c, 'canSetOwnLevels');
    const { id } = myInstance(c);
    const { level } = await readJson(c, Level);
    return c.json(ctx.users.setOwnLevel(me(c), id, { group: c.req.param('key') }, level));
  });

  app.put('/api/me/endpoints/:id/operations/:opId', async (c) => {
    need(c, 'canSetOwnLevels');
    const { id } = myInstance(c);
    const { level } = await readJson(c, Level);
    return c.json(ctx.users.setOwnLevel(me(c), id, { operationId: c.req.param('opId') }, level));
  });

  // ── own pre-approval rules ──

  // What the rule editor needs from the manifest: the match fields and target scopes.
  app.get('/api/me/endpoints/:id/rule-form', (c) => {
    need(c, 'canManageOwnRules');
    const { manifest } = ctx.instances.runtime(myInstance(c).id);
    return c.json({ matchProfiles: manifest.matchProfiles, targets: manifest.targets ?? null });
  });

  // The editor's pickers, limited to what a rule the caller may write can name (design §6.4).
  app.get('/api/me/endpoints/:id/options/:source', async (c) => {
    need(c, 'canManageOwnRules');
    const { id } = myInstance(c);
    const source = c.req.param('source');
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(source))
      throw new NotFoundError('options_not_found', 'No such options source');
    checkOwnOptionsSource(ctx.instances.runtime(id).manifest, owner(c, id), source);
    // Each call reaches the upstream with the instance's credential: a budget per user.
    if (!ctx.limiter.allows(`options:${me(c).id}`, 60, 60_000))
      return c.json({ error: 'rate_limited', message: 'Too many requests; slow down' }, 429);
    const rt = ctx.instances.runtime(id);
    const options = await rt.plugin().call('optionsFor', { source, query: c.req.query('q')?.slice(0, 200) });
    // Only what the picker shows, redacted: `meta` and secrets in labels never reach a non-admin.
    return c.json(rt.redact(options.map(({ value, label }) => ({ value, label }))));
  });

  app.get('/api/me/endpoints/:id/registry', (c) => {
    need(c, 'canManageOwnRules');
    const { id } = myInstance(c);
    const query = c.req.query();
    checkOwnRegistryKind(ctx.instances.runtime(id).manifest, owner(c, id), query.kind);
    // Only what the picker shows: attributes stay out, they can hold upstream secrets.
    const entries = findRegistryEntries(ctx.db, id, { ...query, scopes: scopesFromQuery(query) }).map(
      ({ kind, id: extId, name, parentId, scopes }) => ({ kind, id: extId, name, parentId, scopes }),
    );
    return c.json(ctx.instances.runtime(id).redact(entries));
  });

  app.get('/api/me/endpoints/:id/rules', (c) => {
    need(c, 'canManageOwnRules');
    const { id } = myInstance(c);
    return c.json(listOwnRules(ctx.db, id, owner(c, id)));
  });

  app.post('/api/me/endpoints/:id/rules', async (c) => {
    need(c, 'canManageOwnRules');
    const { id } = myInstance(c);
    const raw = await readJson(c, z.unknown());
    const manifest = () => ctx.instances.runtime(id).manifest;
    return c.json(createOwnRule(ctx.db, manifest, id, raw, owner(c, id)), 201);
  });

  app.patch('/api/me/endpoints/:id/rules/:ruleId', async (c) => {
    need(c, 'canManageOwnRules');
    const { id } = myInstance(c);
    const raw = await readJson(c, z.unknown());
    const manifest = () => ctx.instances.runtime(id).manifest;
    return c.json(updateOwnRule(ctx.db, manifest, id, c.req.param('ruleId'), raw, owner(c, id)));
  });

  app.delete('/api/me/endpoints/:id/rules/:ruleId', (c) => {
    need(c, 'canManageOwnRules');
    deleteOwnRule(ctx.db, myInstance(c).id, c.req.param('ruleId'), me(c).id);
    return c.body(null, 204);
  });

  // ── own MCP credentials ──

  app.get('/api/me/tokens', (c) => c.json(ctx.tokens.list(me(c).id)));

  app.post('/api/me/tokens', async (c) => {
    const raw = await readJson(c, z.object({ scope: z.array(z.string()).min(1) }).passthrough());
    return c.json(ctx.tokens.createOwn(raw, me(c)), 201);
  });

  app.delete('/api/me/tokens/:id', (c) => {
    ctx.tokens.revokeOwn(c.req.param('id'), me(c).id);
    return c.body(null, 204);
  });

  app.get('/api/me/grants', (c) => c.json(ctx.oauth.listGrants(me(c).id)));

  app.delete('/api/me/grants/:id', (c) => {
    ctx.oauth.revokeOwnGrant(c.req.param('id'), me(c).id);
    return c.body(null, 204);
  });
}
