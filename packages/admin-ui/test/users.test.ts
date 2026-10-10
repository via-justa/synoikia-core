import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicUser, RoleRow } from '../src/types';
import { adminRole, fakeApi, json, mountAt, signedIn } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const operators = { ...adminRole, id: 'r1', name: 'Operators', isAdmin: false };
const roles: RoleRow[] = [
  { ...adminRole, users: 1, instanceIds: [], isDefault: false },
  { ...operators, users: 1, instanceIds: ['i1'], isDefault: true },
];
const me: PublicUser = { ...signedIn.user, createdAt: '2026-01-01T00:00:00Z', lastLoginAt: null };
const olga: PublicUser = { ...me, id: 'u2', username: 'olga', totpEnabled: true, role: operators };

const button = (text: string, root: ParentNode = document.body) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const dialogTitle = () => document.getElementById(dialog()?.getAttribute('aria-labelledby') ?? '')?.textContent;
const gets = (calls: { method: string; path: string }[], path: string) =>
  calls.filter((c) => c.method === 'GET' && c.path === path).length;

describe('the Users page', () => {
  it('lists users and changes a role, then reloads users and roles', async () => {
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/users': [me, olga],
      'GET /api/roles': roles,
      'PATCH /api/users/u2': { ...olga, role: adminRole },
    });
    const { wrapper } = await mountAt('/settings/users');
    expect(wrapper.text()).toContain('olga');
    expect(wrapper.text()).toContain('you');
    const select = wrapper.get('select[aria-label="Role of olga"]');
    expect((select.element as HTMLSelectElement).value).toBe('r1');

    await select.setValue('admin');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: '/api/users/u2', body: { roleId: 'admin' } });
    expect(gets(calls, '/api/users')).toBe(2);
    expect(gets(calls, '/api/roles')).toBe(2);
  });

  it('shows why the list did not load', async () => {
    fakeApi({
      'GET /api/session': signedIn,
      'GET /api/users': json(500, { error: 'internal', message: 'Database is locked' }),
      'GET /api/roles': roles,
    });
    const { wrapper } = await mountAt('/settings/users');
    expect(wrapper.get('[role="alert"]').text()).toBe('Database is locked');
    expect(wrapper.findAll('tbody tr')).toHaveLength(0);
  });

  it('asks in a dialog before disabling a user, and sends nothing on cancel', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/users': [me, olga],
      'GET /api/roles': roles,
      'PATCH /api/users/u2': { ...olga, disabled: true },
    });
    await mountAt('/settings/users');

    const disable = button('Disable')!;
    disable.focus();
    disable.click();
    await flushPromises();
    expect(dialogTitle()).toBe('Disable olga?');
    expect(dialog()?.textContent).toContain('Their sessions end now.');
    button('Cancel', dialog()!)!.click();
    await flushPromises();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(disable);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);

    button('Disable')!.click();
    await flushPromises();
    button('Disable', dialog()!)!.click();
    await flushPromises();
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: '/api/users/u2', body: { disabled: true } });
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('resets two-factor after confirmation and shows a failure on the page', async () => {
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/users': [me, olga],
      'GET /api/roles': roles,
      'POST /api/users/u2/reset-totp': json(409, { error: 'conflict', message: 'Two-factor is required' }),
    });
    const { wrapper } = await mountAt('/settings/users');
    button('Reset 2FA')!.click();
    await flushPromises();
    expect(dialogTitle()).toBe('Reset two-factor for olga?');
    button('Reset 2FA', dialog()!)!.click();
    await flushPromises();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/users/u2/reset-totp')).toBe(true);
    expect(wrapper.get('[role="alert"]').text()).toBe('Two-factor is required');
  });

  it('adds a user, then closes the dialog and reloads the list', async () => {
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/users': [me],
      'GET /api/roles': roles,
      'POST /api/users': (body: unknown) => json(201, { ...olga, ...(body as object) }),
    });
    const { body } = await mountAt('/settings/users');
    button('Add user')!.click();
    await flushPromises();
    await body.get('input#u-name').setValue('  olga ');
    await body.get('select#u-role').setValue('r1');
    button('Add')!.click();
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ username: 'olga', roleId: 'r1' });
    expect(dialog()).toBeNull();
    expect(gets(calls, '/api/users')).toBe(2);
  });

  it('keeps the add dialog open with core’s validation message', async () => {
    fakeApi({
      'GET /api/session': signedIn,
      'GET /api/users': [me],
      'GET /api/roles': roles,
      'POST /api/users': json(400, {
        error: 'invalid_request',
        message: 'Invalid user',
        details: ['password must be at least 12 characters'],
      }),
    });
    const { body } = await mountAt('/settings/users');
    button('Add user')!.click();
    await flushPromises();
    await body.get('input#u-name').setValue('olga');
    await body.get('input#u-pass').setValue('short');
    button('Add')!.click();
    await flushPromises();
    expect(dialog()?.querySelector('.alert.error')?.textContent).toBe(
      'Invalid user: password must be at least 12 characters',
    );

    // Opening the dialog again starts clean.
    button('Cancel', dialog()!)!.click();
    await flushPromises();
    button('Add user')!.click();
    await flushPromises();
    expect(dialog()?.querySelector('.alert.error')).toBeNull();
  });

  it('sets a password from the dialog', async () => {
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/users': [olga],
      'GET /api/roles': roles,
      'PATCH /api/users/u2': olga,
    });
    const { body } = await mountAt('/settings/users');
    button('Set password')!.click();
    await flushPromises();
    const submit = () => button('Set password', dialog()!)!;
    expect(submit().disabled).toBe(true);
    await body.get('input#r-pass').setValue('correct horse battery');
    submit().click();
    await flushPromises();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ password: 'correct horse battery' });
    expect(dialog()).toBeNull();
  });
});
