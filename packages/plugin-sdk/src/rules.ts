import { z } from 'zod';
import { baseKey, splitSuffix } from './catalog-helpers.js';
import { SensitiveResultSchema } from './operations.js';
import type { OperationDescriptor, ResolvedTarget, SensitiveResult } from './operations.js';
import { isPlainObject, stringOr } from './plugin-kit.js';

/**
 * `plugin.yaml`: what a plugin declares about its operations, as data instead of code (design §3.4,
 * §5.2). Discovery stays in the plugin (an introspection call, an OpenAPI spec, a service list); this
 * file decorates what it finds, by operation key:
 *
 * - `rules`: locked operations, split twins, classification overrides, match profiles, sensitive
 *   params and results, typed-confirmation literals, summary notes, descriptions and guidance;
 * - `exclude` / `include`: operations left out of the catalog entirely;
 * - `operations`: operations declared outright, for APIs with no discovery (`staticCatalog`);
 * - `plugin`: anything specific to one upstream, validated by the plugin's own schema.
 *
 * Precedence fails closed: an excluded operation is gone; `locked` (or being a split twin) always
 * means write with typed confirmation; then a rule's `classification`; then the plugin's own
 * heuristic; and an operation nothing classifies is a write.
 */

const pointer = z.string().regex(/^(\/[^/]{1,128}){1,8}$/, 'a JSON pointer such as /1 or /0/password');
const pattern = z.string().min(1).max(512);
const suffix = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes');
const fieldRef = z.string().min(1).max(256);

/** A lookup run through the plugin's `lookup` hook. `{ $param: '/0' }` in `args` or `find.equals` is replaced by that param. */
const LookupSchema = z
  .object({
    op: z.string().min(1),
    args: z.array(z.unknown()).default([]),
    /** Result field(s) to read, first non-empty wins: a top-level name or a JSON pointer. */
    field: z.union([fieldRef, z.array(fieldRef).min(1)]),
    /** Pick the row of a list result whose `field` equals `equals`. */
    find: z.object({ field: fieldRef, equals: z.unknown() }).strict().optional(),
  })
  .strict();

const ConfirmSourceSchema = z.union([
  /** The instance's own name (`instanceName`). */
  z.literal('instance'),
  /** The resolved targets' names, comma-separated. */
  z.literal('targets'),
  /** A string or number param. */
  z.object({ param: pointer }).strict(),
  /** A name looked up from the upstream; falls back to the `$param` it was looked up by. */
  z.object({ lookup: LookupSchema }).strict(),
  /** A function the plugin registers under this name. */
  z.object({ custom: z.string().min(1) }).strict(),
]);
const ConfirmSchema = z.union([ConfirmSourceSchema, z.array(ConfirmSourceSchema).min(1)]);
export type ConfirmSource = z.infer<typeof ConfirmSourceSchema>;

export const RuleSchema = z
  .object({
    /** Operation key(s) or globs (`*` matches anything): `api_key.*`, `GET /settings/*`, `*#garage`. */
    match: z.union([pattern, z.array(pattern).min(1)]),
    /** Always a human with typed confirmation; never classified read. */
    locked: z.boolean().optional(),
    /** Overrides the plugin's heuristic (never a lock). */
    classification: z.enum(['read', 'write']).optional(),
    /** `classificationReason` for a locked or overridden operation. */
    reason: z.string().min(1).optional(),
    needsReview: z.boolean().optional(),
    /** Adds a locked twin `<key>#<suffix>` per suffix; the plugin decides when a call takes it. */
    split: z.union([suffix, z.array(suffix).min(1)]).optional(),
    matchProfile: z.string().min(1).optional(),
    sensitiveParams: z.array(pointer).max(32).optional(),
    sensitiveResult: SensitiveResultSchema.optional(),
    /** The literal an approver types: the first source that yields one wins. */
    confirm: ConfirmSchema.optional(),
    /** Appended to the approval summary. */
    summaryNote: z.string().min(1).optional(),
    /** `docs.description`; `{base}` and `{key}` are replaced. */
    description: z.string().min(1).optional(),
    guidance: z.string().min(1).optional(),
    attestation: z.boolean().optional(),
  })
  .strict();
export type Rule = z.infer<typeof RuleSchema>;

const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** An operation declared outright (`staticCatalog`). */
export const StaticOperationSchema = z
  .object({
    key: z.string().min(1).max(512),
    kind: z.string().min(1).default('command'),
    group: z
      .string()
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, dots, dashes and underscores'),
    classification: z.enum(['read', 'write']),
    reason: z.string().min(1).optional(),
    summary: z.string().min(1),
    description: z.string().min(1).optional(),
    attestation: z.boolean().optional(),
    paramsSchema: z.record(z.string(), z.unknown()).optional(),
    /** For `staticCatalog`'s HTTP binding: the request this operation makes; `{name}` comes from `params.path`. */
    http: z
      .object({ method: z.enum(VERBS), path: z.string().startsWith('/') })
      .strict()
      .optional(),
  })
  .strict();
export type StaticOperation = z.infer<typeof StaticOperationSchema>;

export const PluginSettingsSchema = z
  .object({
    defaults: z
      .object({
        /** Confirm source(s) for locked operations whose rules give none. */
        confirm: ConfirmSchema.optional(),
        timeouts: z
          .object({
            request: z.number().int().positive().default(15_000),
            lookup: z.number().int().positive().default(10_000),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    /** How the `instance` confirm source names this instance; `{key}` in `fallback` is the operation key. */
    instanceName: LookupSchema.omit({ find: true })
      .extend({ fallback: z.string().min(1) })
      .strict()
      .optional(),
    exclude: z.array(pattern).default([]),
    /** Re-allows keys inside an excluded glob. */
    include: z.array(pattern).default([]),
    rules: z.array(RuleSchema).default([]),
    operations: z.array(StaticOperationSchema).default([]),
    plugin: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type PluginSettings<P = Record<string, unknown>> = Omit<z.infer<typeof PluginSettingsSchema>, 'plugin'> & {
  plugin: P;
};

/** Validates `plugin.yaml` (already parsed) and, with `plugin`, its `plugin:` section. Throws a `ZodError`. */
export function parsePluginSettings<P = Record<string, unknown>>(
  raw: unknown,
  plugin?: { parse(value: unknown): P },
): PluginSettings<P> {
  const settings = PluginSettingsSchema.parse(raw ?? {});
  return { ...settings, plugin: plugin ? plugin.parse(settings.plugin) : (settings.plugin as P) };
}

/** JSON Schema of `plugin.yaml`, for editors. */
export function pluginSettingsJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(PluginSettingsSchema, { io: 'input' }) as Record<string, unknown>;
}

/** What discovery produces before rules apply: classification is the plugin's heuristic, or absent if unclear. */
export type OperationDraft = Omit<
  OperationDescriptor,
  'classification' | 'classificationReason' | 'locked' | 'typedConfirmation'
> & {
  classification?: 'read' | 'write';
  classificationReason?: string;
};

export interface ConfirmContext {
  key: string;
  params: unknown;
  targets: readonly ResolvedTarget[];
}

export interface RuleHooks {
  /** Runs a read for a `lookup` confirm source or `instanceName`; failures count as "not found". */
  lookup?(op: string, args: unknown[], timeoutMs: number): Promise<unknown>;
  /** Named confirm sources (`confirm: { custom: name }`). Errors propagate. */
  custom?: Record<string, (ctx: ConfirmContext) => Promise<string | undefined> | string | undefined>;
}

export interface CompiledRules<P = Record<string, unknown>> {
  settings: PluginSettings<P>;
  /** Left out of the catalog (`exclude`, unless `include`d). */
  excluded(key: string): boolean;
  /** Locked by a rule, or a split twin. */
  isLocked(key: string): boolean;
  /** Split suffixes declared for a key. */
  splits(key: string): string[];
  /** The draft and its split twins, with every rule applied. */
  describe(draft: OperationDraft): OperationDescriptor[];
  /** One descriptor with every rule applied. */
  decorate(draft: OperationDraft): OperationDescriptor;
  /** Notes to append to the approval summary. */
  summaryNotes(key: string): string[];
  /** The typed-confirmation literal of a locked operation; undefined for others or when nothing yields one. */
  confirmLiteral(ctx: ConfirmContext): Promise<string | undefined>;
  /**
   * `value` masked as operation `key`'s `sensitiveResult` would mask it, as a copy. Core already masks
   * every operation's own result; this is only for results of other operations a plugin hands back
   * inside its own (a job queue's records), which core can't attribute to them.
   */
  maskEmbeddedResult(key: string, value: unknown): unknown;
}

export const REDACTED = '[REDACTED]';

function globRegex(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

const listOf = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Resolves a JSON pointer (`/0/name`) or a top-level name in a value. */
export function readPointer(value: unknown, ref: string): unknown {
  const parts = ref.startsWith('/')
    ? ref
        .slice(1)
        .split('/')
        .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    : [ref];
  let v = value;
  for (const p of parts) {
    if (Array.isArray(v)) v = /^\d+$/.test(p) ? v[Number(p)] : undefined;
    else if (isPlainObject(v)) v = Object.hasOwn(v, p) ? v[p] : undefined;
    else return undefined;
  }
  return v;
}

/** Copies `value` with every `{ $param: pointer }` replaced; reports the params it used. */
function fillParams(value: unknown, params: unknown, used: unknown[]): unknown {
  if (Array.isArray(value)) return value.map((v) => fillParams(v, params, used));
  if (!isPlainObject(value)) return value;
  if (typeof value.$param === 'string' && Object.keys(value).length === 1) {
    const v = readPointer(params, value.$param);
    used.push(v);
    return v;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) define(out, k, fillParams(v, params, used));
  return out;
}

/** Sets an own property, even one named `__proto__`, without touching the prototype. */
function define(target: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function pickField(row: unknown, fields: string | string[]): string | undefined {
  for (const f of listOf(fields)) {
    const v = stringOr(readPointer(row, f));
    if (v) return v;
  }
  return undefined;
}

/** A value worth masking: anything but null, undefined and the empty string. */
const present = (v: unknown) => v !== null && v !== undefined && v !== '';

/** Deeper than masking looks into: hidden rather than passed through unchecked. */
const MAX_MASK_DEPTH = 16;

function maskDeep(value: unknown, keys: ReadonlySet<string>, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_MASK_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, keys, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value))
    define(out, k, keys.has(k) && present(v) ? REDACTED : maskDeep(v, keys, depth + 1));
  return out;
}

function maskShallow(value: unknown, keys: ReadonlySet<string>): unknown {
  const mask = (row: unknown) => {
    if (!isPlainObject(row) || ![...keys].some((k) => present(row[k]))) return row;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) define(out, k, keys.has(k) && present(v) ? REDACTED : v);
    return out;
  };
  return Array.isArray(value) ? value.map(mask) : mask(value);
}

/**
 * Masks what a `sensitiveResult` declares (design §5.5): the whole value, or every non-empty value
 * under one of `keys` (exact names) in the value or each row of it, at any depth with `deep`, whatever
 * its type; anything nested deeper than 16 levels is hidden too. Returns a copy. Core applies it to
 * every operation's result after `invoke`; plugins don't call it on their own results.
 */
export function maskSensitiveResult<T>(value: T, spec: SensitiveResult | null | undefined): T {
  if (!spec) return value;
  if (spec === 'whole') return (present(value) ? REDACTED : value) as T;
  const keys = new Set(spec.keys);
  return (spec.deep ? maskDeep(value, keys, 0) : maskShallow(value, keys)) as T;
}

interface Merged {
  locked: boolean;
  classification?: 'read' | 'write';
  reason?: string;
  needsReview?: boolean;
  matchProfile?: string;
  sensitiveParams: string[];
  sensitiveResult?: z.infer<typeof SensitiveResultSchema>;
  confirm?: ConfirmSource[];
  summaryNotes: string[];
  description?: string;
  guidance?: string;
  attestation: boolean;
  splits: string[];
}

/**
 * Compiles validated settings. A field set by several matching rules takes the first rule's value,
 * except `locked` and `attestation` (any rule), `sensitiveParams` and `summaryNote` (all rules).
 * `sensitiveParams`, `sensitiveResult`, `matchProfile` and `guidance` also apply to a split twin
 * through its base key; everything else matches the exact key.
 */
export function compileRules<P>(settings: PluginSettings<P>, hooks: RuleHooks = {}): CompiledRules<P> {
  const rules = settings.rules.map((rule) => ({ rule, res: listOf(rule.match).map(globRegex) }));
  const exclude = settings.exclude.map(globRegex);
  const include = settings.include.map(globRegex);
  const cache = new Map<string, Merged>();
  const hits = (res: RegExp[], key: string) => res.some((re) => re.test(key));

  const merged = (key: string): Merged => {
    const cached = cache.get(key);
    if (cached) return cached;
    const base = baseKey(key);
    const m: Merged = { locked: false, sensitiveParams: [], summaryNotes: [], attestation: false, splits: [] };
    for (const { rule, res } of rules) {
      const exact = hits(res, key);
      const inherited = exact || (base !== key && hits(res, base));
      if (inherited) {
        if (rule.sensitiveParams) m.sensitiveParams.push(...rule.sensitiveParams);
        m.sensitiveResult ??= rule.sensitiveResult;
        m.matchProfile ??= rule.matchProfile;
        m.guidance ??= rule.guidance;
      }
      if (!exact) continue;
      if (rule.locked) m.locked = true;
      if (rule.attestation) m.attestation = true;
      m.classification ??= rule.classification;
      m.reason ??= rule.reason;
      m.needsReview ??= rule.needsReview;
      m.confirm ??= rule.confirm === undefined ? undefined : listOf(rule.confirm);
      m.description ??= rule.description;
      if (rule.summaryNote) m.summaryNotes.push(rule.summaryNote);
      if (base === key) m.splits.push(...listOf(rule.split));
    }
    m.sensitiveParams = [...new Set(m.sensitiveParams)];
    m.splits = [...new Set(m.splits)];
    if (cache.size > 10_000) cache.clear();
    cache.set(key, m);
    return m;
  };

  const isLocked = (key: string) => splitSuffix(key) !== undefined || merged(key).locked;
  const lookupTimeout = settings.defaults.timeouts.lookup;

  const lookup = async (op: string, args: unknown[]): Promise<unknown> => {
    if (!hooks.lookup) return undefined;
    try {
      return await hooks.lookup(op, args, lookupTimeout);
    } catch {
      return undefined;
    }
  };

  const instanceName = async (key: string): Promise<string | undefined> => {
    const inst = settings.instanceName;
    if (!inst) return undefined;
    const used: unknown[] = [];
    const args = fillParams(inst.args, undefined, used) as unknown[];
    return pickField(await lookup(inst.op, args), inst.field) ?? inst.fallback.replaceAll('{key}', key);
  };

  const evaluate = async (src: ConfirmSource, ctx: ConfirmContext): Promise<string | undefined> => {
    if (src === 'instance') return instanceName(ctx.key);
    if (src === 'targets') return ctx.targets.length ? ctx.targets.map((t) => t.name || t.id).join(', ') : undefined;
    if ('param' in src) return stringOr(readPointer(ctx.params, src.param));
    if ('custom' in src) {
      const fn = hooks.custom?.[src.custom];
      if (!fn) throw new Error(`plugin.yaml: no custom confirm source "${src.custom}"`);
      return (await fn(ctx)) || undefined;
    }
    const used: unknown[] = [];
    const args = fillParams(src.lookup.args, ctx.params, used) as unknown[];
    const equals = src.lookup.find ? fillParams(src.lookup.find.equals, ctx.params, used) : undefined;
    // Only a plain id may be looked up, or shown back as the literal.
    if (used.some((v) => stringOr(v) === undefined)) return undefined;
    let result = await lookup(src.lookup.op, args);
    if (src.lookup.find) {
      const { field } = src.lookup.find;
      result = Array.isArray(result)
        ? result.find((row) => {
            const id = stringOr(readPointer(row, field));
            return id !== undefined && id === stringOr(equals);
          })
        : undefined;
    }
    return pickField(result, src.lookup.field) ?? (used.length ? String(used[0]) : undefined);
  };

  const decorate = (draft: OperationDraft): OperationDescriptor => {
    const { classification: draftClass, classificationReason: draftReason, docs, ...rest } = draft;
    const m = merged(draft.key);
    const locked = isLocked(draft.key);
    let classification: 'read' | 'write';
    let reason: string;
    let needsReview = draft.needsReview;
    if (locked) {
      classification = 'write';
      reason = m.reason ?? 'locked:destructive';
    } else if (m.classification) {
      classification = m.classification;
      reason = m.reason ?? `rule:${m.classification}`;
    } else if (draftClass) {
      classification = draftClass;
      reason = draftReason ?? `plugin:${draftClass}`;
    } else {
      classification = 'write';
      reason = 'default:ambiguous';
    }
    if (m.needsReview !== undefined) needsReview = m.needsReview;
    const sensitiveParams = [...new Set([...(draft.sensitiveParams ?? []), ...m.sensitiveParams])];
    // Core takes at most 32; dropping the rest silently would stop redacting them.
    if (sensitiveParams.length > 32)
      throw new Error(`plugin.yaml: ${draft.key} has ${sensitiveParams.length} sensitiveParams; the limit is 32`);
    const base = baseKey(draft.key);
    const description = m.description?.replaceAll('{base}', base).replaceAll('{key}', draft.key) ?? docs?.description;
    const guidance = m.guidance ?? docs?.guidance;
    const mergedDocs = {
      ...(docs?.summary ? { summary: docs.summary } : {}),
      ...(description ? { description } : {}),
      ...(guidance ? { guidance } : {}),
    };
    const matchProfile = m.matchProfile ?? draft.matchProfile;
    return {
      ...rest,
      classification,
      classificationReason: reason,
      locked,
      typedConfirmation: locked,
      ...(needsReview !== undefined ? { needsReview } : {}),
      ...(m.attestation ? { attestationRequired: true } : {}),
      ...(matchProfile ? { matchProfile } : {}),
      ...(sensitiveParams.length ? { sensitiveParams } : {}),
      ...(m.sensitiveResult ? { sensitiveResult: m.sensitiveResult } : {}),
      ...(Object.keys(mergedDocs).length ? { docs: mergedDocs } : {}),
    };
  };

  return {
    settings,
    excluded: (key) => hits(exclude, key) && !hits(include, key),
    isLocked,
    splits: (key) => merged(key).splits,
    decorate,
    describe: (draft) => [
      decorate(draft),
      ...merged(draft.key).splits.map((s) => decorate({ ...draft, key: `${draft.key}#${s}` })),
    ],
    summaryNotes: (key) => merged(key).summaryNotes,
    async confirmLiteral(ctx) {
      if (!isLocked(ctx.key)) return undefined;
      const sources = merged(ctx.key).confirm ?? listOf(settings.defaults.confirm);
      for (const src of sources) {
        const literal = await evaluate(src, ctx);
        if (literal) return literal;
      }
      return undefined;
    },
    maskEmbeddedResult: (key, value) => maskSensitiveResult(value, merged(key).sensitiveResult),
  };
}
