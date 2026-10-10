import { flushPromises, mount } from '@vue/test-utils';
import type { DOMWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SchemaForm from '../src/components/SchemaForm.vue';
import { fakeApi, json, mountAt, signedIn } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const instance = {
  id: 'i1',
  slug: 'nas',
  displayName: 'Acme',
  enabled: true,
  authMode: null,
  status: 'ready',
  statusError: null,
  upstreamVersion: '25.10.7',
  lastSyncedAt: null,
  lastSyncStatus: 'ok',
  settings: {},
  plugin: {
    id: 'p1',
    pluginId: 'acme',
    name: 'Acme',
    enabled: true,
    status: 'ok',
    labels: { operation: 'Method', operations: 'Methods' },
  },
};
const overview = { instances: [instance], plugins: [], warnings: [], publicMcpUrl: null };

const op = (key: string, extra: Record<string, unknown> = {}) => ({
  id: `op-${key}`,
  key,
  displayName: null,
  kind: 'method',
  tag: null,
  classification: 'read',
  classificationSource: 'inferred',
  inferredClassification: 'read',
  inferredReason: null,
  locked: false,
  attestationRequired: false,
  levelOverride: null,
  level: 'read',
  allowedLevels: ['none', 'read', 'ask'],
  description: null,
  writeAcknowledged: true,
  needsReview: false,
  matchProfile: null,
  group: 'app',
  reachable: true,
  mode: 'run',
  pendingReview: false,
  reason: null,
  ...extra,
});

const WRITE = ['none', 'ask', 'write'];

/** Clicks a button in the open dialog. */
async function clickIn(body: DOMWrapper<Element>, label: string) {
  await body
    .get('[role="dialog"]')
    .findAll('button')
    .find((b) => b.text() === label)!
    .trigger('click');
  await flushPromises();
}

describe('Access page', () => {
  function api(extra: Record<string, unknown> = {}) {
    return fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/instances/i1/groups': [
        {
          key: 'app',
          label: 'Apps',
          level: 'ask',
          stale: false,
          counts: { read: 1, write: 3, locked: 1, pendingReview: 0, overridden: 1 },
        },
        {
          key: 'store',
          label: 'Stores',
          level: 'none',
          stale: false,
          counts: { read: 1, write: 0, locked: 0, pendingReview: 0, overridden: 0 },
        },
      ],
      'GET /api/instances/i1/operations': [
        op('app.query', { description: 'Query apps.', inferredReason: 'roles:read(APPS_READ)' }),
        op('app.start', { classification: 'write', mode: 'approve', level: 'ask', allowedLevels: WRITE }),
        op('app.stop', {
          classification: 'write',
          mode: 'approve',
          level: 'ask',
          allowedLevels: WRITE,
          writeAcknowledged: false,
        }),
        op('app.redeploy', {
          classification: 'write',
          allowedLevels: WRITE,
          levelOverride: 'none',
          level: 'none',
          reachable: false,
          mode: null,
          reason: 'level_none',
        }),
        op('app.delete', {
          classification: 'write',
          locked: true,
          level: 'none',
          allowedLevels: ['none', 'ask'],
          reachable: false,
          mode: null,
          reason: 'locked_not_opted_in',
        }),
        op('store.query', { group: 'store', level: 'none', reachable: false, mode: null, reason: 'level_none' }),
      ],
      ...extra,
    });
  }

  it('offers None / Read / Ask / Write per group and sets Ask without a dialog', async () => {
    const { calls } = api({ 'PATCH /api/instances/i1/groups/store': {} });
    const { wrapper, body } = await mountAt('/endpoints/nas/access');
    const store = wrapper.get('[data-group="store"]');
    expect(store.findAll('[role="radio"]').map((b) => b.text())).toEqual(['None', 'Read', 'Ask', 'Write']);
    expect(wrapper.get('[data-group="app"]').text()).toContain('1 with their own level');
    await store
      .findAll('[role="radio"]')
      .find((b) => b.text() === 'Ask')!
      .trigger('click');
    await flushPromises();
    expect(body.find('[role="dialog"]').exists()).toBe(false);
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
      path: '/api/instances/i1/groups/store',
      body: { level: 'ask' },
    });
  });

  it('sets a group to Write with no dialog and no acknowledgement list', async () => {
    const { calls } = api({ 'PATCH /api/instances/i1/groups/app': {} });
    const { wrapper, body } = await mountAt('/endpoints/nas/access');
    await wrapper
      .get('[data-group="app"]')
      .findAll('[role="radio"]')
      .find((b) => b.text() === 'Write')!
      .trigger('click');
    await flushPromises();
    expect(body.find('[role="dialog"]').exists()).toBe(false);
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
      path: '/api/instances/i1/groups/app',
      body: { level: 'write' },
    });
  });

  it('sets every group from the dropdown after one confirm, Write included', async () => {
    const { calls } = api({ 'POST /api/instances/i1/groups/bulk-level': [] });
    const { wrapper, body } = await mountAt('/endpoints/nas/access');
    const bulk = wrapper.get('select.bulk');
    expect(bulk.findAll('option').map((o) => o.text())).toEqual(['Set all groups…', 'None', 'Read', 'Ask', 'Write']);
    await bulk.setValue('write');
    await flushPromises();
    await clickIn(body, 'Set all groups');
    expect(body.find('[role="dialog"]').exists()).toBe(false);
    expect((bulk.element as HTMLSelectElement).value).toBe('');
    expect(calls.find((c) => c.path === '/api/instances/i1/groups/bulk-level')?.body).toEqual({ level: 'write' });
  });

  it('gives operations their own level with the same toggles, only the levels their kind allows', async () => {
    const { calls } = api({
      'PATCH /api/instances/i1/operations/op-app.delete': {},
      'PATCH /api/instances/i1/operations/op-app.redeploy': {},
      'PATCH /api/instances/i1/operations/op-app.query': {},
      'PATCH /api/instances/i1/operations/op-app.start': {},
    });
    const { wrapper, body } = await mountAt('/endpoints/nas/access');
    await wrapper.get('[data-group="app"] .caret').trigger('click');
    const radios = (key: string) => wrapper.get(`[data-op="${key}"]`).findAll('[role="radio"]');
    const patched = (key: string) => calls.filter((c) => c.path === `/api/instances/i1/operations/op-${key}`);

    // No read/write dropdown: the kind tag says where it came from.
    expect(wrapper.find('[data-op="app.query"] select').exists()).toBe(false);
    expect(wrapper.get('[data-op="app.query"] .kind').attributes('title')).toBe('Requires APPS_READ');
    expect(wrapper.get('[data-op="app.query"]').text()).toContain('Query apps.');

    expect(radios('app.query').map((b) => b.text())).toEqual(['None', 'Read', 'Ask']);
    expect(radios('app.start').map((b) => b.text())).toEqual(['None', 'Ask', 'Write']);
    expect(
      radios('app.query')
        .find((b) => b.attributes('aria-checked') === 'true')
        ?.text(),
    ).toBe('Read');

    // A locked op shows Write disabled, and asks before opening at Ask.
    const locked = wrapper.get('[data-op="app.delete"]');
    expect(locked.text()).toContain('Locked — not enabled');
    const write = radios('app.delete').find((b) => b.text().startsWith('Write'))!;
    expect(write.attributes('disabled')).toBeDefined();
    await radios('app.delete')
      .find((b) => b.text() === 'Ask')!
      .trigger('click');
    await flushPromises();
    expect(body.get('[role="dialog"]').text()).toContain('fresh authenticator code');
    await clickIn(body, 'Continue');
    expect(patched('app.delete')[0]?.body).toEqual({ level: 'ask' });

    // A read at its own Ask.
    await radios('app.query')
      .find((b) => b.text() === 'Ask')!
      .trigger('click');
    await flushPromises();
    expect(patched('app.query')[0]?.body).toEqual({ level: 'ask' });

    // Picking what the group already gives (Ask) just clears an own level.
    await radios('app.redeploy')
      .find((b) => b.text() === 'Ask')!
      .trigger('click');
    await flushPromises();
    expect(patched('app.redeploy')[0]?.body).toEqual({ level: null });

    // ↺ only on operations with their own level, to the right of the toggle.
    expect(wrapper.find('[data-op="app.start"] .reset').exists()).toBe(false);
    const reset = wrapper.get('[data-op="app.redeploy"] .reset');
    expect(reset.element.previousElementSibling?.classList.contains('segmented')).toBe(true);
    await reset.trigger('click');
    await flushPromises();
    expect(patched('app.redeploy')[1]?.body).toEqual({ level: null });
    expect(wrapper.get('[data-op="app.redeploy"]').text()).not.toContain('own level');

    // Write on a plain write needs no confirmation.
    await radios('app.start')
      .find((b) => b.text() === 'Write')!
      .trigger('click');
    await flushPromises();
    expect(body.find('[role="dialog"]').exists()).toBe(false);
    expect(patched('app.start')[0]?.body).toEqual({ level: 'write' });
  });

  it('shows what each call does now', async () => {
    api();
    const { wrapper } = await mountAt('/endpoints/nas/access');
    await wrapper.get('[data-group="app"] .caret').trigger('click');
    expect(wrapper.get('[data-op="app.query"]').text()).toContain('Runs');
    expect(wrapper.get('[data-op="app.start"]').text()).toContain('Asks');
    expect(wrapper.get('[data-op="app.redeploy"]').text()).toContain('Off');
  });
});

describe('SchemaForm', () => {
  const schema = {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri', title: 'URL' },
      authMethod: { type: 'string', enum: ['api_key', 'password'], default: 'api_key' },
      apiKey: { type: 'string', writeOnly: true },
      username: { type: 'string' },
      verifyTls: { type: 'boolean', default: true },
    },
    required: ['url'],
  };
  const ui = {
    apiKey: { widget: 'secret', showWhen: { field: 'authMethod', in: ['api_key'] } },
    username: { showWhen: { field: 'authMethod', in: ['password'] } },
  };

  it('shows fields per showWhen and never renders stored secrets', async () => {
    const wrapper = mount(SchemaForm, {
      props: {
        schema,
        ui,
        config: { url: 'https://nas' },
        secrets: { apiKey: { set: true, hint: '…ab12' } },
        secretPatch: {},
      },
    });
    expect(wrapper.find('[data-field="apiKey"]').exists()).toBe(true);
    expect(wrapper.find('[data-field="username"]').exists()).toBe(false);
    expect(wrapper.get('[data-field="apiKey"]').text()).toContain('Set · …ab12');
    expect(wrapper.find('[data-field="apiKey"] input').exists()).toBe(false);

    await wrapper.setProps({ config: { url: 'https://nas', authMethod: 'password' } });
    expect(wrapper.find('[data-field="apiKey"]').exists()).toBe(false);
    expect(wrapper.find('[data-field="username"]').exists()).toBe(true);
  });

  it('turns Replace / Clear into the API merge semantics', async () => {
    const wrapper = mount(SchemaForm, {
      props: {
        schema,
        ui,
        config: {},
        secrets: { apiKey: { set: true } },
        secretPatch: {},
        'onUpdate:secretPatch': (v: Record<string, string | null>) => wrapper.setProps({ secretPatch: v }),
      },
    });
    await wrapper
      .get('[data-field="apiKey"]')
      .findAll('button')
      .find((b) => b.text() === 'Clear')!
      .trigger('click');
    expect(wrapper.props('secretPatch')).toEqual({ apiKey: null });
    await wrapper
      .get('[data-field="apiKey"]')
      .findAll('button')
      .find((b) => b.text() === 'Undo')!
      .trigger('click');
    await wrapper
      .get('[data-field="apiKey"]')
      .findAll('button')
      .find((b) => b.text() === 'Replace')!
      .trigger('click');
    await wrapper.get('[data-field="apiKey"] input').setValue('new-key');
    expect(wrapper.props('secretPatch')).toEqual({ apiKey: 'new-key' });
  });
});

describe('Endpoint settings', () => {
  it('warns before letting form-only clients approve writes, and saves the opt-in', async () => {
    const settings = {
      approvalTimeoutMs: 900_000,
      formElicitationApprovals: 'off',
      executePerMinute: 30,
      writesPerMinute: 10,
      sandbox: { timeoutMs: 10_000, memoryMb: 64, maxResultBytes: 65_536 },
      extraRedactKeys: [],
      syncMaxAgeMs: 3_600_000,
      memoryMb: 256,
    };
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': { ...overview, instances: [{ ...instance, settings }] },
      'PATCH /api/instances/i1': { ...instance, settings },
    });
    const { wrapper } = await mountAt('/endpoints/nas/settings');
    expect(wrapper.text()).not.toContain('could then approve its own writes');
    const box = wrapper
      .findAll('label')
      .find((l) => l.text().includes('only show forms'))!
      .get('input');
    await box.setValue(true);
    expect(wrapper.text()).toContain('could then approve its own writes');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({
      settings: { formElicitationApprovals: 'writes' },
    });
  });

  it('keeps the delete confirmation out of the settings form, so Enter there saves nothing', async () => {
    const settings = {
      approvalTimeoutMs: 900_000,
      formElicitationApprovals: 'off',
      executePerMinute: 30,
      writesPerMinute: 10,
      sandbox: { timeoutMs: 10_000, memoryMb: 64, maxResultBytes: 65_536 },
      extraRedactKeys: [],
      syncMaxAgeMs: 3_600_000,
      memoryMb: 256,
    };
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': { ...overview, instances: [{ ...instance, settings }] },
      'DELETE /api/instances/i1': {},
    });
    const { wrapper, body, router } = await mountAt('/endpoints/nas/settings');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Delete endpoint…')!
      .trigger('click');
    const confirm = body.get<HTMLInputElement>('[role="dialog"] input#del-confirm');
    // Enter in a field submits the form that owns it; the dialog's field has none.
    expect(confirm.element.form).toBeNull();
    expect(document.activeElement).toBe(confirm.element);
    await confirm.setValue('nas');
    await confirm.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);

    await body
      .get('[role="dialog"]')
      .findAll('button')
      .find((b) => b.text() === 'Delete')!
      .trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.method === 'DELETE')).toMatchObject({
      path: '/api/instances/i1',
      body: { confirm: 'nas' },
    });
    expect(router.currentRoute.value.path).toBe('/');
  });
});

describe('Pre-approval rules', () => {
  it('builds $targets selectors from what the plugin declares', async () => {
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/instances/i1/rules': [],
      'GET /api/instances/i1/operations': [
        op('widget.set', { classification: 'write', matchProfile: 'w', mode: 'approve' }),
      ],
      'GET /api/instances/i1/registry': (_body: unknown, url: URL) =>
        url.searchParams.get('kind') === 'zone'
          ? [{ kind: 'zone', id: 'zone_a', name: 'Zone A', parentId: null, scopes: null }]
          : [{ kind: 'item', id: 'widget.one', name: 'Widget One', parentId: null, scopes: { type: 'widget' } }],
      'GET /api/plugins': [
        {
          id: 'p1',
          manifest: {
            targets: {
              label: 'Widget',
              registryKind: 'item',
              scopes: [
                { key: 'zone', label: 'Zone', registryKind: 'zone' },
                { key: 'type', label: 'Type' },
              ],
            },
            matchProfiles: {
              w: [
                {
                  field: '$targets',
                  label: 'Targets',
                  widget: 'registry-picker',
                  options: { scopes: ['zone'], filter: { type: 'widget' } },
                },
              ],
            },
          },
        },
      ],
      'POST /api/instances/i1/rules': {},
    });
    const { wrapper, body } = await mountAt('/endpoints/nas/rules');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'New rule')!
      .trigger('click');
    await body.get('[role="dialog"] select#r-op').setValue('op-widget.set');
    await flushPromises();
    const picker = body.get('[role="dialog"] .picker');
    // Only the scopes this field offers; the target field is named as the plugin names its targets.
    expect(picker.findAll('label').map((l) => l.text())).toEqual(['Zone', 'Widget']);
    // Scope values come from their registry kind; target suggestions are narrowed by the field's filter.
    const registryCalls = calls.filter((c) => c.path.startsWith('/api/instances/i1/registry')).map((c) => c.path);
    expect(registryCalls).toContain('/api/instances/i1/registry?kind=zone&limit=500');
    expect(registryCalls.some((p) => p.includes('kind=item') && p.includes('scope.type=widget'))).toBe(true);

    const zone = picker.findAll('.field').find((f) => f.text().includes('Zone'))!;
    await zone.get('input').setValue('zone_a');
    await zone.get('input').trigger('keydown', { key: 'Enter' });
    await body.get('#r-reason').setValue('zone A widgets');
    await body
      .get('[role="dialog"]')
      .findAll('button')
      .find((b) => b.text() === 'Save rule')!
      .trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      match: [{ field: '$targets', scopes: { zone: ['zone_a'] } }],
    });
  });

  it('builds strict rules: a named field, "any value" fields and other accepted parameters', async () => {
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/instances/i1/rules': [],
      'GET /api/instances/i1/operations': [
        op('store.volume.create', { classification: 'write', matchProfile: 'ds', mode: 'approve' }),
      ],
      'GET /api/plugins': [
        {
          id: 'p1',
          manifest: {
            matchProfiles: {
              ds: [
                { field: '/name', label: 'Name', op: 'prefix', widget: 'text' },
                { field: '/compression', label: 'Compression', op: 'in', widget: 'multiselect' },
              ],
            },
          },
        },
      ],
      'POST /api/instances/i1/rules': {},
    });
    const { wrapper, body } = await mountAt('/endpoints/nas/rules');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'New rule')!
      .trigger('click');
    const dialog = body.get('[role="dialog"]');
    await dialog.get('select#r-op').setValue('op-store.volume.create');
    await flushPromises();
    // Every setting explains itself; a tap opens the tip.
    expect(dialog.findAll('.infotip').length).toBeGreaterThanOrEqual(10);
    const tip = dialog.get('.infotip');
    await tip.get('button').trigger('click');
    expect(tip.classes()).toContain('open');
    expect(tip.get('[role="tooltip"]').text()).toContain('Ask');
    await body.get('[role="dialog"] input[placeholder="vol/media/"]').setValue('vol/media');
    const compression = body
      .get('[role="dialog"]')
      .findAll('.field')
      .find((f) => f.text().includes('Compression'))!;
    await compression.get('.any input').setValue(true);
    await body.get('#r-reason').setValue('media volumes');
    await body
      .get('[role="dialog"]')
      .findAll('button')
      .find((b) => b.text() === 'Save rule')!
      .trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      match: [
        { field: '/name', op: 'prefix', value: 'vol/media' },
        { field: '/compression', op: 'any' },
      ],
    });
  });
});

describe('Connect a client', () => {
  function api(auth: string, opts: { dcr?: boolean; publicMcpUrl?: string | null } = {}) {
    const pub = opts.publicMcpUrl === undefined ? 'https://mcp.example.com' : opts.publicMcpUrl;
    const inst = { ...instance, endpointUrl: `${pub ?? ''}/nas`, effectiveAuthMode: auth };
    return fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': { ...overview, instances: [inst], publicMcpUrl: pub },
      'GET /api/instances/i1/connection': {
        config: {},
        schema: { type: 'object', properties: {} },
        secrets: {},
        help: 'Notes.',
      },
      'GET /api/settings': { mcp: { allowDynamicRegistration: opts.dcr ?? true } },
    });
  }
  const card = async () => {
    const { wrapper } = await mountAt('/endpoints/nas/connection');
    return { wrapper, card: wrapper.get('.connect') };
  };

  afterEach(() => localStorage.clear());

  it('shows the Claude Code command for an OAuth endpoint, below the setup notes', async () => {
    api('oauth');
    const { wrapper, card: c } = await card();
    const cards = wrapper.findAll('aside .card').map((x) => x.find('h2').text());
    expect(cards.slice(-2)).toEqual(['Setup notes', 'Connect a client']);
    expect(
      c
        .get('select')
        .findAll('option')
        .map((o) => o.text()),
    ).toEqual(['Claude Code', 'Claude Desktop', 'Cloudflare MCP portal']);
    expect(c.get('[data-snippet="url"]').text()).toBe('https://mcp.example.com/nas');
    expect(c.get('[data-snippet="command"]').text()).toBe(
      ['claude mcp add', '--transport http', 'nas', 'https://mcp.example.com/nas'].join(' \\\n'),
    );
    expect(c.text()).toContain('Authenticate');
  });

  it('adds the bearer header and uses the config file for Claude Desktop', async () => {
    api('bearer');
    const { card: c } = await card();
    expect(c.get('[data-snippet="command"]').text()).toContain('--header "Authorization: Bearer <token>"');
    expect(c.text()).toContain('Clients & Tokens');
    await c.get('select').setValue('claude-desktop');
    const config = JSON.parse(c.get('[data-snippet="config"]').text());
    expect(config.mcpServers.nas).toEqual({
      command: 'npx',
      args: ['-y', 'mcp-remote@latest', 'https://mcp.example.com/nas', '--header', 'Authorization:${AUTH}'],
      env: { AUTH: 'Bearer <token>' },
    });
    expect(localStorage.getItem('synoikia.connectClient')).toBe('claude-desktop');
  });

  it('warns on the Cloudflare portal when the endpoint cannot do OAuth or DCR is off', async () => {
    api('bearer', { dcr: false });
    const { card: c } = await card();
    await c.get('select').setValue('cloudflare');
    expect(c.find('[data-warn="auth"]').exists()).toBe(true);
    expect(c.find('[data-warn="dcr"]').exists()).toBe(true);
    expect(c.text()).toContain('Add MCP server');
  });

  it('points an External endpoint’s Cloudflare portal setup at Cloudflare Access, without OAuth warnings', async () => {
    api('external', { dcr: false });
    const { card: c } = await card();
    await c.get('select').setValue('cloudflare');
    expect(c.findAll('.alert')).toHaveLength(0);
    expect(c.find('[data-note="cf-access"]').text()).toContain('Managed OAuth');
    expect(c.text()).toContain('Sign in with Cloudflare Access');
  });

  it('shows a placeholder host, never the portal’s own address, when PUBLIC_MCP_URL is unset', async () => {
    api('oauth', { publicMcpUrl: null });
    const { card: c } = await card();
    expect(c.get('[data-snippet="url"]').text()).toBe('https://<your-mcp-host>/nas');
    expect(c.find('[data-warn="public-url"]').exists()).toBe(true);
    expect(c.get('[data-snippet="command"]').text()).toContain('https://<your-mcp-host>/nas');
  });

  it('shows no Cloudflare warnings when everything is in place, and copies snippets', async () => {
    api('bearer+oauth');
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { card: c } = await card();
    await c.get('select').setValue('cloudflare');
    expect(c.findAll('.alert')).toHaveLength(0);
    await c.get('.copy').trigger('click');
    expect(writeText).toHaveBeenCalledWith('https://mcp.example.com/nas');
  });
});

describe('Shell and settings', () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('shows the core version and a link to report issues above the user name', async () => {
    fakeApi({ 'GET /api/session': signedIn, 'GET /api/overview': { ...overview, version: '1.2.3' } });
    const { wrapper } = await mountAt('/');
    const about = wrapper.get('.sidebar .about');
    // Above the separator, not in the footer with the user name.
    expect(wrapper.find('.sidebar .footer .about').exists()).toBe(false);
    expect(about.text()).toContain('v1.2.3');
    const link = about.get('a.github');
    expect(link.attributes('href')).toBe('https://github.com/via-justa/synoikia-core/issues');
    expect(link.attributes('rel')).toContain('noopener');
    expect(link.attributes('title')).toBeTruthy();
  });

  it('switches between auto, light and dark on My profile and remembers the choice', async () => {
    fakeApi({ 'GET /api/session': signedIn, 'GET /api/overview': overview, 'GET /api/profile': signedIn.user });
    const { wrapper } = await mountAt('/settings/profile');
    const pick = (label: string) =>
      wrapper
        .findAll('[aria-label="Theme"] button')
        .find((b) => b.text() === label)!
        .trigger('click');
    expect(wrapper.get('[aria-label="Theme"] [aria-checked="true"]').text()).toBe('Auto');
    await pick('Dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('synoikia.theme')).toBe('dark');
    await pick('Light');
    expect(document.documentElement.dataset.theme).toBe('light');
    await pick('Auto');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem('synoikia.theme')).toBeNull();
  });

  it('names the sign-in tab Admin UI settings and explains MCP access', async () => {
    fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/settings': {
        mcp: {
          defaultAuthMode: 'oauth',
          allowDynamicRegistration: true,
          accessTokenTtlMinutes: 60,
          refreshTokenTtlDays: 30,
          cfAccess: { teamDomain: '', aud: '' },
          trustedIdentityHeader: '',
        },
        publicMcpUrl: 'https://mcp.example.com',
      },
    });
    const { wrapper } = await mountAt('/settings/mcp');
    expect(wrapper.get('.tabs').text()).toContain('Admin UI settings');
    expect(wrapper.get('.tabs').text()).not.toContain('Sign-in & security');
    const about = wrapper.get('.card.about');
    expect(about.text()).toContain('https://mcp.example.com/<slug>');
    expect(about.text()).toContain('search');
    expect(about.text()).toContain('execute');
  });

  it('explains OAuth and Cloudflare Access setup on MCP access, and warns when OAuth is off', async () => {
    const mcp = {
      defaultAuthMode: 'oauth',
      allowDynamicRegistration: true,
      accessTokenTtlMinutes: 60,
      refreshTokenTtlDays: 30,
      cfAccess: { teamDomain: '', aud: '' },
      trustedIdentityHeader: '',
    };
    fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/settings': { mcp, publicMcpUrl: null },
    });
    const { wrapper } = await mountAt('/settings/mcp');
    const headings = wrapper.findAll('section.card h2').map((h) => h.text());
    expect(headings).toContain('Cloudflare Access');
    expect(headings).toContain('Other reverse proxies');
    expect(headings).not.toContain('External mode');
    const oauthCard = wrapper.findAll('section.card').find((s) => s.get('h2').text() === 'OAuth')!;
    expect(oauthCard.text()).toContain('Applies to endpoints set to OAuth and to endpoints set to Bearer or OAuth.');
    expect(oauthCard.find('[data-explain="oauth"]').text()).toContain('no provider, client ID or secret');
    expect(oauthCard.find('[data-warn="oauth-public-url"]').exists()).toBe(true);
    const steps = wrapper.get('[data-explain="cf-access"]').text();
    expect(steps).toContain('Managed OAuth');
    expect(steps).toContain('https://claude.ai/api/mcp/auth_callback');
    expect(steps).toContain('https://<portal-hostname>/servers-callback');
    expect(steps).toContain('Optional');
  });
});

describe('Endpoint pages on the query cache', () => {
  const groups = [
    {
      key: 'app',
      label: 'Apps',
      level: 'ask',
      stale: false,
      counts: { read: 0, write: 1, locked: 1, pendingReview: 0, overridden: 0 },
    },
  ];
  const lockedOp = op('app.delete', {
    classification: 'write',
    locked: true,
    level: 'none',
    allowedLevels: ['none', 'ask'],
    reachable: false,
    mode: null,
    reason: 'locked_not_opted_in',
  });
  const accessApi = (extra: Record<string, unknown> = {}) =>
    fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/instances/i1/groups': groups,
      'GET /api/instances/i1/operations': [lockedOp],
      ...extra,
    });
  const writes = (calls: { method: string }[]) => calls.filter((c) => c.method !== 'GET');

  it('sends nothing when the bulk-level or locked-operation dialog is cancelled', async () => {
    const { calls } = accessApi();
    const { wrapper, body } = await mountAt('/endpoints/nas/access');
    await wrapper.get('select.bulk').setValue('none');
    await flushPromises();
    expect(body.get('[role="dialog"]').text()).toContain('Set every group on /nas to None?');
    expect(body.get('[role="dialog"]').text()).toContain('Operations with their own level go back');
    await clickIn(body, 'Cancel');
    expect(body.find('[role="dialog"]').exists()).toBe(false);

    await wrapper.get('[data-group="app"] .caret').trigger('click');
    await wrapper
      .get('[data-op="app.delete"]')
      .findAll('[role="radio"]')
      .find((b) => b.text() === 'Ask')!
      .trigger('click');
    await flushPromises();
    expect(body.get('[role="dialog"]').text()).toContain('app.delete is locked (destructive or irreversible).');
    await clickIn(body, 'Cancel');
    expect(writes(calls)).toEqual([]);
  });

  it('renames a group from the prompt dialog, and sends nothing on cancel or an unchanged label', async () => {
    const { calls } = accessApi({ 'PATCH /api/instances/i1/groups/app': {} });
    const { wrapper, body } = await mountAt('/endpoints/nas/access');
    const rename = () =>
      wrapper
        .get('[data-group="app"]')
        .findAll('button')
        .find((b) => b.text() === 'Rename')!
        .trigger('click');
    await rename();
    expect(body.get('[role="dialog"]').text()).toContain('Label for app');
    expect(body.get<HTMLInputElement>('[role="dialog"] input').element.value).toBe('Apps');
    await clickIn(body, 'Cancel');
    await rename();
    await clickIn(body, 'Rename');
    expect(writes(calls)).toEqual([]);

    await rename();
    await body.get('[role="dialog"] input').setValue('  Applications ');
    await clickIn(body, 'Rename');
    expect(writes(calls)).toEqual([
      { method: 'PATCH', path: '/api/instances/i1/groups/app', body: { label: 'Applications' } },
    ]);
  });

  const rule = {
    id: 'r1',
    operationId: 'op-app.start',
    match: [],
    rateLimit: null,
    windowSeconds: null,
    expiresAt: null,
    reason: 'nightly restarts',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    operation: { id: 'op-app.start', key: 'app.start', locked: false, matchProfile: null },
    inert: null,
    strictMissAt: null,
    owner: null,
  };
  const rulesApi = (extra: Record<string, unknown> = {}) =>
    fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/instances/i1/rules': [rule],
      'GET /api/instances/i1/operations': [op('app.start', { classification: 'write', mode: 'approve' })],
      'GET /api/plugins': [{ id: 'p1', manifest: {} }],
      ...extra,
    });

  it('deletes a rule only after the dialog confirms it', async () => {
    const { calls } = rulesApi({ 'DELETE /api/instances/i1/rules/r1': {} });
    const { wrapper, body } = await mountAt('/endpoints/nas/rules');
    const del = () =>
      wrapper
        .findAll('button')
        .find((b) => b.text() === 'Delete')!
        .trigger('click');
    await del();
    expect(body.get('[role="dialog"]').text()).toContain('Delete the rule for app.start?');
    await clickIn(body, 'Cancel');
    expect(writes(calls)).toEqual([]);
    await del();
    await clickIn(body, 'Delete');
    expect(writes(calls)).toEqual([{ method: 'DELETE', path: '/api/instances/i1/rules/r1', body: undefined }]);
  });

  it('keeps the rule editor draft when the rules refetch in the background', async () => {
    const { calls } = rulesApi();
    const { wrapper, body, queryClient } = await mountAt('/endpoints/nas/rules');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Edit')!
      .trigger('click');
    await body.get('#r-reason').setValue('changed reason');
    await queryClient.invalidateQueries();
    await flushPromises();
    expect(calls.filter((c) => c.path === '/api/instances/i1/rules')).toHaveLength(2);
    expect(body.get<HTMLInputElement>('#r-reason').element.value).toBe('changed reason');
  });

  it('keeps connection edits through a sync, and takes the stored values again after a save', async () => {
    let stored = 'https://nas';
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/instances/i1/connection': () => ({
        config: { url: stored },
        schema: { type: 'object', properties: { url: { type: 'string', title: 'URL' } } },
        ui: {},
        secrets: {},
      }),
      'POST /api/instances/i1/sync': () => {
        stored = 'https://changed-elsewhere';
        return { added: 0, updated: 0, staled: 0, pendingReview: [] };
      },
      'PUT /api/instances/i1/connection': (b: { config: { url: string } }) => {
        stored = `${b.config.url}/saved`;
        return {};
      },
      'GET /api/settings': { mcp: { allowDynamicRegistration: true } },
    });
    const { wrapper } = await mountAt('/endpoints/nas/connection');
    const url = () => wrapper.get<HTMLInputElement>('[data-field="url"] input');
    await url().setValue('https://edited');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Sync now')!
      .trigger('click');
    await flushPromises();
    expect(calls.filter((c) => c.path === '/api/instances/i1/connection' && c.method === 'GET')).toHaveLength(2);
    expect(wrapper.get('[role="status"]').text()).toBe('Synced: 0 new, 0 updated, 0 removed.');
    expect(url().element.value).toBe('https://edited');

    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ config: { url: 'https://edited' }, secrets: {} });
    expect(url().element.value).toBe('https://edited/saved');
    expect(wrapper.get('[role="status"]').text()).toBe('Saved. The endpoint restarted with the new connection.');
  });

  it('shows a failed connection load in the form card', async () => {
    fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/instances/i1/connection': json(500, { error: 'internal', message: 'Plugin unreachable' }),
    });
    const { wrapper } = await mountAt('/endpoints/nas/connection');
    expect(wrapper.get('form.card .alert.error').text()).toBe('Plugin unreachable');
  });

  it('fetches the overview again for a slug it does not know before saying there is none', async () => {
    let instances: unknown[] = [];
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': () => ({ ...overview, instances }),
    });
    const { wrapper, router } = await mountAt('/');
    instances = [instance];
    await router.push('/endpoints/nas/access');
    await flushPromises();
    expect(calls.filter((c) => c.path === '/api/overview')).toHaveLength(2);
    expect(wrapper.get('h1').text()).toContain('/nas');

    await router.push('/endpoints/gone/access');
    await flushPromises();
    expect(calls.filter((c) => c.path === '/api/overview')).toHaveLength(3);
    expect(wrapper.text()).toContain('No endpoint at /gone.');
  });

  it('keeps endpoint settings edits when the overview refetches', async () => {
    const settings = {
      approvalTimeoutMs: 900_000,
      formElicitationApprovals: 'off',
      executePerMinute: 30,
      writesPerMinute: 10,
      sandbox: { timeoutMs: 10_000, memoryMb: 64, maxResultBytes: 65_536 },
      extraRedactKeys: [],
      syncMaxAgeMs: 3_600_000,
      memoryMb: 256,
    };
    let displayName = 'Acme';
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': () => ({ ...overview, instances: [{ ...instance, displayName, settings }] }),
      'GET /api/instances/i1/session-grants': [],
    });
    const { wrapper, queryClient } = await mountAt('/endpoints/nas/settings');
    await wrapper.get('#s-name').setValue('Edited');
    displayName = 'Renamed elsewhere';
    await queryClient.invalidateQueries();
    await flushPromises();
    expect(calls.filter((c) => c.path === '/api/overview').length).toBeGreaterThanOrEqual(2);
    expect(wrapper.get('.page-header .sub').text()).toContain('Renamed elsewhere');
    expect(wrapper.get<HTMLInputElement>('#s-name').element.value).toBe('Edited');
  });
});
