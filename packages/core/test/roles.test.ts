import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluatePreApproval } from '../src/gate/preapproval.js';
import { createAdminApp } from '../src/http/admin-app.js';
import { updateSettings } from '../src/settings.js';
import { browser } from './admin-client.js';
import { createTestApp } from './helpers.js';

const PASSWORD = 'correct horse battery';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

type LevelView = {
  groups: { key: string; roleLevel: string | null; ownLevel: string | null }[];
  operations: { id: string; key: string; level: string; roleMax: string; reachable: boolean }[];
};

/** An admin, one echo endpoint, and a role "Operators" holding it, with a signed-in user of that role. */
async function setup(flags: Record<string, boolean> = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'synoikia-roles-'));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const ctx = await createTestApp({ DATA_DIR: dataDir }, { memoryDb: true });
  cleanup.push(() => ctx.stop());
  const app = createAdminApp(ctx);
  const admin = await browser(app).init();
  expect((await admin.post('/api/setup', { username: 'admin', password: PASSWORD })).status).toBe(200);
  const inst = (await (
    await admin.post('/api/instances', { pluginId: 'echo', slug: 'echo', connection: {} })
  ).json()) as { id: string };
  const other = (await (
    await admin.post('/api/instances', { pluginId: 'echo', slug: 'other', connection: {} })
  ).json()) as { id: string };
  await ctx.instances.syncNow(inst.id);
  await ctx.instances.syncNow(other.id);
  const role = (await (await admin.post('/api/roles', { name: 'Operators', ...flags })).json()) as { id: string };
  expect((await admin.put(`/api/roles/${role.id}/instances`, { instanceIds: [inst.id] })).status).toBe(200);
  const created = await admin.post('/api/users', { username: 'olga', password: PASSWORD, roleId: role.id });
  expect(created.status).toBe(201);
  const user = await browser(app).init();
  expect((await user.post('/auth/login', { username: 'olga', password: PASSWORD })).status).toBe(200);
  const userId = ((await created.json()) as { id: string }).id;
  return { ctx, app, admin, user, userId, instanceId: inst.id, otherId: other.id, roleId: role.id };
}

describe('roles: admin API', () => {
  it('keeps every route outside the profile and /api/me admin-only', async () => {
    const t = await setup({ canSetOwnLevels: true, canManageOwnRules: true, canSeeStatus: true });
    const open = ['/api/session', '/api/setup', '/api/profile', '/api/me'];
    const routes = t.app.routes.filter(
      (r) =>
        r.method !== 'ALL' &&
        r.path.startsWith('/api/') &&
        !open.some((p) => r.path === p || r.path.startsWith(`${p}/`)),
    );
    expect(routes.length).toBeGreaterThan(40);
    for (const r of routes) {
      const res = await t.user.req(r.method, r.path.replace(/:[a-zA-Z]+/g, 'x'), r.method === 'GET' ? undefined : {});
      expect({ route: `${r.method} ${r.path}`, status: res.status }).toEqual({
        route: `${r.method} ${r.path}`,
        status: 403,
      });
    }
  });

  it('creates, changes and deletes roles; Admin stays fixed', async () => {
    const t = await setup();
    const list = (await (await t.admin.get('/api/roles')).json()) as { id: string; users: number; isAdmin: boolean }[];
    expect(list.map((r) => [r.isAdmin, r.users])).toEqual([
      [true, 1],
      [false, 1],
    ]);
    expect(await (await t.admin.patch('/api/roles/admin', { name: 'Root' })).json()).toMatchObject({
      error: 'built_in_role',
    });
    expect((await t.admin.del('/api/roles/admin')).status).toBe(409);
    expect(await (await t.admin.post('/api/roles', { name: 'Operators' })).json()).toMatchObject({
      error: 'role_name_taken',
    });
    expect(await (await t.admin.del(`/api/roles/${t.roleId}`)).json()).toMatchObject({ error: 'role_in_use' });
    updateSettings(t.ctx.db, 'security', { defaultRoleId: t.roleId });
    expect((await t.admin.patch(`/api/users/${t.userId}`, { roleId: 'admin' })).status).toBe(200);
    expect(await (await t.admin.del(`/api/roles/${t.roleId}`)).json()).toMatchObject({ error: 'default_role' });
    updateSettings(t.ctx.db, 'security', { defaultRoleId: null });
    expect((await t.admin.del(`/api/roles/${t.roleId}`)).status).toBe(204);
  });

  it('never leaves the server without an enabled admin', async () => {
    const t = await setup();
    const me = (await (await t.admin.get('/api/profile')).json()) as { id: string };
    expect(await (await t.admin.patch(`/api/users/${me.id}`, { roleId: t.roleId })).json()).toMatchObject({
      error: 'last_admin',
    });
    await t.admin.patch(`/api/users/${t.userId}`, { roleId: 'admin' });
    // The change applies on the next request: olga is an admin now.
    expect((await t.user.get('/api/instances')).status).toBe(200);
    expect((await t.admin.patch(`/api/users/${me.id}`, { roleId: t.roleId })).status).toBe(200);
    expect((await t.admin.get('/api/instances')).status).toBe(403);
  });

  it('sets role maximums under the endpoint level and only on the role’s endpoints', async () => {
    const t = await setup();
    const base = `/api/roles/${t.roleId}/endpoints/${t.instanceId}`;
    let view = (await (await t.admin.get(`${base}/access`)).json()) as LevelView;
    expect(view.operations.length).toBeGreaterThan(2);
    expect(view.operations.every((o) => !o.reachable && o.roleMax === 'none')).toBe(true);
    view = (await (await t.admin.put(`${base}/groups/echo`, { level: 'write' })).json()) as LevelView;
    // Catalog sync puts the group at Ask: the role's Write is capped there.
    expect(view.operations.find((o) => o.key === 'echo.set')).toMatchObject({ roleMax: 'ask', level: 'ask' });
    expect(view.operations.find((o) => o.key === 'echo.query')).toMatchObject({ roleMax: 'read', level: 'read' });
    const set = view.operations.find((o) => o.key === 'echo.set')!;
    expect((await t.admin.put(`${base}/operations/${set.id}`, { level: 'read' })).status).toBe(400);
    view = (await (await t.admin.put(`${base}/operations/${set.id}`, { level: 'none' })).json()) as LevelView;
    expect(view.operations.find((o) => o.key === 'echo.set')).toMatchObject({ reachable: false });
    expect(
      await (await t.admin.put(`/api/roles/${t.roleId}/endpoints/${t.otherId}/groups/echo`, { level: 'read' })).json(),
    ).toMatchObject({ error: 'not_in_role' });
    expect(
      (await t.admin.put(`/api/roles/admin/endpoints/${t.instanceId}/groups/echo`, { level: 'read' })).status,
    ).toBe(409);
  });
});

describe('roles: what a user sees and changes', () => {
  it('lists only the role’s endpoints and reachable operations, without status unless allowed', async () => {
    const t = await setup();
    await t.admin.put(`/api/roles/${t.roleId}/endpoints/${t.instanceId}/groups/echo`, { level: 'read' });
    const endpoints = (await (await t.user.get('/api/me/endpoints')).json()) as { id: string; status?: unknown }[];
    expect(endpoints.map((e) => e.id)).toEqual([t.instanceId]);
    expect(endpoints[0]!.status).toBeUndefined();
    const view = (await (await t.user.get(`/api/me/endpoints/${t.instanceId}/access`)).json()) as LevelView;
    expect(view.operations.map((o) => o.key)).toContain('echo.query');
    expect(view.operations.map((o) => o.key)).not.toContain('echo.set');
    expect((await t.user.get(`/api/me/endpoints/${t.otherId}/access`)).status).toBe(404);
    // No switches: no own levels, no rules.
    expect((await t.user.put(`/api/me/endpoints/${t.instanceId}/groups/echo`, { level: 'none' })).status).toBe(403);
    expect((await t.user.get(`/api/me/endpoints/${t.instanceId}/rules`)).status).toBe(403);

    await t.admin.patch(`/api/roles/${t.roleId}`, { canSeeStatus: true });
    const withStatus = (await (await t.user.get('/api/me/endpoints')).json()) as { status?: { enabled: boolean } }[];
    expect(withStatus[0]!.status).toMatchObject({ enabled: true });
  });

  it('sets own levels up to the role maximum', async () => {
    const t = await setup({ canSetOwnLevels: true });
    await t.admin.put(`/api/roles/${t.roleId}/endpoints/${t.instanceId}/groups/echo`, { level: 'ask' });
    const base = `/api/me/endpoints/${t.instanceId}`;
    expect(await (await t.user.put(`${base}/groups/echo`, { level: 'write' })).json()).toMatchObject({
      error: 'above_role_max',
    });
    let view = (await (await t.user.put(`${base}/groups/echo`, { level: 'read' })).json()) as LevelView;
    expect(view.groups[0]).toMatchObject({ roleLevel: 'ask', ownLevel: 'read' });
    expect(view.operations.map((o) => o.key)).not.toContain('echo.set');
    view = (await (await t.user.put(`${base}/groups/echo`, { level: null })).json()) as LevelView;
    const query = view.operations.find((o) => o.key === 'echo.query')!;
    view = (await (await t.user.put(`${base}/operations/${query.id}`, { level: 'ask' })).json()) as LevelView;
    expect(view.operations.find((o) => o.key === 'echo.query')).toMatchObject({ level: 'ask', roleMax: 'read' });
    // A lowered maximum caps what the user set earlier.
    await t.admin.put(`/api/roles/${t.roleId}/endpoints/${t.instanceId}/groups/echo`, { level: 'read' });
    view = (await (await t.user.get(`${base}/access`)).json()) as LevelView;
    expect(view.operations.find((o) => o.key === 'echo.query')).toMatchObject({ level: 'ask' });
  });

  it('keeps own rules to their owner and admin rules read-only', async () => {
    const t = await setup({ canManageOwnRules: true });
    await t.admin.put(`/api/roles/${t.roleId}/endpoints/${t.instanceId}/groups/echo`, { level: 'ask' });
    const ops = (await (await t.admin.get(`/api/instances/${t.instanceId}/operations`)).json()) as {
      id: string;
      key: string;
    }[];
    const set = ops.find((o) => o.key === 'echo.set')!;
    const adminRule = (await (
      await t.admin.post(`/api/instances/${t.instanceId}/rules`, { operationId: set.id, reason: 'house rule' })
    ).json()) as { id: string };
    const base = `/api/me/endpoints/${t.instanceId}/rules`;
    const mine = await t.user.post(base, { operationId: set.id, reason: 'my own rule' });
    expect(mine.status).toBe(201);
    const mineId = ((await mine.json()) as { id: string }).id;
    const list = (await (await t.user.get(base)).json()) as { id: string; editable: boolean }[];
    expect(list.map((r) => [r.id, r.editable])).toEqual(
      expect.arrayContaining([
        [adminRule.id, false],
        [mineId, true],
      ]),
    );
    expect((await t.user.patch(`${base}/${adminRule.id}`, { reason: 'mine now' })).status).toBe(404);
    expect((await t.user.del(`${base}/${adminRule.id}`)).status).toBe(404);
    expect((await t.user.patch(`${base}/${mineId}`, { reason: 'changed rule' })).status).toBe(200);
    // An operation the user can't reach takes no rule.
    const del = ops.find((o) => o.key === 'echo.delete')!;
    expect((await t.user.post(base, { operationId: del.id, reason: 'not mine' })).status).toBe(400);
    const all = (await (await t.admin.get(`/api/instances/${t.instanceId}/rules`)).json()) as {
      id: string;
      owner: { username: string } | null;
    }[];
    expect(all.find((r) => r.id === mineId)?.owner).toMatchObject({ username: 'olga' });
  });

  it('creates tokens only for the role’s endpoints and lists only the user’s own', async () => {
    const t = await setup();
    expect((await t.user.post('/api/me/tokens', { name: 'x', scope: [t.otherId] })).status).toBe(400);
    expect((await t.user.post('/api/me/tokens', { name: 'mine', scope: [t.instanceId] })).status).toBe(201);
    const adminToken = (await (await t.admin.post('/api/me/tokens', { name: 'adm', scope: ['*'] })).json()) as {
      id: string;
    };
    const mine = (await (await t.user.get('/api/me/tokens')).json()) as { name: string }[];
    expect(mine.map((x) => x.name)).toEqual(['mine']);
    expect((await t.user.del(`/api/me/tokens/${adminToken.id}`)).status).toBe(404);
  });
});

describe('self-registration', () => {
  it('opens the sign-up form only with a default role and the switch on', async () => {
    const t = await setup();
    const visitor = await browser(t.app).init();
    const signup = () => visitor.post('/auth/register', { username: 'newbie', password: PASSWORD });
    expect((await signup()).status).toBe(403);
    updateSettings(t.ctx.db, 'security', { localSignup: true });
    expect((await signup()).status).toBe(403);
    expect((await t.admin.put('/api/settings/security', { defaultRoleId: 'nope' })).status).toBe(404);
    expect((await t.admin.put('/api/settings/security', { defaultRoleId: t.roleId })).status).toBe(200);
    expect(await (await visitor.get('/api/session')).json()).toMatchObject({ signupOpen: true });
    expect((await signup()).status).toBe(201);
    const session = (await (await visitor.get('/api/session')).json()) as { user: { role: { id: string } } };
    expect(session.user.role.id).toBe(t.roleId);
    expect((await visitor.get('/api/instances')).status).toBe(403);
  });
});

describe('own pre-approval rules in the gate', () => {
  it('approve only their owner’s calls, and only while the role allows own rules', async () => {
    const t = await setup({ canManageOwnRules: true });
    await t.admin.put(`/api/roles/${t.roleId}/endpoints/${t.instanceId}/groups/echo`, { level: 'ask' });
    const ops = (await (await t.admin.get(`/api/instances/${t.instanceId}/operations`)).json()) as {
      id: string;
      key: string;
    }[];
    const set = ops.find((o) => o.key === 'echo.set')!;
    const rule = (await (
      await t.user.post(`/api/me/endpoints/${t.instanceId}/rules`, { operationId: set.id, reason: 'my own rule' })
    ).json()) as { id: string };
    const evaluate = (userId?: string) =>
      evaluatePreApproval(t.ctx.db, { instanceId: t.instanceId, operationId: set.id, params: {}, targets: [], userId });
    expect(evaluate(t.userId)).toEqual({ kind: 'auto_approved', ruleId: rule.id });
    expect(evaluate()).toEqual({ kind: 'no_match' });
    const me = (await (await t.admin.get('/api/profile')).json()) as { id: string };
    expect(evaluate(me.id)).toEqual({ kind: 'no_match' });
    await t.admin.patch(`/api/roles/${t.roleId}`, { canManageOwnRules: false });
    expect(evaluate(t.userId)).toEqual({ kind: 'no_match' });
  });
});
