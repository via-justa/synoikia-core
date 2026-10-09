import { describe, expect, it } from 'vitest';
import { isSdkCompatible, parseManifest, SDK_VERSION } from '../src/index.js';

const minimal = {
  id: 'example',
  name: 'Example',
  version: '1.0.0',
  sdk: '^0.2.0',
  entry: 'dist/index.js',
  binding: { namespace: 'example', functions: ['call'] },
  connection: { schema: { type: 'object' } },
};

describe('parseManifest', () => {
  it('accepts a minimal manifest and applies defaults', () => {
    const m = parseManifest(minimal);
    expect(m.capabilities).toEqual({ registry: false, targets: false, attestation: false, configTransform: false });
    expect(m.labels).toEqual({ operation: 'Operation', operations: 'Operations' });
    expect(m.binding.searchApis).toEqual([]);
    expect(m.network.hosts).toEqual([]);
    expect(m.matchProfiles).toEqual({});
  });

  it.each([
    ['uppercase id', { id: 'Example' }],
    ['non-semver version', { version: 'one' }],
    ['invalid sdk range', { sdk: 'not a range' }],
    ['absolute entry', { entry: '/etc/passwd' }],
    ['entry escaping the package', { entry: '../core/dist/main.js' }],
    ['reserved namespace', { binding: { namespace: 'catalog', functions: ['call'] } }],
    ['non-identifier function', { binding: { namespace: 'x', functions: ['do-it'] } }],
  ])('rejects %s', (_name, patch) => {
    expect(() => parseManifest({ ...minimal, ...patch })).toThrow();
  });

  it('refuses an options source shared by the connection form and a rule picker', () => {
    const withSources = (form: string, rule: string) => ({
      ...minimal,
      connection: {
        schema: { type: 'object', properties: { pool: { type: 'string' } } },
        ui: { pool: { widget: 'select', optionsSource: form } },
      },
      matchProfiles: { p: [{ field: '/app', label: 'App', op: 'in', widget: 'multiselect', optionsSource: rule }] },
    });
    expect(() => parseManifest(withSources('pools', 'pools'))).toThrow(/also feeds the connection form/);
    expect(parseManifest(withSources('pools', 'apps')).matchProfiles.p).toHaveLength(1);
  });

  it('rejects an unknown widget', () => {
    expect(() =>
      parseManifest({
        ...minimal,
        matchProfiles: { p: [{ field: '/name', label: 'Name', op: 'prefix', widget: 'free-text' }] },
      }),
    ).toThrow();
  });

  it('requires an op on param match fields', () => {
    expect(() =>
      parseManifest({ ...minimal, matchProfiles: { p: [{ field: '/name', label: 'Name', widget: 'prefix' }] } }),
    ).toThrow(/op/);
  });

  it('requires the targets capability, and a targets declaration, for $targets match fields', () => {
    const profile = { p: [{ field: '$targets', label: 'Targets', widget: 'registry-picker' }] };
    const targets = { scopes: [{ key: 'zone', label: 'Zone' }] };
    expect(() => parseManifest({ ...minimal, matchProfiles: profile })).toThrow(/capabilities.targets/);
    expect(() => parseManifest({ ...minimal, capabilities: { targets: true }, matchProfiles: profile })).toThrow(
      /requires a targets declaration/,
    );
    expect(() => parseManifest({ ...minimal, targets })).toThrow(/targets requires capabilities.targets/);
    expect(
      parseManifest({ ...minimal, capabilities: { targets: true }, targets, matchProfiles: profile }).targets,
    ).toEqual({ label: 'Target', scopes: [{ key: 'zone', label: 'Zone' }] });
  });

  it('declares target scopes by key, and $targets fields may only offer or filter by declared ones', () => {
    const withTargets = (targets: unknown, options?: unknown) =>
      parseManifest({
        ...minimal,
        capabilities: { targets: true },
        targets,
        matchProfiles: { p: [{ field: '$targets', label: 'Targets', widget: 'registry-picker', options }] },
      });
    const targets = {
      label: 'Widget',
      registryKind: 'item',
      scopes: [
        { key: 'zone', label: 'Zone', registryKind: 'zone' },
        { key: 'type', label: 'Type' },
      ],
    };
    expect(withTargets(targets, { scopes: ['zone'], filter: { type: 'widget' } }).targets).toEqual(targets);
    expect(() => withTargets(targets, { scopes: ['floor'] })).toThrow(/floor.*is not declared in targets.scopes/);
    expect(() => withTargets(targets, { filter: { floor: '1' } })).toThrow(/floor.*is not declared in targets.scopes/);
    expect(() => withTargets(targets, { kinds: ['zone'] })).toThrow();
    expect(() => withTargets({ scopes: [{ key: 'Zone', label: 'Zone' }] })).toThrow(/lowercase/);
    expect(() =>
      withTargets({
        scopes: [
          { key: 'zone', label: 'Zone' },
          { key: 'zone', label: 'Area' },
        ],
      }),
    ).toThrow(/unique/);
  });

  it('accepts covers only on $targets fields, as a list of JSON pointers', () => {
    const withCovers = (field: Record<string, unknown>) =>
      parseManifest({
        ...minimal,
        capabilities: { targets: true },
        targets: { scopes: [] },
        matchProfiles: { p: [field] },
      });
    const targets = { field: '$targets', label: 'Targets', widget: 'registry-picker' };
    expect(withCovers({ ...targets, covers: ['/selector', '/host'] }).matchProfiles.p![0]).toMatchObject({
      covers: ['/selector', '/host'],
    });
    expect(() => withCovers({ ...targets, covers: ['selector'] })).toThrow(/JSON pointer/);
    expect(() => withCovers({ ...targets, covers: '/selector' })).toThrow();
    expect(() => withCovers({ ...targets, covers: [] })).toThrow();
    expect(() => withCovers({ field: '/name', label: 'Name', op: 'eq', widget: 'text', covers: ['/x'] })).toThrow(
      /only \$targets/,
    );
  });

  it('requires matching capabilities for extra search APIs', () => {
    const binding = { namespace: 'x', functions: ['call'], searchApis: ['registry'] };
    expect(() => parseManifest({ ...minimal, binding })).toThrow(/capabilities.registry/);
    expect(() => parseManifest({ ...minimal, binding, capabilities: { registry: true } })).not.toThrow();
  });

  describe('connection ui', () => {
    const schema = {
      type: 'object',
      properties: { method: { type: 'string' }, password: { type: 'string', writeOnly: true } },
    };
    const withUi = (ui: unknown) => ({ ...minimal, connection: { schema, ui, help: 'Create a local user first.' } });

    it('accepts showWhen referencing another field', () => {
      const m = parseManifest(withUi({ password: { widget: 'secret', showWhen: { field: 'method', in: ['local'] } } }));
      expect(m.connection.ui.password?.showWhen).toEqual({ field: 'method', in: ['local'] });
      expect(m.connection.help).toBe('Create a local user first.');
    });

    it('rejects hints for unknown fields', () => {
      expect(() => parseManifest(withUi({ token: { widget: 'secret' } }))).toThrow(/no such connection field/);
    });

    it.each([
      ['an unknown field', { field: 'nope', in: ['x'] }],
      ['itself', { field: 'password', in: ['x'] }],
    ])('rejects showWhen referencing %s', (_name, showWhen) => {
      expect(() => parseManifest(withUi({ password: { showWhen } }))).toThrow(/another connection field/);
    });

    it('rejects an empty showWhen value list', () => {
      expect(() => parseManifest(withUi({ password: { showWhen: { field: 'method', in: [] } } }))).toThrow();
    });
  });
});

describe('isSdkCompatible', () => {
  it('checks the manifest range against the SDK version', () => {
    expect(isSdkCompatible({ sdk: `^${SDK_VERSION}` })).toBe(true);
    expect(isSdkCompatible({ sdk: '^2.0.0' })).toBe(false);
  });
});
