import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Grant, Notifier, PublicUser, RoleRow, Settings, Token } from '../src/types';
import { adminRole, fakeApi, json, mountAt, signedIn } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const operators = { ...adminRole, id: 'r1', name: 'Operators', isAdmin: false };
const roles: RoleRow[] = [
  { ...adminRole, users: 1, instanceIds: [], isDefault: false },
  { ...operators, users: 0, instanceIds: [], isDefault: false },
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
  mcp: {
    defaultAuthMode: 'oauth',
    allowDynamicRegistration: true,
    cfAccess: { teamDomain: '', aud: '' },
    trustedIdentityHeader: '',
    accessTokenTtlMinutes: 60,
    refreshTokenTtlDays: 30,
  },
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

describe('the Roles page', () => {
  const api = () =>
    fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/roles': roles,
      'PATCH /api/roles/r1': { ok: true },
      'DELETE /api/roles/r1': { ok: true },
    });

  it('deletes a role only after the dialog confirms it', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const { calls } = api();
    await mountAt('/settings/roles');
    await click('Delete');
    expect(dialogTitle()).toBe('Delete the role Operators?');
    await click('Cancel', dialog()!);
    expect(dialog()).toBeNull();
    expect(writes(calls)).toHaveLength(0);

    await click('Delete');
    await click('Delete', dialog()!);
    expect(writes(calls)).toEqual([{ method: 'DELETE', path: '/api/roles/r1', body: undefined }]);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('renames a role from the dialog, and sends nothing on cancel or an unchanged name', async () => {
    const promptSpy = vi.spyOn(window, 'prompt');
    const { calls } = api();
    const { body } = await mountAt('/settings/roles');
    await click('Rename');
    expect(dialogTitle()).toBe('Rename Operators');
    expect(body.get<HTMLInputElement>('[role="dialog"] input').element.value).toBe('Operators');
    await click('Cancel', dialog()!);
    await click('Rename');
    await click('Rename', dialog()!);
    expect(writes(calls)).toHaveLength(0);

    await click('Rename');
    await body.get('[role="dialog"] input').setValue('  Ops ');
    await click('Rename', dialog()!);
    expect(writes(calls)).toEqual([{ method: 'PATCH', path: '/api/roles/r1', body: { name: 'Ops' } }]);
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('shows why an action failed', async () => {
    fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/roles': roles,
      'POST /api/roles': json(409, { error: 'conflict', message: 'A role with that name exists' }),
    });
    const { wrapper } = await mountAt('/settings/roles');
    await wrapper.get('input[aria-label="New role name"]').setValue('Operators');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('A role with that name exists');
  });
});

describe('Admin UI settings', () => {
  it('asks for ADMIN before opening self-registration to administrators', async () => {
    const promptSpy = vi.spyOn(window, 'prompt');
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/settings': settings,
      'GET /api/roles': roles,
      'PUT /api/settings/security': (b: unknown) => b,
    });
    const { wrapper, body } = await mountAt('/settings/security');
    await wrapper.get('select#s-role').setValue('admin');
    const registration = wrapper.findAll('form').find((f) => f.text().includes('Self-registration'))!;
    await registration.trigger('submit');
    await flushPromises();
    expect(dialogTitle()).toBe('New accounts will be administrators.');
    expect(dialog()?.textContent).toContain('Type ADMIN to confirm.');
    await body.get('[role="dialog"] input').setValue('admin');
    await click('Save', dialog()!);
    await registration.trigger('submit');
    await flushPromises();
    await click('Cancel', dialog()!);
    expect(writes(calls)).toHaveLength(0);

    await registration.trigger('submit');
    await flushPromises();
    await body.get('[role="dialog"] input').setValue('ADMIN');
    await click('Save', dialog()!);
    expect(writes(calls)).toEqual([
      { method: 'PUT', path: '/api/settings/security', body: { ...settings.security, defaultRoleId: 'admin' } },
    ]);
    expect(registration.text()).toContain('Saved.');
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('keeps the other sections’ drafts when one section saves', async () => {
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/settings': settings,
      'GET /api/roles': roles,
      'PUT /api/settings/audit': { retentionDays: 30 },
    });
    const { wrapper } = await mountAt('/settings/security');
    await wrapper.get('input#s-idle').setValue('90');
    await wrapper.get('input#a-ret').setValue('30');
    const auditForm = wrapper.findAll('form').find((f) => f.text().includes('Audit log retention'))!;
    await auditForm.trigger('submit');
    await flushPromises();
    expect(writes(calls)).toEqual([{ method: 'PUT', path: '/api/settings/audit', body: { retentionDays: 30 } }]);
    expect(auditForm.text()).toContain('Saved.');
    expect(wrapper.get<HTMLInputElement>('input#s-idle').element.value).toBe('90');
  });
});

describe('the MCP access settings', () => {
  it('saves and shows core’s answer, or why it failed', async () => {
    let fail = true;
    fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/settings': settings,
      'PUT /api/settings/mcp': (b: unknown) =>
        fail ? json(400, { error: 'invalid', message: 'Bad lifetime' }) : { ...(b as object), refreshTokenTtlDays: 7 },
    });
    const { wrapper } = await mountAt('/settings/mcp');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('.alert.error').text()).toBe('Bad lifetime');
    fail = false;
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('.alert.ok').text()).toBe('Saved.');
    expect(wrapper.get<HTMLInputElement>('input#m-rt').element.value).toBe('7');
  });
});

describe('the Notifications page', () => {
  const channel: Notifier = {
    id: 'n1',
    kind: 'ntfy',
    name: 'Phone',
    config: { server: 'https://ntfy.example', topic: 't' },
    secrets: {},
    events: ['instance.error'],
    instanceFilter: null,
    enabled: true,
    lastSentAt: null,
    lastError: null,
  };

  it('deletes a channel only after the dialog confirms it', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/notifiers': [channel],
      'DELETE /api/notifiers/n1': { ok: true },
    });
    await mountAt('/settings/notifications');
    await click('Delete');
    expect(dialogTitle()).toBe('Delete Phone?');
    await click('Cancel', dialog()!);
    expect(writes(calls)).toHaveLength(0);

    await click('Delete');
    await click('Delete', dialog()!);
    expect(writes(calls)).toEqual([{ method: 'DELETE', path: '/api/notifiers/n1', body: undefined }]);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('reports a failed test send', async () => {
    fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/notifiers': [channel],
      'POST /api/notifiers/n1/test': { ok: false, error: 'timeout' },
    });
    const { wrapper } = await mountAt('/settings/notifications');
    await click('Test');
    expect(wrapper.get('[role="alert"]').text()).toBe('Test to Phone failed: timeout');
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
      'GET /api/me/endpoints': [],
      ...extra,
    });

  it('revokes a token or a grant only after the dialog confirms it', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const { calls } = profileApi({
      'DELETE /api/me/tokens/t1': { ok: true },
      'DELETE /api/me/grants/g1': { ok: true },
    });
    await mountAt('/settings/profile');
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

  it('keeps the recovery codes on screen after enrollment until the user saved them', async () => {
    let enrolled = false;
    profileApi({
      'GET /api/profile': () => ({ ...me, totpEnabled: enrolled }),
      'POST /api/profile/totp/begin': { secret: 'ABC', uri: 'otpauth://totp/x' },
      'POST /api/profile/totp/confirm': () => {
        enrolled = true;
        return { recoveryCodes: ['r-1', 'r-2'] };
      },
    });
    const { wrapper } = await mountAt('/settings/profile');
    await click('Set up two-factor authentication');
    await wrapper.get('input[aria-label="Code"]').setValue('123456');
    await wrapper.get<HTMLInputElement>('input[aria-label="Code"]').element.form!.requestSubmit();
    await flushPromises();
    expect(wrapper.get('pre.recovery').text()).toContain('r-1');
    await click('I saved them');
    expect(wrapper.text()).toContain('Enter a current code (or a recovery code) to turn it off.');
  });

  it('shows a mismatch before sending a new password, and core’s answer after', async () => {
    const { calls } = profileApi({
      'POST /api/profile/password': json(400, { error: 'weak', message: 'Password too common' }),
    });
    const { wrapper } = await mountAt('/settings/profile');
    await wrapper.get('input#p-new').setValue('correct horse battery');
    await wrapper.get('input#p-conf').setValue('different horse battery');
    const form = wrapper.findAll('form').find((f) => f.text().includes('Change password'))!;
    await form.trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('The new passwords do not match.');
    expect(writes(calls)).toHaveLength(0);
    await wrapper.get('input#p-conf').setValue('correct horse battery');
    await form.trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('Password too common');
  });
});
