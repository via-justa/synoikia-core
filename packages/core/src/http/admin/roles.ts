import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { levelView, setRoleBulkLevel, setRoleLevel } from '../../catalog/role-levels.js';
import { ACCESS_LEVELS } from '../../gate/access.js';
import { readJson } from '../common.js';
import type { AdminEnv } from './auth.js';

/** Role management (design §6.4, §8.4): admin only, like everything outside `/api/me` and the profile. */
export function registerRoleRoutes(app: Hono<AdminEnv>, ctx: AppContext) {
  const actor = (c: { get: (k: 'user') => { id: string } }) => ({ userId: c.get('user').id });
  const Level = z.object({ level: z.enum(ACCESS_LEVELS).nullable() });

  app.get('/api/roles', (c) => c.json(ctx.roles.list()));
  app.post('/api/roles', async (c) => c.json(ctx.roles.create(await readJson(c, z.unknown()), actor(c)), 201));
  app.patch('/api/roles/:id', async (c) =>
    c.json(ctx.roles.update(c.req.param('id'), await readJson(c, z.unknown()), actor(c))),
  );
  app.delete('/api/roles/:id', (c) => {
    ctx.roles.remove(c.req.param('id'), actor(c));
    return c.body(null, 204);
  });

  app.put('/api/roles/:id/instances', async (c) => {
    const { instanceIds } = await readJson(c, z.object({ instanceIds: z.array(z.string()).max(1000) }));
    return c.json({ instanceIds: ctx.roles.setInstances(c.req.param('id'), instanceIds, actor(c)) });
  });

  app.get('/api/roles/:id/endpoints/:instanceId/access', (c) => {
    const role = ctx.roles.get(c.req.param('id'));
    ctx.instances.get(c.req.param('instanceId'));
    return c.json(levelView(ctx.db, c.req.param('instanceId'), { roleId: role.id }));
  });

  app.put('/api/roles/:id/endpoints/:instanceId/groups/:key', async (c) => {
    const { level } = await readJson(c, Level);
    setRoleLevel(ctx.db, c.req.param('id'), c.req.param('instanceId'), { group: c.req.param('key') }, level, {
      actor: actor(c),
    });
    return c.json(levelView(ctx.db, c.req.param('instanceId'), { roleId: c.req.param('id') }));
  });

  app.put('/api/roles/:id/endpoints/:instanceId/operations/:opId', async (c) => {
    const { level } = await readJson(c, Level);
    setRoleLevel(ctx.db, c.req.param('id'), c.req.param('instanceId'), { operationId: c.req.param('opId') }, level, {
      actor: actor(c),
    });
    return c.json(levelView(ctx.db, c.req.param('instanceId'), { roleId: c.req.param('id') }));
  });

  app.post('/api/roles/:id/endpoints/:instanceId/bulk-level', async (c) => {
    const { level } = await readJson(c, z.object({ level: z.enum(ACCESS_LEVELS) }));
    setRoleBulkLevel(ctx.db, c.req.param('id'), c.req.param('instanceId'), level, { actor: actor(c) });
    return c.json(levelView(ctx.db, c.req.param('instanceId'), { roleId: c.req.param('id') }));
  });
}
