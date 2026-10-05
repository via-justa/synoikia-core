import { describe, expect, it } from 'vitest';
import {
  checkManifest,
  compileRules,
  parsePluginSettings,
  pluginSettingsJsonSchema,
  maskSensitiveResult,
  OperationDescriptorSchema,
  readPointer,
} from '../src/index.js';
import type { OperationDraft } from '../src/index.js';

const draft = (key: string, extra: Partial<OperationDraft> = {}): OperationDraft => ({
  key,
  kind: 'method',
  group: 'g',
  ...extra,
});

const settings = parsePluginSettings({
  defaults: { confirm: 'instance' },
  instanceName: { op: 'system.info', field: 'hostname', fallback: 'host of {key}' },
  exclude: ['auth.*', 'core.*'],
  include: ['core.ping'],
  rules: [
    { match: ['pool.delete', 'api.*'], locked: true },
    { match: 'pool.delete', confirm: { param: '/0' } },
    {
      match: 'user.delete',
      locked: true,
      reason: 'locked:users',
      confirm: [{ lookup: { op: 'user.get', args: [{ $param: '/0' }], field: ['/name/full', 'username'] } }],
    },
    {
      match: 'item.delete',
      locked: true,
      confirm: { lookup: { op: 'items', field: 'title', find: { field: 'id', equals: { $param: '/path/id' } } } },
    },
    { match: 'fs.setacl', split: 'pool-root', sensitiveParams: ['/0/key'], guidance: 'Use a path.' },
    {
      match: '*#pool-root',
      description: '{base} at a pool root: locked.',
      summaryNote: 'at the root of a pool',
      confirm: { param: '/0/path' },
    },
    { match: 'stats.get', classification: 'read', reason: 'reviewed:read', needsReview: false },
    { match: 'api.read', classification: 'read' },
    { match: 'token.make', sensitiveResult: 'whole' },
    { match: 'key.*', sensitiveResult: { keys: ['key'] } },
    { match: 'cloud.*', sensitiveResult: { keys: ['key', 'secret'], deep: true } },
    { match: 'pool.create', matchProfile: 'pool-prefix', attestation: true },
    { match: 'scene.apply', locked: true, confirm: { custom: 'scene' } },
    { match: 'targets.op', locked: true, confirm: ['targets', { param: '/id' }] },
  ],
  plugin: { verbs: ['get'] },
});

const lookups: [string, unknown[]][] = [];
const rules = compileRules(settings, {
  lookup: async (op, args) => {
    lookups.push([op, args]);
    if (op === 'system.info') return { hostname: 'nas' };
    if (op === 'user.get')
      return args[0] === 7 ? { name: { full: 'Ann Smith' } } : args[0] === 8 ? {} : Promise.reject(new Error('x'));
    if (op === 'items')
      return [
        { id: 1, title: 'One' },
        { id: '2', name: 'Two' },
      ];
    return undefined;
  },
  custom: { scene: ({ params }) => Object.keys((params as { entities: object }).entities).join(', ') },
});

describe('plugin.yaml schema', () => {
  it('applies defaults', () => {
    const s = parsePluginSettings({});
    expect(s).toMatchObject({ exclude: [], include: [], rules: [], operations: [], plugin: {} });
    expect(s.defaults.timeouts).toEqual({ request: 15_000, lookup: 10_000 });
  });

  it('rejects unknown keys, bad pointers and bad suffixes', () => {
    expect(() => parsePluginSettings({ rule: [] })).toThrow();
    expect(() => parsePluginSettings({ rules: [{ match: 'a', lockd: true }] })).toThrow();
    expect(() => parsePluginSettings({ rules: [{ match: 'a', sensitiveParams: ['0/x'] }] })).toThrow();
    expect(() => parsePluginSettings({ rules: [{ match: 'a', split: 'Bad Suffix' }] })).toThrow();
    expect(() => parsePluginSettings({ rules: [{ match: 'a', classification: 'admin' }] })).toThrow();
  });

  it('validates the plugin section with the plugin schema', () => {
    const parsed = parsePluginSettings({ plugin: { n: 1 } }, { parse: (v) => ({ n: (v as { n: number }).n * 2 }) });
    expect(parsed.plugin.n).toBe(2);
  });

  it('has a JSON schema for editors', () => {
    expect(pluginSettingsJsonSchema()).toMatchObject({ type: 'object', properties: { rules: { type: 'array' } } });
  });
});

describe('compiled rules', () => {
  it('excludes, with include re-allowing', () => {
    expect(['auth.login', 'core.debug', 'core.ping', 'pool.query'].map((k) => rules.excluded(k))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it('locks and fails closed', () => {
    expect(
      rules.decorate(draft('pool.delete', { classification: 'read', classificationReason: 'naming' })),
    ).toMatchObject({
      classification: 'write',
      classificationReason: 'locked:destructive',
      locked: true,
      typedConfirmation: true,
    });
    // A classification override never unlocks.
    expect(rules.decorate(draft('api.read'))).toMatchObject({ locked: true, classification: 'write' });
    expect(rules.decorate(draft('user.delete'))).toMatchObject({ classificationReason: 'locked:users' });
    expect(rules.decorate(draft('unknown.op'))).toMatchObject({
      classification: 'write',
      classificationReason: 'default:ambiguous',
      locked: false,
      typedConfirmation: false,
    });
    expect(
      rules.decorate(draft('pool.query', { classification: 'read', classificationReason: 'naming:read' })),
    ).toMatchObject({
      classification: 'read',
      classificationReason: 'naming:read',
    });
  });

  it('overrides a heuristic with a reviewed classification', () => {
    expect(
      rules.decorate(
        draft('stats.get', { classification: 'write', classificationReason: 'heuristic', needsReview: true }),
      ),
    ).toMatchObject({ classification: 'read', classificationReason: 'reviewed:read', needsReview: false });
  });

  it('adds locked split twins that inherit data-protection fields', () => {
    const [base, twin] = rules.describe(
      draft('fs.setacl', { classification: 'write', docs: { summary: 'Set an ACL' } }),
    );
    expect(base).toMatchObject({
      key: 'fs.setacl',
      locked: false,
      sensitiveParams: ['/0/key'],
      docs: { guidance: 'Use a path.' },
    });
    expect(base!.docs).not.toHaveProperty('description');
    expect(twin).toMatchObject({
      key: 'fs.setacl#pool-root',
      locked: true,
      classification: 'write',
      sensitiveParams: ['/0/key'],
      docs: { summary: 'Set an ACL', description: 'fs.setacl at a pool root: locked.', guidance: 'Use a path.' },
    });
    expect(rules.isLocked('anything#x')).toBe(true);
    expect(rules.splits('fs.setacl')).toEqual(['pool-root']);
    expect(rules.summaryNotes('fs.setacl#pool-root')).toEqual(['at the root of a pool']);
  });

  it('sets match profiles, attestation and merges sensitive params', () => {
    expect(rules.decorate(draft('pool.create', { sensitiveParams: ['/1'] }))).toMatchObject({
      matchProfile: 'pool-prefix',
      attestationRequired: true,
      sensitiveParams: ['/1'],
    });
    expect(rules.decorate(draft('plain.op', { classification: 'read' }))).not.toHaveProperty('attestationRequired');
  });

  describe('confirm literals', () => {
    const literal = (key: string, params: unknown, targets = [] as { kind: string; id: string; name: string }[]) =>
      rules.confirmLiteral({ key, params, targets });

    it('only for locked operations', async () => {
      expect(await literal('pool.query', ['x'])).toBeUndefined();
    });

    it('reads params', async () => {
      expect(await literal('pool.delete', ['tank'])).toBe('tank');
      expect(await literal('pool.delete', [5])).toBe('5');
      expect(await literal('fs.setacl#pool-root', [{ path: '/mnt/tank' }])).toBe('/mnt/tank');
      expect(await literal('fs.setacl#pool-root', [{}])).toBeUndefined();
    });

    it('looks names up, falling back to the id', async () => {
      expect(await literal('user.delete', [7])).toBe('Ann Smith');
      expect(await literal('user.delete', [8])).toBe('8');
      expect(await literal('user.delete', [9])).toBe('9');
      expect(await literal('user.delete', [])).toBeUndefined();
      expect(await literal('item.delete', { path: { id: '1' } })).toBe('One');
      expect(await literal('item.delete', { path: { id: '2' } })).toBe('2');
      expect(lookups).toContainEqual(['user.get', [7]]);
    });

    it('uses the instance name by default', async () => {
      expect(await literal('api.keys', [])).toBe('nas');
      const noHost = compileRules(settings, { lookup: async () => ({}) });
      expect(await noHost.confirmLiteral({ key: 'api.keys', params: [], targets: [] })).toBe('host of api.keys');
    });

    it('uses targets, custom sources and fallbacks in order', async () => {
      expect(
        await literal('targets.op', { id: 'x' }, [
          { kind: 'e', id: 'lock.a', name: 'Front door' },
          { kind: 'e', id: 'lock.b', name: '' },
        ]),
      ).toBe('Front door, lock.b');
      expect(await literal('targets.op', { id: 'x' })).toBe('x');
      expect(await literal('scene.apply', { entities: { 'lock.a': 'unlocked' } })).toBe('lock.a');
    });
  });

  it('declares sensitiveResult on descriptors for core to mask', () => {
    expect(rules.decorate(draft('token.make')).sensitiveResult).toBe('whole');
    expect(rules.decorate(draft('key.create')).sensitiveResult).toEqual({ keys: ['key'], deep: false });
    expect(rules.decorate(draft('cloud.query')).sensitiveResult).toEqual({ keys: ['key', 'secret'], deep: true });
    expect(rules.decorate(draft('other'))).not.toHaveProperty('sensitiveResult');
    // A split twin returns what its base returns, so it carries the base's rule.
    const twins = compileRules(
      parsePluginSettings({ rules: [{ match: 'token.make', split: 'admin', sensitiveResult: 'whole' }] }),
    );
    expect(twins.describe(draft('token.make')).map((d) => [d.key, d.sensitiveResult])).toEqual([
      ['token.make', 'whole'],
      ['token.make#admin', 'whole'],
    ]);
    expect(() => OperationDescriptorSchema.parse(rules.decorate(draft('cloud.query')))).not.toThrow();
  });

  it('masks results embedded in another operation the way their own operation declares', () => {
    expect(rules.maskEmbeddedResult('token.make', 'abc')).toBe('[REDACTED]');
    expect(rules.maskEmbeddedResult('key.create', [{ id: 1, key: 'k' }, { id: 2 }])).toEqual([
      { id: 1, key: '[REDACTED]' },
      { id: 2 },
    ]);
    expect(rules.maskEmbeddedResult('cloud.query', { a: { b: { secret: 's' } } })).toEqual({
      a: { b: { secret: '[REDACTED]' } },
    });
    expect(rules.maskEmbeddedResult('other', { key: 'k' })).toEqual({ key: 'k' });
    expect(maskSensitiveResult({ key: 1234 }, { keys: ['key'] })).toEqual({ key: '[REDACTED]' });
  });

  it('refuses more sensitiveParams than core takes', () => {
    const many = compileRules(
      parsePluginSettings({
        rules: [
          { match: 'x', sensitiveParams: Array.from({ length: 20 }, (_, i) => `/a/${i}`) },
          { match: 'x', sensitiveParams: Array.from({ length: 20 }, (_, i) => `/b/${i}`) },
        ],
      }),
    );
    expect(() => many.decorate(draft('x'))).toThrow(/limit is 32/);
  });

  it('looks up only plain ids and matches only rows that have the field', async () => {
    const seen: unknown[][] = [];
    const r = compileRules(
      parsePluginSettings({
        rules: [
          {
            match: 'a',
            locked: true,
            confirm: { lookup: { op: 'get', args: [{ $param: '/id' }], field: 'name' } },
          },
          {
            match: 'b',
            locked: true,
            confirm: { lookup: { op: 'list', find: { field: 'id', equals: { $param: '/id' } }, field: 'name' } },
          },
        ],
      }),
      {
        lookup: async (op, args) => {
          seen.push(args);
          return op === 'list' ? [{ name: 'no id' }, { id: 2, name: 'Two' }] : { name: 'Named' };
        },
      },
    );
    expect(await r.confirmLiteral({ key: 'a', params: { id: { evil: true } }, targets: [] })).toBeUndefined();
    expect(seen).toEqual([]);
    expect(await r.confirmLiteral({ key: 'b', params: { id: 'undefined' }, targets: [] })).toBe('undefined');
    expect(await r.confirmLiteral({ key: 'b', params: { id: 2 }, targets: [] })).toBe('Two');
  });
});

describe('readPointer', () => {
  it('reads pointers and names', () => {
    const v = { a: [{ 'b/c': 1 }], n: 'x' };
    expect(readPointer(v, '/a/0/b~1c')).toBe(1);
    expect(readPointer(v, 'n')).toBe('x');
    expect(readPointer(v, '/a/x')).toBeUndefined();
    expect(readPointer(v, '/constructor')).toBeUndefined();
  });
});

describe('checkManifest', () => {
  const manifest = (props: Record<string, unknown>, ui: Record<string, unknown>, sensitiveKeys: string[] = []) => ({
    id: 'acme',
    name: 'Acme',
    version: '1.0.0',
    sdk: '^0.2.0',
    entry: 'dist/index.js',
    binding: { namespace: 'acme', functions: ['call'] },
    connection: { schema: { type: 'object', properties: props }, ui },
    sensitiveKeys,
    network: { hosts: ['{{connection.baseUrl}}'] },
    matchProfiles: { known: [{ field: '/name', label: 'Name', op: 'prefix', widget: 'prefix' }] },
  });

  it('accepts a well-formed manifest', () => {
    expect(
      checkManifest(
        manifest({ token: { type: 'string', writeOnly: true } }, { token: { widget: 'secret' } }, ['token']),
      ),
    ).toEqual([]);
  });

  it('requires a contract where core masks sensitiveResult', () => {
    const yaml = parsePluginSettings({ rules: [{ match: 'token.make', sensitiveResult: 'whole' }] });
    const old = checkManifest(manifest({}, {}), yaml);
    expect(old).toHaveLength(1);
    expect(old[0]).toMatch(/rules\[0\]: sensitiveResult .* require \^0\.2\.2/);
    expect(checkManifest({ ...manifest({}, {}), sdk: '^0.2.2' }, yaml)).toEqual([]);
    expect(checkManifest({ ...manifest({}, {}), sdk: '>=0.2.0' }, yaml)).toHaveLength(1);
    // Without the rule, the older range is fine.
    expect(checkManifest(manifest({}, {}), parsePluginSettings({}))).toEqual([]);
  });

  it('finds secret-field mistakes', () => {
    expect(checkManifest(manifest({ token: { type: 'string' } }, { token: { widget: 'secret' } }))).toEqual([
      'connection.token: a secret field must be writeOnly',
      'connection.token: a secret field must be listed in sensitiveKeys',
    ]);
    expect(checkManifest(manifest({ token: { type: 'string', writeOnly: true } }, {}, ['token']))).toEqual([
      'connection.token: a writeOnly field must use the secret widget',
    ]);
  });

  it('checks match profiles named by plugin.yaml', () => {
    const s = parsePluginSettings({
      rules: [
        { match: 'a', matchProfile: 'known' },
        { match: 'b', matchProfile: 'nope' },
      ],
    });
    expect(checkManifest(manifest({}, {}), s)).toEqual([
      'plugin.yaml rules[1]: matchProfile "nope" is not in the manifest',
    ]);
  });

  it('reports schema errors', () => {
    expect(checkManifest({})[0]).toMatch(/^manifest: /);
  });
});
