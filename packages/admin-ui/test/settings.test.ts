import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Grant, PublicUser, RoleRow, Settings, Token } from '../src/types';
import { adminRole, fakeApi, json, mcpSettings, mountAt, signedIn } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const operators = { ...adminRole, id: 'r1', name: 'Operators', isAdmin: false };
const roles: RoleRow[] = [
  { ...adminRole, users: 1, endpoints: [], isDefault: false },
  { ...operators, users: 0, endpoints: [], isDefault: false },
];
const overview = { instances: [], plugins: [], warnings: [], publicMcpUrl: null };
const me: PublicUser = { ...signedIn.user, createdAt: '2026-01-01T00:00:00Z', lastLoginAt: null };
const settings: Settings = {
  security: {
    requireTotp: false,
    disableLocalLogin: false,
    sessionIdleMinutes: 60,
    approvalSessionIdleHours: 12,
    approvalSessionAbsoluteDays: 7,
    sessionAbsoluteHours: 24,
    defaultRoleId: null,
    localSignup: false,
  },
  mcp: mcpSettings,
  audit: { retentionDays: null },
  oidc: null,
  forceLocalLogin: false,
  publicMcpUrl: null,
  publicAdminUrl: null,
};

const button = (text: string, root: ParentNode = document.body) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const dialogTitle = () => document.getElementById(dialog()?.getAttribute('aria-labelledby') ?? '')?.textContent;
const writes = <C extends { method: string }>(calls: C[]) => calls.filter((c) => c.method !== 'GET');

async function click(text: string, root?: ParentNode) {
  button(text, root)!.click();
  await flushPromises();
}

describe('the User auth settings', () => {
  it('names the sign-in fields and has no audit retention', async () => {
    fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/settings': settings,
      'GET /api/roles': roles,
    });
    const { wrapper } = await mountAt('/settings/user-auth');
    expect(document.title).toBe('User auth · Synoikia');
    expect(wrapper.findAll('form h2').map((h) => h.text())).toEqual([
      'Sign-in',
      'Self-registration',
      'Single sign-on (OIDC)',
    ]);
    expect(wrapper.get('label[for="s-abs"]').text()).toBe('Max session authentication duration (hours)');
    expect(wrapper.get('label[for="s-role"]').text()).toBe('Default role of new accounts');
    expect(wrapper.find('#a-ret').exists()).toBe(false);
  });
});

describe('the Server settings', () => {
  it('saves the audit log retention, or shows why it failed', async () => {
    let fail = true;
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/settings': settings,
      'PUT /api/settings/audit': () =>
        fail ? json(400, { error: 'invalid', message: 'Too short' }) : { retentionDays: 30 },
    });
    const { wrapper } = await mountAt('/settings/server');
    expect(document.title).toBe('Server settings · Synoikia');
    expect(wrapper.get('#a-ret-help').text()).toContain('The default is 90 days.');
    await wrapper.get('input#a-ret').setValue('30');
    const form = wrapper.get('form');
    await form.trigger('submit');
    await flushPromises();
    expect(form.get('[role="alert"]').text()).toBe('Too short');
    fail = false;
    await form.trigger('submit');
    await flushPromises();
    expect(writes(calls).at(-1)).toEqual({ method: 'PUT', path: '/api/settings/audit', body: { retentionDays: 30 } });
    expect(form.get('[role="status"]').text()).toBe('Saved.');
  });
});

describe('the Client auth settings', () => {
  it('saves the client policy mode and names, with seen clients to add', async () => {
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/settings': settings,
      'GET /api/settings/mcp/clients-seen': [
        { name: 'seen-client', version: '2.1', client: 'token:laptop', lastSeen: new Date().toISOString() },
        { name: 'typed-client', version: '', client: '', lastSeen: new Date().toISOString() },
      ],
      'PUT /api/settings/mcp': (b: unknown) => b,
    });
    const { wrapper } = await mountAt('/settings/client-auth');
    await flushPromises();
    const card = () => wrapper.get('[data-card="clients"]');
    expect(card().get('[data-warn="client-names"]').text()).toContain('not a security boundary');
    expect(card().find('#m-names').exists()).toBe(false);
    expect(card().get('ul.seen-list li').text()).toMatch(/^seen-client\s*2\.1 · from token:laptop · just now/);
    const mode = (label: string) =>
      card()
        .findAll('label')
        .find((l) => l.text() === label)!
        .get('input');
    await mode('Allow only these clients').setValue(true);
    expect(card().get('[data-warn="no-client"]').text()).toContain('refuses every client');
    expect(wrapper.get<HTMLButtonElement>('button[type="submit"]').element.disabled).toBe(true);
    await card().get('#m-names').setValue('typed-client');
    await card().get('#m-names').trigger('keydown', { key: 'Enter' });
    await card().get('button[aria-label="Add seen-client"]').trigger('click');
    expect(card().find('button[aria-label="Add typed-client"]').exists()).toBe(false);
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(writes(calls).at(-1)!.body).toMatchObject({
      clientPolicy: { mode: 'allow', names: ['typed-client', 'seen-client'] },
    });
    await card().get('button[aria-label="Remove typed-client"]').trigger('click');
    await mode('Deny these clients').setValue(true);
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(writes(calls).at(-1)!.body).toMatchObject({ clientPolicy: { mode: 'deny', names: ['seen-client'] } });
  });

  it('shows why the seen clients could not load', async () => {
    fakeApi({ 'GET /api/session': signedIn, 'GET /api/overview': overview, 'GET /api/settings': settings });
    const { wrapper } = await mountAt('/settings/client-auth');
    await flushPromises();
    expect(wrapper.get('[data-card="clients"] [role="alert"]').text()).toBeTruthy();
  });
});

describe('My profile', () => {
  const token: Token = {
    id: 't1',
    createdBy: 'u1',
    name: 'Laptop',
    scope: ['*'],
    access: 'read',
    createdAt: '2026-01-01T00:00:00Z',
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  };
  const grant: Grant = {
    id: 'g1',
    resources: ['/nas'],
    access: 'write',
    createdAt: '2026-01-01T00:00:00Z',
    revokedAt: null,
    client: { id: 'c1', clientId: 'cid', name: 'Desk client' },
    user: { id: 'u1', username: 'admin' },
  };
  const profileApi = (extra: Record<string, unknown> = {}) =>
    fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/profile': me,
      'GET /api/profile/approval-sessions': [],
      'GET /api/me/tokens': [token],
      'GET /api/me/grants': [grant],
      'GET /api/me/endpoints': { assigned: [], unassigned: [] },
      ...extra,
    });

  it('shows an SSO account no password and no two-factor setup', async () => {
    profileApi({ 'GET /api/profile': { ...me, kind: 'sso', oidcLinked: true, hasPassword: false } });
    const { wrapper } = await mountAt('/profile');
    expect(wrapper.text()).toContain('You sign in with');
    expect(wrapper.text()).not.toContain('Change password');
    expect(wrapper.text()).not.toContain('Two-factor authentication');
  });

  it('revokes a token or a grant only after the dialog confirms it', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const { calls } = profileApi({
      'DELETE /api/me/tokens/t1': { ok: true },
      'DELETE /api/me/grants/g1': { ok: true },
    });
    await mountAt('/profile');
    const revoke = () => [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Revoke');
    revoke()[0]!.click();
    await flushPromises();
    expect(dialogTitle()).toBe('Revoke Laptop?');
    expect(dialog()?.textContent).toContain('Clients using it lose access now.');
    await click('Cancel', dialog()!);
    expect(writes(calls)).toHaveLength(0);

    revoke()[0]!.click();
    await flushPromises();
    await click('Revoke', dialog()!);
    revoke()[1]!.click();
    await flushPromises();
    expect(dialogTitle()).toBe('Revoke Desk client?');
    await click('Revoke', dialog()!);
    expect(writes(calls).map((c) => `${c.method} ${c.path}`)).toEqual([
      'DELETE /api/me/tokens/t1',
      'DELETE /api/me/grants/g1',
    ]);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
