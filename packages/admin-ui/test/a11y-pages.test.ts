import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, json, mountAt, signedIn } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

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
  endpointUrl: 'https://mcp.example.com/nas',
  settings: {},
  plugin: { id: 'p1', pluginId: 'acme', name: 'Acme', enabled: true, status: 'ok', labels: {} },
};
const overview = { instances: [instance], plugins: [], warnings: [], publicMcpUrl: null };

const press = async (target: Element, key: string) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  await flushPromises();
  return event;
};
const byRole = (role: string, root: ParentNode = document.body) => [
  ...root.querySelectorAll<HTMLElement>(`[role="${role}"]`),
];
/** The text an `aria-labelledby` or `aria-describedby` list points at; every id must exist. */
const refText = (el: Element, attr: string) =>
  el
    .getAttribute(attr)!
    .split(' ')
    .map((id) => {
      const target = document.getElementById(id);
      expect(target, `#${id} for ${attr}`).not.toBeNull();
      return target!.textContent!.trim();
    })
    .join(' ');

describe('Audit log rows', () => {
  it('open and close from a button that says whether the row is expanded', async () => {
    fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/audit': {
        rows: [
          { id: 7, at: '2026-01-01T00:00:00Z', kind: 'call', decision: 'ok', actorKind: 'user', params: { a: 1 } },
        ],
        total: 1,
      },
    });
    await mountAt('/audit');
    const table = document.querySelector('table')!;
    expect(table.getAttribute('aria-label')).toBe('Audit events');
    expect(table.getAttribute('aria-busy')).toBe('false');
    const button = table.querySelector<HTMLButtonElement>('tbody button')!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.hasAttribute('aria-controls')).toBe(false);

    button.click();
    await flushPromises();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const details = document.getElementById(button.getAttribute('aria-controls')!)!;
    expect(details.tagName).toBe('TR');
    expect(details.textContent).toContain('"params"');

    // A click anywhere on the row still toggles it, once.
    button
      .closest('tr')!
      .querySelector('td:nth-child(2)')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(details.id)).toBeNull();
  });
});

describe('Plugins tabs', () => {
  it('are a tab list with one tab stop, moved by the arrow keys, Home and End', async () => {
    fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/plugins': [],
      'GET /api/plugin-repos/available': [],
      'GET /api/plugin-repos': [],
    });
    await mountAt('/plugins');
    const list = document.querySelector('[role="tablist"]')!;
    const tabs = byRole('tab', list);
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Installed (0)', 'Available (0)', 'Repositories (0)']);
    const state = () => tabs.map((t) => [t.getAttribute('aria-selected'), t.getAttribute('tabindex')]);
    expect(state()).toEqual([
      ['true', '0'],
      ['false', '-1'],
      ['false', '-1'],
    ]);
    const panel = () => byRole('tabpanel')[0]!;
    expect(tabs[0]!.getAttribute('aria-controls')).toBe(panel().id);
    expect(refText(panel(), 'aria-labelledby')).toBe('Installed (0)');
    expect(refText(panel().querySelector('table')!, 'aria-labelledby')).toBe('Installed (0)');
    expect(panel().querySelector('th:last-child')!.textContent).toBe('Actions');

    tabs[0]!.focus();
    expect((await press(tabs[0]!, 'ArrowRight')).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(tabs[1]);
    expect(state()[1]).toEqual(['true', '0']);
    expect(refText(panel(), 'aria-labelledby')).toBe('Available (0)');

    await press(tabs[1]!, 'End');
    expect(document.activeElement).toBe(tabs[2]);
    await press(tabs[2]!, 'ArrowRight');
    expect(document.activeElement).toBe(tabs[0]);
    await press(tabs[0]!, 'ArrowLeft');
    expect(document.activeElement).toBe(tabs[2]);
    await press(tabs[2]!, 'Home');
    expect(document.activeElement).toBe(tabs[0]);
    expect(state()[0]).toEqual(['true', '0']);
    // Up and Down stay with the page.
    expect((await press(tabs[0]!, 'ArrowDown')).defaultPrevented).toBe(false);
  });
});

describe('My endpoint tabs', () => {
  it('switch between access and own rules from the keyboard', async () => {
    const role = { ...signedIn.user.role, isAdmin: false, canManageOwnRules: true, canSetOwnLevels: false };
    const user = { ...signedIn.user, role };
    fakeApi({
      'GET /api/session': { ...signedIn, user },
      'GET /api/me/endpoints': [
        {
          id: 'i1',
          slug: 'nas',
          displayName: 'Acme',
          endpointUrl: 'https://mcp.example.com/nas',
          authMode: 'oauth',
          status: { state: 'ready', enabled: true, plugin: 'Acme', upstreamVersion: null, lastSyncedAt: null },
        },
      ],
      'GET /api/me/endpoints/i1/levels': { groups: [], operations: [] },
      'GET /api/me/endpoints/i1/rules': [],
      'GET /api/me/endpoints/i1/rule-form': { matchProfiles: {}, targets: null },
    });
    await mountAt('/my/i1');
    const dot = document.querySelector('h1 .dot')!;
    expect(dot.getAttribute('role')).toBe('img');
    expect(dot.getAttribute('aria-label')).toBe('ready');

    const tabs = byRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Access', 'My pre-approval rules']);
    tabs[0]!.focus();
    await press(tabs[0]!, 'ArrowRight');
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    const panel = byRole('tabpanel')[0]!;
    expect(panel.id).toBe(tabs[1]!.getAttribute('aria-controls'));
    expect(panel.textContent).toContain('No pre-approval rules');
  });
});

describe('Radio groups', () => {
  it('My profile theme: arrows pick the next theme, with one tab stop', async () => {
    fakeApi({ 'GET /api/session': signedIn, 'GET /api/overview': overview, 'GET /api/profile': signedIn.user });
    await mountAt('/settings/profile');
    const group = document.querySelector('[role="radiogroup"][aria-label="Theme"]')!;
    expect(refText(group, 'aria-describedby')).toContain('Auto follows your system setting');
    const radios = byRole('radio', group);
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    radios[0]!.focus();
    await press(radios[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(radios[1]);
    expect(radios[1]!.getAttribute('aria-checked')).toBe('true');
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    expect(document.documentElement.dataset.theme).toBe('light');
    await press(radios[1]!, 'ArrowUp');
    expect(document.activeElement).toBe(radios[0]);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('access levels: arrows move focus only and pick nothing', async () => {
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/instances/i1/groups': [
        {
          key: 'app',
          label: 'Apps',
          level: 'ask',
          stale: false,
          counts: { read: 0, write: 0, locked: 0, pendingReview: 0, overridden: 0 },
        },
      ],
      'GET /api/instances/i1/operations': [],
    });
    await mountAt('/endpoints/nas/access');
    const group = document.querySelector('[role="radiogroup"][aria-label="Access for Apps"]')!;
    const radios = byRole('radio', group);
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '-1', '0', '-1']);
    radios[2]!.focus();
    await press(radios[2]!, 'ArrowRight');
    expect(document.activeElement).toBe(radios[3]);
    await press(radios[3]!, 'ArrowRight');
    expect(document.activeElement).toBe(radios[0]);
    expect(radios[2]!.getAttribute('aria-checked')).toBe('true');
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('Tables', () => {
  const token = {
    id: 't1',
    createdBy: 'u1',
    name: 'laptop',
    scope: ['*'],
    access: 'read',
    createdAt: '2026-01-01T00:00:00Z',
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  };
  const clientsApi = (extra: Record<string, unknown> = {}) =>
    fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/tokens': [token],
      'GET /api/oauth/clients': [],
      'GET /api/oauth/grants': [],
      'GET /api/users': [signedIn.user],
      ...extra,
    });

  it('are named by their heading, name the action column and tie row buttons to their row', async () => {
    clientsApi();
    await mountAt('/clients');
    const tables = [...document.querySelectorAll('table')];
    expect(tables.map((t) => refText(t, 'aria-labelledby'))).toEqual([
      'Bearer tokens',
      'OAuth clients',
      'OAuth grants',
    ]);
    expect(tables.map((t) => t.querySelector('th:last-child')!.textContent)).toEqual(['Actions', 'Actions', 'Actions']);
    const revoke = [...tables[0]!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Revoke')!;
    expect(refText(revoke, 'aria-describedby')).toBe('laptop');
  });

  it('say they are busy while loading, with a spoken Loading where nothing shows', async () => {
    const { fetchMock } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/roles': [],
      'GET /api/users': [signedIn.user],
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const real = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.startsWith('/api/users')) await held;
      return real(input, init);
    });
    await mountAt('/settings/users');
    const table = document.querySelector('table[aria-label="Users"]')!;
    expect(table.getAttribute('aria-busy')).toBe('true');
    expect(document.querySelector('.table-card [role="status"]')!.textContent).toBe('Loading…');

    release();
    await flushPromises();
    expect(table.getAttribute('aria-busy')).toBe('false');
    expect(document.querySelector('.table-card [role="status"]')).toBeNull();
    const reset = [...table.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Set password')!;
    expect(refText(reset, 'aria-describedby')).toContain('admin');
  });
});

describe('Alerts and notices', () => {
  it('announce a failed dialog action as an alert', async () => {
    fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/tokens': [],
      'GET /api/oauth/clients': [],
      'GET /api/oauth/grants': [],
      'GET /api/users': [signedIn.user],
      'POST /api/tokens': json(400, { error: 'invalid', message: 'Name taken' }),
    });
    await mountAt('/clients');
    [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'New token')!.click();
    await flushPromises();
    const dialog = document.querySelector('[role="dialog"]')!;
    const group = dialog.querySelector('[role="group"]')!;
    expect(refText(group, 'aria-labelledby')).toBe('Endpoints');
    expect(refText(dialog.querySelector('#t-exp')!, 'aria-describedby')).toBe('Leave empty for no expiry.');
    (dialog.querySelector('#t-name') as HTMLInputElement).value = 'desk';
    dialog.querySelector('#t-name')!.dispatchEvent(new Event('input'));
    (dialog.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    await flushPromises();
    [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Create token')!.click();
    await flushPromises();
    expect(dialog.querySelector('[role="alert"]')!.textContent).toBe('Name taken');
  });

  it('give a saved notice the status role and a failed save the alert role', async () => {
    let fail = false;
    fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/settings': {
        security: {},
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
      },
      'PUT /api/settings/mcp': (b: unknown) => (fail ? json(400, { error: 'invalid', message: 'Bad value' }) : b),
    });
    await mountAt('/settings/mcp');
    const form = document.querySelector('form')!;
    form.requestSubmit();
    await flushPromises();
    expect(form.querySelector('[role="status"]')!.textContent).toBe('Saved.');
    fail = true;
    form.requestSubmit();
    await flushPromises();
    expect(form.querySelector('[role="alert"]')!.textContent).toBe('Bad value');
  });
});
