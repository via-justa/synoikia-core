import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import type { PublicRole } from '../../auth/roles.js';
import { levelView, roleHasInstance, roleInstanceIds, setOwnLevel } from '../../catalog/role-levels.js';
import { createRule, deleteRule, listRules, updateRule } from '../../catalog/rules.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../errors.js';
import { ACCESS_LEVELS } from '../../gate/access.js';
import { getSettings } from '../../settings.js';
import { readJson } from '../common.js';
import type { AdminEnv } from './auth.js';

/** What every signed-in user may use (design §6.4, §8.4): their endpoints and levels, their own levels
 * and rules where the role allows them, and their own tokens and OAuth grants. */
export function registerMeRoutes(app: Hono<AdminEnv>, ctx: AppContext) {
  const me = (c: Context<AdminEnv>) => c.get('user');
  const roleOf = (c: Context<AdminEnv>): PublicRole => ctx.users.roleOf(me(c));
  const mcpBase = () => ctx.config.PUBLIC_MCP_URL?.replace(/\/$/, '') ?? '';

  /** An endpoint of the caller's role; any other answers 404, as if it didn't exist. */
  const myInstance = (c: Context<AdminEnv>) => {
    const id = c.req.param('id') ?? '';
    if (!roleHasInstance(ctx.db, me(c).roleId, id)) throw new NotFoundError('instance_not_found', 'No such endpoint');
    return ctx.instances.get(id);
  };
  const need = (c: Context<AdminEnv>, cap: 'canSetOwnLevels' | 'canManageOwnRules') => {
    if (!roleOf(c)[cap]) throw new ForbiddenError('forbidden', 'Your role does not allow this');
  };
  const view = (c: Context<AdminEnv>, instanceId: string) =>
    levelView(ctx.db, instanceId, { roleId: me(c).roleId, userId: me(c).id }, { reachableOnly: !roleOf(c).isAdmin });

  app.get('/api/me/endpoints', (c) => {
    const role = roleOf(c);
    const mine = role.isAdmin ? null : new Set(roleInstanceIds(ctx.db, role.id));
    const mode = getSettings(ctx.db, 'mcp').defaultAuthMode;
    return c.json(
      ctx.instances
        .list()
        .filter((i) => !mine || mine.has(i.id))
        .map((i) => ({
          id: i.id,
          slug: i.slug,
          displayName: i.displayName,
          endpointUrl: `${mcpBase()}/${i.slug}`,
          authMode: i.authMode ?? mode,
          // Live status only where the role shows it (design §6.4).
          ...(role.isAdmin || role.canSeeStatus
            ? {
                status: {
                  enabled: i.enabled,
                  state: i.status,
                  error: i.statusError,
                  plugin: i.plugin.name,
                  upstreamVersion: i.upstreamVersion,
                  lastSyncedAt: i.lastSyncedAt,
                  lastSyncStatus: i.lastSyncStatus,
                },
              }
            : {}),
        })),
    );
  });

  app.get('/api/me/endpoints/:id/access', (c) => c.json(view(c, myInstance(c).id)));

  const Level = z.object({ level: z.enum(ACCESS_LEVELS).nullable() });

  app.put('/api/me/endpoints/:id/groups/:key', async (c) => {
    need(c, 'canSetOwnLevels');
    const { id } = myInstance(c);
    const { level } = await readJson(c, Level);
    setOwnLevel(ctx.db, me(c).id, id, { group: c.req.param('key') }, level);
    return c.json(view(c, id));
  });

  app.put('/api/me/endpoints/:id/operations/:opId', async (c) => {
    need(c, 'canSetOwnLevels');
    const { id } = myInstance(c);
    const { level } = await readJson(c, Level);
    setOwnLevel(ctx.db, me(c).id, id, { operationId: c.req.param('opId') }, level);
    return c.json(view(c, id));
  });

  // ── own pre-approval rules ──

  /** The caller's own rules, plus admin rules on operations they can reach (read-only to them). */
  const myRules = (c: Context<AdminEnv>, instanceId: string) => {
    const reachable = new Set(view(c, instanceId).operations.map((o) => o.id));
    return listRules(ctx.db, instanceId)
      .filter((r) => r.ownerUserId === me(c).id || (r.ownerUserId === null && reachable.has(r.operationId)))
      .map((r) => ({ ...r, editable: r.ownerUserId === me(c).id }));
  };
  const reachableOp = (c: Context<AdminEnv>, instanceId: string, raw: unknown) => {
    const opId = (raw as { operationId?: unknown } | null)?.operationId;
    if (opId === undefined) return;
    if (!view(c, instanceId).operations.some((o) => o.id === opId))
      throw new ValidationError('operation_not_reachable', 'You can only write rules for operations you can call');
  };

  // What the rule editor needs from the manifest: the match fields and target scopes.
  app.get('/api/me/endpoints/:id/rule-form', (c) => {
    need(c, 'canManageOwnRules');
    const { manifest } = ctx.instances.runtime(myInstance(c).id);
    return c.json({ matchProfiles: manifest.matchProfiles, targets: manifest.targets ?? null });
  });

  app.get('/api/me/endpoints/:id/rules', (c) => {
    need(c, 'canManageOwnRules');
    return c.json(myRules(c, myInstance(c).id));
  });

  app.post('/api/me/endpoints/:id/rules', async (c) => {
    need(c, 'canManageOwnRules');
    const { id } = myInstance(c);
    const raw = await readJson(c, z.unknown());
    if ((raw as { operationId?: unknown } | null)?.operationId === undefined)
      throw new ValidationError('invalid_rule', 'operationId is required');
    reachableOp(c, id, raw);
    const rt = ctx.instances.runtime(id);
    const rule = createRule(ctx.db, rt.manifest, id, raw, { userId: me(c).id }, { owner: me(c).id });
    return c.json({ ...rule, editable: true }, 201);
  });

  app.patch('/api/me/endpoints/:id/rules/:ruleId', async (c) => {
    need(c, 'canManageOwnRules');
    const { id } = myInstance(c);
    const raw = await readJson(c, z.unknown());
    reachableOp(c, id, raw);
    const rt = ctx.instances.runtime(id);
    const rule = updateRule(
      ctx.db,
      rt.manifest,
      id,
      c.req.param('ruleId'),
      raw,
      { userId: me(c).id },
      {
        owner: me(c).id,
      },
    );
    return c.json({ ...rule, editable: true });
  });

  app.delete('/api/me/endpoints/:id/rules/:ruleId', (c) => {
    need(c, 'canManageOwnRules');
    const { id } = myInstance(c);
    deleteRule(ctx.db, id, c.req.param('ruleId'), { userId: me(c).id }, { owner: me(c).id });
    return c.body(null, 204);
  });

  // ── own MCP credentials ──

  app.get('/api/me/tokens', (c) => c.json(ctx.tokens.list(me(c).id)));

  app.post('/api/me/tokens', async (c) => {
    const raw = await readJson(c, z.object({ scope: z.array(z.string()).min(1) }).passthrough());
    const role = roleOf(c);
    if (!role.isAdmin) {
      // `*` follows the role's endpoints as they change; named endpoints must be the role's now.
      const mine = new Set(roleInstanceIds(ctx.db, role.id));
      const outside = raw.scope.filter((s) => s !== '*' && !mine.has(s));
      if (outside.length)
        throw new ValidationError('unknown_instance', `Unknown endpoint(s) in scope: ${outside.join(', ')}`);
    }
    return c.json(ctx.tokens.create(raw, { userId: me(c).id }), 201);
  });

  app.delete('/api/me/tokens/:id', (c) => {
    if (ctx.tokens.ownerOf(c.req.param('id')) !== me(c).id) throw new NotFoundError('token_not_found', 'No such token');
    ctx.tokens.revoke(c.req.param('id'), { userId: me(c).id });
    return c.body(null, 204);
  });

  app.get('/api/me/grants', (c) => c.json(ctx.oauth.listGrants(me(c).id)));

  app.delete('/api/me/grants/:id', (c) => {
    if (!ctx.oauth.listGrants(me(c).id).some((g) => g.id === c.req.param('id')))
      throw new NotFoundError('grant_not_found', 'No such grant');
    ctx.oauth.revokeGrant(c.req.param('id'), { userId: me(c).id });
    return c.body(null, 204);
  });
}
