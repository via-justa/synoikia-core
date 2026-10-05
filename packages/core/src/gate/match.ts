import { MATCH_OPS } from '@synoikia/plugin-sdk';
import type { ResolvedTarget } from '@synoikia/plugin-sdk';
import { z } from 'zod';
import { canonicalJson } from './canonical.js';

/** Pre-approval `match` evaluator (design §5.2): all conditions must hold, failing closed. Matching is
 * strict: every parameter must be covered, or accepted with `op: 'any'`. */

const PARAM_OPS = [...MATCH_OPS, 'any'] as const;

export const ParamConditionSchema = z
  .object({
    field: z.string().regex(/^(\/.*)?$/, 'must be a JSON pointer'),
    op: z.enum(PARAM_OPS),
    value: z.unknown().optional(),
  })
  .refine((c) => c.op === 'any' || c.field !== '', 'only "any" can apply to all parameters');

/** Selects resolved targets by id and declared scope values; every target must match (design §3.2). */
export const TargetConditionSchema = z
  .object({
    field: z.literal('$targets'),
    ids: z.array(z.string().min(1)).min(1).optional(),
    scopes: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)).optional(),
  })
  .strict()
  .refine((c) => c.ids || Object.keys(c.scopes ?? {}).length > 0, 'select at least one target id or scope value');

export const MatchSchema = z.array(z.union([TargetConditionSchema, ParamConditionSchema]));
export type MatchCondition = z.infer<typeof MatchSchema>[number];

const MISSING = Symbol('missing');

/** RFC 6901 JSON pointer lookup; returns MISSING instead of undefined so `null` values still count. */
export function getPointer(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key)) return MISSING;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function paramMatches(actual: unknown, op: string, expected: unknown): boolean {
  if (op === 'any') return true; // present or not, any value
  if (actual === MISSING) return false;
  switch (op) {
    case 'eq':
      return canonicalJson(actual) === canonicalJson(expected);
    case 'in': {
      if (!Array.isArray(expected)) return false;
      const allowed = new Set(expected.map((v) => canonicalJson(v)));
      const values = Array.isArray(actual) ? actual : [actual];
      return values.length > 0 && values.every((v) => allowed.has(canonicalJson(v)));
    }
    case 'prefix':
      // Path-segment boundary: "vol/media" matches "vol/media" and "vol/media/tv", not "vol/media-private".
      return (
        typeof actual === 'string' &&
        typeof expected === 'string' &&
        expected !== '' &&
        (actual === expected ||
          (actual.startsWith(expected) && (expected.endsWith('/') || actual[expected.length] === '/')))
      );
    case 'range': {
      const { min, max } = (expected ?? {}) as { min?: unknown; max?: unknown };
      if (typeof actual !== 'number' || !Number.isFinite(actual)) return false;
      if (min === undefined && max === undefined) return false;
      if (min !== undefined && (typeof min !== 'number' || actual < min)) return false;
      if (max !== undefined && (typeof max !== 'number' || actual > max)) return false;
      return true;
    }
    case 'bool':
      return typeof actual === 'boolean' && actual === expected;
    default:
      return false;
  }
}

function targetMatches(target: ResolvedTarget, c: z.infer<typeof TargetConditionSchema>): boolean {
  if (c.ids && !c.ids.includes(target.id)) return false;
  for (const [key, values] of Object.entries(c.scopes ?? {})) {
    const value = target.scopes?.[key];
    if (value === undefined || !values.includes(value)) return false;
  }
  return true;
}

const escapePointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

/** Whether every parameter is covered by a condition: a path covers everything under it; partly covered
 * objects and arrays are checked key by key. */
export function coversAllParams(
  match: readonly MatchCondition[],
  params: unknown,
  /** Extra covered pointers, e.g. the raw target a `$targets` condition stands for (design §3.4). */
  alsoCovered: readonly string[] = [],
): boolean {
  const pointers = [...match.filter((c) => c.field !== '$targets').map((c) => c.field), ...alsoCovered];
  const covered = (value: unknown, path: string): boolean => {
    if (pointers.includes(path)) return true;
    if (value === undefined || value === null) return path === '';
    if (typeof value !== 'object') return false;
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
    if (entries.length === 0) return true;
    if (!pointers.some((p) => p.startsWith(`${path}/`))) return false;
    return entries.every(([k, v]) => covered(v, `${path}/${escapePointer(k)}`));
  };
  return covered(params, '');
}

/** The conditions alone, without the strict every-parameter check (used to spot rules strictness broke). */
export function conditionsHold(
  match: readonly MatchCondition[],
  call: { params: unknown; targets: readonly ResolvedTarget[] },
): boolean {
  return match.every((c) => {
    if (c.field === '$targets') {
      const tc = c as z.infer<typeof TargetConditionSchema>;
      return call.targets.length > 0 && call.targets.every((t) => targetMatches(t, tc));
    }
    const pc = c as z.infer<typeof ParamConditionSchema>;
    return paramMatches(getPointer(call.params, pc.field), pc.op, pc.value);
  });
}

export function matches(
  match: readonly MatchCondition[],
  call: { params: unknown; targets: readonly ResolvedTarget[] },
): boolean {
  return conditionsHold(match, call) && coversAllParams(match, call.params);
}
