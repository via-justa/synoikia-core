import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, mountAt, signedIn } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const role = (flags: Partial<Record<'canSetOwnLevels' | 'canManageOwnRules' | 'canSeeStatus', boolean>> = {}) => ({
  id: 'r1',
  name: 'Operators',
  isAdmin: false,
  canSetOwnLevels: false,
  canManageOwnRules: false,
  canSeeStatus: false,
  ...flags,
});
const asUser = (flags: Parameters<typeof role>[0] = {}) => ({
  ...signedIn,
  user: { ...signedIn.user, id: 'u2', username: 'olga', role: role(flags) },
});

const mine = [
  { id: 'i1', slug: 'nas', displayName: 'Acme', endpointUrl: 'https://mcp.example/nas', authMode: 'bearer' },
];
const view = {
  groups: [{ key: 'app', label: 'Apps', endpointLevel: 'ask', roleLevel: 'ask', ownLevel: null }],
  operations: [
    {
      id: 'op1',
      key: 'app.start',
      displayName: null,
      description: null,
      group: 'app',
      classification: 'write',
      matchProfile: null,
      allowedLevels: ['none', 'ask', 'write'],
      endpointLevel: 'ask',
      roleLevel: null,
      roleMax: 'ask',
      ownLevel: null,
      level: 'ask',
      reachable: true,
      mode: 'approve',
      reason: null,
    },
  ],
};

describe('a non-admin user', () => {
  it('lands on My endpoints, with only their endpoints and profile in the menu', async () => {
    fakeApi({ 'GET /api/session': asUser(), 'GET /api/me/endpoints': mine });
    const { wrapper, router } = await mountAt('/');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/my');
    const nav = wrapper.get('nav').text();
    expect(nav).toContain('/nas');
    expect(nav).toContain('My profile');
    expect(nav).not.toContain('Plugins');
    expect(nav).not.toContain('Settings');
    expect(wrapper.text()).toContain('https://mcp.example/nas');
    // Admin pages send them back.
    await router.push('/settings/users');
    expect(router.currentRoute.value.path).toBe('/my');
  });

  it('sees levels read-only without the own-levels switch', async () => {
    fakeApi({ 'GET /api/session': asUser(), 'GET /api/me/endpoints': mine, 'GET /api/me/endpoints/i1/access': view });
    const { wrapper } = await mountAt('/my/i1');
    await flushPromises();
    expect(wrapper.text()).toContain('Apps');
    expect(wrapper.find('[role="radiogroup"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('My pre-approval rules');
  });

  it('sets their own level, capped by the role maximum', async () => {
    const { calls } = fakeApi({
      'GET /api/session': asUser({ canSetOwnLevels: true, canManageOwnRules: true }),
      'GET /api/me/endpoints': mine,
      'GET /api/me/endpoints/i1/access': view,
      'PUT /api/me/endpoints/i1/groups/app': view,
    });
    const { wrapper } = await mountAt('/my/i1');
    await flushPromises();
    expect(wrapper.text()).toContain('My pre-approval rules');
    const control = wrapper.get('[aria-label="Access for Apps"]');
    const button = (label: string) => control.findAll('button').find((b) => b.text() === label)!;
    expect(button('Write').attributes('disabled')).toBeDefined();
    await button('Read').trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      path: '/api/me/endpoints/i1/groups/app',
      body: { level: 'read' },
    });
  });
});

describe('roles for admins', () => {
  it('offers the role selector on the Access page and edits a role’s maximums', async () => {
    const instance = {
      id: 'i1',
      slug: 'nas',
      displayName: 'Acme',
      enabled: true,
      authMode: null,
      status: 'ready',
      statusError: null,
      upstreamVersion: null,
      lastSyncedAt: null,
      lastSyncStatus: 'ok',
      settings: {},
      plugin: { id: 'p1', pluginId: 'acme', name: 'Acme', enabled: true, status: 'ok' },
    };
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': { instances: [instance], plugins: [], warnings: [], publicMcpUrl: null },
      'GET /api/roles': [
        { ...role(), id: 'admin', name: 'Admin', isAdmin: true, users: 1, instanceIds: [], isDefault: false },
        { ...role(), users: 2, instanceIds: ['i1'], isDefault: false },
      ],
      'GET /api/instances/i1/groups': [],
      'GET /api/instances/i1/operations': [],
      'GET /api/roles/r1/endpoints/i1/access': view,
      'PUT /api/roles/r1/endpoints/i1/groups/app': view,
    });
    const { wrapper } = await mountAt('/endpoints/nas/access?role=r1');
    await flushPromises();
    expect(wrapper.get('select#access-role').text()).toContain('Operators');
    await wrapper
      .get('[aria-label="Access for Apps"]')
      .findAll('button')
      .find((b) => b.text() === 'None')!
      .trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      path: '/api/roles/r1/endpoints/i1/groups/app',
      body: { level: 'none' },
    });
  });
});

describe('sign-up', () => {
  it('shows “Create account” only while self-registration is open', async () => {
    const signedOut = {
      authenticated: false,
      setupRequired: false,
      localLoginEnabled: true,
      oidc: { enabled: false, label: 'SSO' },
    };
    fakeApi({ 'GET /api/session': signedOut });
    let { wrapper } = await mountAt('/login');
    expect(wrapper.text()).not.toContain('Create account');
    wrapper.unmount();
    const { calls } = fakeApi({
      'GET /api/session': { ...signedOut, signupOpen: true },
      'POST /auth/register': { status: 'ok' },
    });
    ({ wrapper } = await mountAt('/login'));
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Create account')!
      .trigger('click');
    await wrapper.get('input#username').setValue('newbie');
    await wrapper.get('input#password').setValue('correct horse battery');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.path === '/auth/register')?.body).toEqual({
      username: 'newbie',
      password: 'correct horse battery',
    });
  });
});

describe('own pre-approval rules', () => {
  it('fill the editor’s pickers from the user’s own endpoint routes', async () => {
    const own = {
      ...view,
      operations: [{ ...view.operations[0]!, matchProfile: 'vol' }],
    };
    const { calls } = fakeApi({
      'GET /api/session': asUser({ canManageOwnRules: true }),
      'GET /api/me/endpoints': mine,
      'GET /api/me/endpoints/i1/access': own,
      'GET /api/me/endpoints/i1/rules': [],
      'GET /api/me/endpoints/i1/rule-form': {
        matchProfiles: {
          vol: [
            { field: '/name', label: 'Name', op: 'in', widget: 'select', optionsSource: 'names' },
            { field: '$targets', label: 'Volumes', widget: 'registry-picker' },
          ],
        },
        targets: { label: 'Volume', registryKind: 'volume', scopes: [] },
      },
      'GET /api/me/endpoints/i1/options/names': [{ value: 'a', label: 'A' }],
      'GET /api/me/endpoints/i1/registry': [{ kind: 'volume', id: 'vol/a', name: 'A', parentId: null, scopes: null }],
    });
    const { wrapper } = await mountAt('/my/i1');
    await flushPromises();
    await wrapper
      .findAll('a')
      .find((a) => a.text() === 'My pre-approval rules')!
      .trigger('click');
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'New rule')!
      .trigger('click');
    await flushPromises();
    await wrapper.get('select#r-op').setValue('op1');
    await flushPromises();
    const paths = calls.map((c) => c.path);
    expect(paths.some((p) => p.startsWith('/api/me/endpoints/i1/registry?'))).toBe(true);
    expect(paths).toContain('/api/me/endpoints/i1/options/names');
    expect(paths.some((p) => p.startsWith('/api/instances') || p === '/api/plugins')).toBe(false);
  });
});
