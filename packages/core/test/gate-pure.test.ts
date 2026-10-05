import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../src/gate/canonical.js';
import { getPointer, matches, MatchSchema } from '../src/gate/match.js';
import {
  createInstanceRedactor,
  createRedactor,
  GLOBAL_SENSITIVE_KEYS,
  REDACTED,
  redactDiff,
  redactPaths,
  redactResult,
} from '../src/gate/redact.js';

describe('createRedactor', () => {
  const redact = createRedactor(GLOBAL_SENSITIVE_KEYS, ['vendorToken']);

  it('redacts sensitive keys at any depth, case- and separator-insensitively', () => {
    expect(
      redact({
        name: 'share',
        API_KEY: 'k1',
        nested: [{ 'private-key': 'pem', vendortoken: 'p', keep: 'me' }],
        auth: { password: 'x', user: 'u' },
      }),
    ).toEqual({
      name: 'share',
      API_KEY: REDACTED,
      nested: [{ 'private-key': REDACTED, vendortoken: REDACTED, keep: 'me' }],
      auth: { password: REDACTED, user: 'u' },
    });
  });

  it('leaves empty values visible (so "no password set" is still readable) and does not mutate input', () => {
    const input = { password: '', token: null, secret: 's' };
    expect(redact(input)).toEqual({ password: '', token: null, secret: REDACTED });
    expect(input.secret).toBe('s');
  });

  it('redacts keys that contain a sensitive word, keeping flags and counts visible (review L1)', () => {
    expect(
      redact({
        db_password: 'hunter2',
        newPassword: 'n',
        smtp_pass: 's',
        authPass: 'a',
        ssh_private_key: 'pem',
        'X-Api-Key': 'k',
        Authorization: 'Bearer abc',
        headers: { cookie: 'sid=1' },
        password_set: true,
        max_tokens: 4096,
        bypass: 'on',
        passive: 'yes',
        compass: 'north',
      }),
    ).toEqual({
      db_password: REDACTED,
      newPassword: REDACTED,
      smtp_pass: REDACTED,
      authPass: REDACTED,
      ssh_private_key: REDACTED,
      'X-Api-Key': REDACTED,
      Authorization: REDACTED,
      headers: { cookie: REDACTED },
      password_set: true,
      max_tokens: 4096,
      bypass: 'on',
      passive: 'yes',
      compass: 'north',
    });
    // An exact match hides any value, numbers included.
    expect(redact({ password: 1234 })).toEqual({ password: REDACTED });
  });

  it('handles primitives and cycles', () => {
    expect(redact('plain')).toBe('plain');
    const a: Record<string, unknown> = { password: 'x' };
    a.self = a;
    expect(redact(a)).toEqual({ password: REDACTED, self: '[Circular]' });
  });
});

describe('canonicalJson', () => {
  it('is stable across key order and hashes identically', () => {
    const a = canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } });
    const b = canonicalJson({ a: { c: null, d: [3, { x: 2, y: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(sha256Hex(a)).toBe(sha256Hex(b));
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('getPointer', () => {
  it('follows RFC 6901 pointers', () => {
    const doc = { a: { 'b/c': [10, 20], 'm~n': null } };
    expect(getPointer(doc, '/a/b~1c/1')).toBe(20);
    expect(getPointer(doc, '/a/m~0n')).toBeNull();
    expect(typeof getPointer(doc, '/a/missing')).toBe('symbol');
    expect(typeof getPointer(doc, '/a/b~1c/1/x')).toBe('symbol');
  });
});

describe('matches', () => {
  const call = (params: unknown, targets: { id: string; scopes?: Record<string, string> }[] = []) => ({
    params,
    targets: targets.map((t) => ({ kind: 'entity', name: t.id, scopes: {}, ...t })),
  });

  it('treats an empty match as "no parameters", and `any` on "" as "any parameters"', () => {
    expect(matches([], call({}))).toBe(true);
    expect(matches([], call(undefined))).toBe(true);
    expect(matches([], call({ name: 'x' }))).toBe(false);
    expect(matches([{ field: '', op: 'any' }], call({ name: 'x', deep: { a: 1 } }))).toBe(true);
  });

  it('is strict: every parameter must be covered by a condition or accepted with `any`', () => {
    const rule = [{ field: '/name', op: 'prefix', value: 'vol/media' }] as const;
    expect(matches(rule, call({ name: 'vol/media/tv' }))).toBe(true);
    expect(matches(rule, call({ name: 'vol/media/tv', quota: 1 }))).toBe(false);
    const withQuota = [...rule, { field: '/quota', op: 'any' }] as const;
    expect(matches(withQuota, call({ name: 'vol/media/tv', quota: 1 }))).toBe(true);
    expect(matches(withQuota, call({ name: 'vol/media/tv' }))).toBe(true); // `any` also allows absence
    // A condition deeper in an object only covers that key; its siblings still need one.
    const deep = [{ field: '/body/is4k', op: 'bool', value: false }] as const;
    expect(matches(deep, call({ body: { is4k: false } }))).toBe(true);
    expect(matches(deep, call({ body: { is4k: false, userId: 7 } }))).toBe(false);
    expect(matches([...deep, { field: '/body/userId', op: 'any' }], call({ body: { is4k: false, userId: 7 } }))).toBe(
      true,
    );
  });

  it('covers positional (array) params by index, and whole arrays by their own path', () => {
    const rule = [{ field: '/0/name', op: 'prefix', value: 'vol/media' }] as const;
    expect(matches(rule, call([{ name: 'vol/media/tv' }]))).toBe(true);
    expect(matches(rule, call([{ name: 'vol/media/tv', quota: 1 }]))).toBe(false);
    expect(matches(rule, call([{ name: 'vol/media/tv' }, { recursive: true }]))).toBe(false);
    expect(matches([...rule, { field: '/1', op: 'any' }], call([{ name: 'vol/media/tv' }, { a: 1 }]))).toBe(true);
    expect(matches([{ field: '/0', op: 'in', value: ['alpha'] }], call(['alpha']))).toBe(true);
    expect(matches([{ field: '/0', op: 'in', value: ['alpha'] }], call(['alpha', { force: true }]))).toBe(false);
    // An array covered at its own path is covered whole, as before.
    expect(matches([{ field: '/apps', op: 'in', value: ['a', 'b'] }], call({ apps: ['a', 'b'] }))).toBe(true);
    expect(matches([], call([]))).toBe(true);
  });

  it.each([
    ['prefix hit', { field: '/name', op: 'prefix', value: 'vol/media/' }, { name: 'vol/media/tv' }, true],
    ['prefix at a boundary', { field: '/name', op: 'prefix', value: 'vol/media' }, { name: 'vol/media/tv' }, true],
    ['prefix equal', { field: '/name', op: 'prefix', value: 'vol/media' }, { name: 'vol/media' }, true],
    ['prefix mid-segment', { field: '/name', op: 'prefix', value: 'vol/media' }, { name: 'vol/media-private' }, false],
    ['prefix miss', { field: '/name', op: 'prefix', value: 'vol/media/' }, { name: 'vol/other' }, false],
    ['prefix on non-string', { field: '/name', op: 'prefix', value: 'vol/' }, { name: 5 }, false],
    ['empty prefix never matches', { field: '/name', op: 'prefix', value: '' }, { name: 'x' }, false],
    ['in scalar', { field: '/app_name', op: 'in', value: ['alpha', 'beta'] }, { app_name: 'alpha' }, true],
    ['in scalar miss', { field: '/app_name', op: 'in', value: ['alpha'] }, { app_name: 'gamma' }, false],
    ['in array: every element', { field: '/apps', op: 'in', value: ['a', 'b'] }, { apps: ['a', 'b'] }, true],
    ['in array: one outside', { field: '/apps', op: 'in', value: ['a'] }, { apps: ['a', 'x'] }, false],
    ['in empty array', { field: '/apps', op: 'in', value: ['a'] }, { apps: [] }, false],
    ['eq deep', { field: '/o', op: 'eq', value: { a: 1, b: 2 } }, { o: { b: 2, a: 1 } }, true],
    ['bool', { field: '/body/is4k', op: 'bool', value: false }, { body: { is4k: false } }, true],
    ['bool type mismatch', { field: '/body/is4k', op: 'bool', value: false }, { body: { is4k: 'false' } }, false],
    ['range inside', { field: '/t', op: 'range', value: { min: 65, max: 78 } }, { t: 70 }, true],
    ['range above', { field: '/t', op: 'range', value: { min: 65, max: 78 } }, { t: 79 }, false],
    ['range non-number', { field: '/t', op: 'range', value: { min: 65 } }, { t: '70' }, false],
    ['range without bounds', { field: '/t', op: 'range', value: {} }, { t: 70 }, false],
    ['missing field', { field: '/name', op: 'prefix', value: 'vol/' }, {}, false],
  ] as const)('%s', (_name, condition, params, expected) => {
    expect(matches([condition], call(params))).toBe(expected);
  });

  it('requires every resolved target to satisfy every target selector, on whatever scopes the plugin declares', () => {
    const cond = { field: '$targets' as const, scopes: { zone: ['zone_a'], type: ['widget'] } };
    const inZone = { id: 'widget.one', scopes: { zone: 'zone_a', type: 'widget' } };
    const elsewhere = { id: 'widget.two', scopes: { zone: 'zone_b', type: 'widget' } };
    const unscoped = { id: 'widget.three', scopes: { type: 'widget' } };
    expect(matches([cond], call({}, [inZone]))).toBe(true);
    expect(matches([cond], call({}, [inZone, elsewhere]))).toBe(false);
    // A target that reports no value for a selected scope never matches it.
    expect(matches([cond], call({}, [inZone, unscoped]))).toBe(false);
    expect(matches([cond], call({}, []))).toBe(false);
    expect(matches([{ field: '$targets', ids: ['widget.one'] }], call({}, [inZone]))).toBe(true);
    expect(matches([{ field: '$targets', ids: ['widget.one'] }], call({}, [inZone, unscoped]))).toBe(false);
  });

  it('rejects $targets conditions that select nothing or use unknown keys', () => {
    expect(MatchSchema.safeParse([{ field: '$targets' }]).success).toBe(false);
    expect(MatchSchema.safeParse([{ field: '$targets', scopes: {} }]).success).toBe(false);
    expect(MatchSchema.safeParse([{ field: '$targets', scopes: { zone: [] } }]).success).toBe(false);
    expect(MatchSchema.safeParse([{ field: '$targets', areas: ['zone_a'] }]).success).toBe(false);
  });

  it('ANDs conditions', () => {
    const rule = [
      { field: '/name', op: 'prefix', value: 'vol/media/' },
      { field: '/quota', op: 'range', value: { max: 100 } },
    ] as const;
    expect(matches(rule, call({ name: 'vol/media/a', quota: 50 }))).toBe(true);
    expect(matches(rule, call({ name: 'vol/media/a', quota: 500 }))).toBe(false);
  });

  it('validates rule shapes', () => {
    expect(MatchSchema.safeParse([{ field: '/n', op: 'prefix', value: 'x' }]).success).toBe(true);
    expect(MatchSchema.safeParse([{ field: '$targets' }]).success).toBe(false);
    expect(MatchSchema.safeParse([{ field: 'name', op: 'prefix', value: 'x' }]).success).toBe(false);
    expect(MatchSchema.safeParse([{ field: '/n', op: 'regex', value: '.*' }]).success).toBe(false);
    expect(MatchSchema.safeParse([{ field: '', op: 'any' }]).success).toBe(true);
    expect(MatchSchema.safeParse([{ field: '', op: 'eq', value: 1 }]).success).toBe(false);
  });
});

describe('instance redactor', () => {
  it('scrubs the instance secret values out of any text, encoded or not, and ignores short ones', () => {
    const redact = createInstanceRedactor({ keyLists: [GLOBAL_SENSITIVE_KEYS], secretValues: ['p@ss word!', 'abc'] });
    expect(redact('login with p@ss word! failed')).toBe('login with [REDACTED] failed');
    expect(redact({ url: 'https://x/?k=p%40ss%20word!' })).toEqual({ url: 'https://x/?k=[REDACTED]' });
    expect(redact({ ['p@ss word!']: 1 })).toEqual({ [REDACTED]: 1 });
    expect(redact('abc stays')).toBe('abc stays'); // too short to scrub safely
  });
});

describe('redactPaths', () => {
  it('hides positional and nested values the plugin declared, on a copy', () => {
    const params = ['admin', 'hunter22', { opts: { pin: 1234, keep: 'x' } }];
    expect(redactPaths(params, ['/1', '/2/opts/pin'])).toEqual([
      'admin',
      REDACTED,
      { opts: { pin: REDACTED, keep: 'x' } },
    ]);
    expect(params[1]).toBe('hunter22'); // the input is untouched
  });

  it('ignores missing paths, empty values and inherited keys, and decodes ~1 / ~0', () => {
    expect(redactPaths({ a: '', b: null }, ['/a', '/b', '/c/d', '/__proto__/x'])).toEqual({ a: '', b: null });
    expect(redactPaths({ 'a/b': 's', 'c~d': 't' }, ['/a~1b', '/c~0d'])).toEqual({ 'a/b': REDACTED, 'c~d': REDACTED });
    expect(redactPaths('plain', ['/0'])).toBe('plain');
    expect(redactPaths({ a: 1 }, null)).toEqual({ a: 1 });
  });
});

describe('redactResult', () => {
  it('leaves results without a declaration alone', () => {
    const value = { key: 'k' };
    expect(redactResult(value, undefined)).toBe(value);
    expect(redactResult(value, null)).toBe(value);
  });

  it('masks a whole result that is a secret, whatever its type', () => {
    expect(redactResult('abc', 'whole')).toBe(REDACTED);
    expect(redactResult(123456, 'whole')).toBe(REDACTED);
    expect(redactResult({ token: 'x' }, 'whole')).toBe(REDACTED);
    expect(redactResult('', 'whole')).toBe('');
    expect(redactResult(null, 'whole')).toBeNull();
  });

  it('masks named keys in the result or each row of it', () => {
    const spec = { keys: ['key'] };
    expect(redactResult([{ id: 1, key: 'k' }, { id: 2 }], spec)).toEqual([{ id: 1, key: REDACTED }, { id: 2 }]);
    // Whatever the value under the key: a number, an object.
    expect(redactResult({ key: { nested: 'x' } }, spec)).toEqual({ key: REDACTED });
    expect(redactResult({ key: 1234 }, spec)).toEqual({ key: REDACTED });
    expect(redactResult({ key: '' }, spec)).toEqual({ key: '' });
    // Only the top level (or each row) without `deep`.
    expect(redactResult({ a: { key: 'k' } }, spec)).toEqual({ a: { key: 'k' } });
    // Exact names: `keyId` is not `key`.
    expect(redactResult({ keyId: 7, key: 'k' }, spec)).toEqual({ keyId: 7, key: REDACTED });
  });

  it('masks at any depth with deep, and hides what is nested deeper than it looks', () => {
    const spec = { keys: ['key', 'secret'], deep: true };
    expect(redactResult({ a: [{ provider: { key: 'k', secret: 's', type: 'B2' } }] }, spec)).toEqual({
      a: [{ provider: { key: REDACTED, secret: REDACTED, type: 'B2' } }],
    });
    let nested: unknown = { key: 's' };
    for (let i = 0; i < 20; i++) nested = { a: nested };
    expect(JSON.stringify(redactResult(nested, spec))).not.toContain('"s"');
  });

  it('never pollutes prototypes and keeps a __proto__ key visible', () => {
    const input = JSON.parse('{"__proto__": {"polluted": true}, "key": "k"}') as unknown;
    for (const spec of [{ keys: ['key'] }, { keys: ['key'], deep: true }]) {
      const out = redactResult(input, spec) as Record<string, unknown>;
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
      expect(Object.hasOwn(out, '__proto__')).toBe(true);
      expect(out.key).toBe(REDACTED);
    }
  });
});

describe('redactor and __proto__', () => {
  it('keeps a __proto__ key as a visible own key instead of a prototype', () => {
    const out = createRedactor([])(JSON.parse('{"a":1,"__proto__":{"x":1}}') as object);
    expect(JSON.stringify(out)).toBe('{"a":1,"__proto__":{"x":1}}');
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});

describe('redactDiff', () => {
  const redact = createRedactor(GLOBAL_SENSITIVE_KEYS, ['webhook_id']);
  it('hides both sides of entries whose path names a secret or a sensitive param', () => {
    expect(
      redactDiff(
        [
          { path: '/action/0/data/password', before: 'old', after: 'new' },
          { path: '/trigger/webhook_id', after: 'hook-123' },
          { path: '/pin', before: '1' },
          { path: '/pin/deep', after: '2' },
          { path: '/alias', before: 'Lights', after: 'Lamps' },
          { path: '/data', after: { token: 'abc', keep: 1 } },
        ],
        redact,
        ['/pin'],
      ),
    ).toEqual([
      { path: '/action/0/data/password', before: REDACTED, after: REDACTED },
      { path: '/trigger/webhook_id', after: REDACTED },
      { path: '/pin', before: REDACTED },
      { path: '/pin/deep', after: REDACTED },
      { path: '/alias', before: 'Lights', after: 'Lamps' },
      { path: '/data', after: { token: REDACTED, keep: 1 } },
    ]);
    expect(redactDiff(undefined, redact)).toBeUndefined();
  });

  it('catches dotted and bare paths, hides declared parts inside a parent entry, and fails closed', () => {
    expect(
      redactDiff(
        [
          { path: 'password', after: 'p1' },
          { path: 'smtp.password', before: 'p2' },
          { path: '/args', before: ['u', 'old-secret'], after: ['u', 'new-secret'] },
        ],
        redact,
        ['/args/1'],
      ),
    ).toEqual([
      { path: 'password', after: REDACTED },
      { path: 'smtp.password', before: REDACTED },
      { path: '/args', before: ['u', REDACTED], after: ['u', REDACTED] },
    ]);
    const bare = (<T>(v: T) => v) as Parameters<typeof redactDiff>[1];
    expect(redactDiff([{ path: '/alias', after: 'x' }], bare)).toEqual([{ path: '/alias', after: REDACTED }]);
  });
});
