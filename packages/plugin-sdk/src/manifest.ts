import semver from 'semver';
import { z } from 'zod';
import { SDK_VERSION } from './version.js';

/** Core widget library (design §8.3); an unknown widget fails validation rather than degrading. */
export const WIDGETS = [
  'text',
  'url',
  'number',
  'bool',
  'select',
  'secret',
  'multiselect',
  'prefix',
  'range',
  'registry-picker',
  'diff',
] as const;
export type Widget = (typeof WIDGETS)[number];

/** Operators understood by the core pre-approval match evaluator (design §5.2). */
export const MATCH_OPS = ['eq', 'in', 'prefix', 'range', 'bool'] as const;
export type MatchOp = (typeof MATCH_OPS)[number];

/** Sandbox globals owned by core; a plugin binding namespace may not shadow them. */
export const RESERVED_NAMESPACES = ['catalog', 'registry', 'guides', 'console'] as const;

const pluginId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'lowercase letters, digits and dashes');
const jsIdentifier = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, 'must be a JavaScript identifier');
const jsonSchema = z.record(z.string(), z.unknown());

const relativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.split(/[\\/]/).includes('..'), 'must be a relative path inside the package');

export const UiHintSchema = z.object({
  widget: z.enum(WIDGETS).optional(),
  help: z.string().optional(),
  placeholder: z.string().optional(),
  optionsSource: z.string().optional(),
  /** Show the field only while another connection field has one of these values (e.g. an auth-method select). */
  showWhen: z
    .object({
      field: z.string().min(1),
      in: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
    })
    .optional(),
});
export type UiHint = z.infer<typeof UiHintSchema>;

const scopeKey = z.string().regex(/^[a-z][a-z0-9_-]*$/, 'must be lowercase letters, digits, _ or -');

/** What a plugin's resolved targets are and the scopes rules select them by (design §3.2). */
export const TargetsSchema = z.object({
  /** What one target is called in the portal, e.g. "Entity", "Host", "Container". */
  label: z.string().min(1).default('Target'),
  /** Registry kind whose entries are the targets themselves; the picker suggests ids from it. */
  registryKind: z.string().min(1).optional(),
  /** Dimensions a rule can select targets by, e.g. a location or a type. */
  scopes: z
    .array(
      z.object({
        key: scopeKey,
        label: z.string().min(1),
        /** Registry kind whose entry ids are this scope's values; the picker suggests from it. */
        registryKind: z.string().min(1).optional(),
      }),
    )
    .default([]),
});
export type Targets = z.infer<typeof TargetsSchema>;

/** `options` of a `$targets` match field. */
export const TargetFieldOptionsSchema = z
  .object({
    /** Declared scope keys this field offers; all of them when omitted. */
    scopes: z.array(scopeKey).optional(),
    /** Fixed scope values that narrow the picker's target suggestions, e.g. to one type. */
    filter: z.record(scopeKey, z.string().min(1)).optional(),
  })
  .strict();

export const MatchFieldSchema = z
  .object({
    /** JSON pointer into the normalized params (`/name`), or `$targets` for the resolved-target selector. */
    field: z.string().regex(/^(\$targets|\/.*)$/, 'must be a JSON pointer or $targets'),
    label: z.string().min(1),
    op: z.enum(MATCH_OPS).optional(),
    widget: z.enum(WIDGETS),
    options: z.record(z.string(), z.unknown()).optional(),
    /** Source name passed to the plugin's `optionsFor` RPC to populate pickers. */
    optionsSource: z.string().optional(),
    /** `$targets` only: the params subtrees the selector stands for, covered under strict matching. */
    covers: z.array(z.string().regex(/^\/.+/, 'must be a JSON pointer')).min(1).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.field === '$targets') {
      if (f.widget !== 'registry-picker') {
        ctx.addIssue({ code: 'custom', message: '$targets fields must use the registry-picker widget' });
      }
      const options = TargetFieldOptionsSchema.safeParse(f.options ?? {});
      if (!options.success) {
        for (const issue of options.error.issues) {
          ctx.addIssue({ code: 'custom', path: ['options', ...issue.path], message: issue.message });
        }
      }
    } else if (f.covers) {
      ctx.addIssue({ code: 'custom', message: 'only $targets fields can declare covers' });
    } else if (!f.op) {
      ctx.addIssue({ code: 'custom', message: 'param match fields must declare an op' });
    }
  });
export type MatchField = z.infer<typeof MatchFieldSchema>;

export const ManifestSchema = z
  .object({
    id: pluginId,
    name: z.string().min(1),
    version: z.string().refine((v) => semver.valid(v) !== null, 'must be a semver version'),
    sdk: z.string().refine((r) => semver.validRange(r) !== null, 'must be a semver range'),
    description: z.string().optional(),
    entry: relativePath,
    binding: z.object({
      namespace: jsIdentifier,
      functions: z.array(jsIdentifier).min(1),
      searchApis: z.array(z.enum(['registry', 'guides'])).default([]),
    }),
    labels: z
      .object({
        operation: z.string().default('Operation'),
        operations: z.string().default('Operations'),
      })
      .prefault({}),
    capabilities: z
      .object({
        registry: z.boolean().default(false),
        targets: z.boolean().default(false),
        attestation: z.boolean().default(false),
        configTransform: z.boolean().default(false),
      })
      .prefault({}),
    connection: z.object({
      schema: jsonSchema,
      ui: z.record(z.string(), UiHintSchema).default({}),
      /** Setup instructions shown on the Connection page (Markdown). */
      help: z.string().optional(),
    }),
    sensitiveKeys: z.array(z.string().min(1)).default([]),
    network: z.object({ hosts: z.array(z.string()).default([]) }).prefault({}),
    matchProfiles: z.record(z.string(), z.array(MatchFieldSchema)).default({}),
    /** Required with `capabilities.targets`. */
    targets: TargetsSchema.optional(),
  })
  .superRefine((m, ctx) => {
    if ((RESERVED_NAMESPACES as readonly string[]).includes(m.binding.namespace)) {
      ctx.addIssue({
        code: 'custom',
        path: ['binding', 'namespace'],
        message: `"${m.binding.namespace}" is reserved by core`,
      });
    }
    if (m.binding.searchApis.includes('registry') && !m.capabilities.registry) {
      ctx.addIssue({
        code: 'custom',
        path: ['binding', 'searchApis'],
        message: 'registry requires capabilities.registry',
      });
    }
    if (m.binding.searchApis.includes('guides') && !m.capabilities.attestation) {
      ctx.addIssue({
        code: 'custom',
        path: ['binding', 'searchApis'],
        message: 'guides requires capabilities.attestation',
      });
    }
    const properties = m.connection.schema.properties;
    const fieldNames = new Set(
      typeof properties === 'object' && properties !== null ? Object.keys(properties as object) : [],
    );
    for (const [name, hint] of Object.entries(m.connection.ui)) {
      if (!fieldNames.has(name)) {
        ctx.addIssue({ code: 'custom', path: ['connection', 'ui', name], message: 'no such connection field' });
      }
      if (hint.showWhen && (hint.showWhen.field === name || !fieldNames.has(hint.showWhen.field))) {
        ctx.addIssue({
          code: 'custom',
          path: ['connection', 'ui', name, 'showWhen', 'field'],
          message: 'must reference another connection field',
        });
      }
    }
    // Rule pickers can be served to non-admins (core §6.4); `optionsFor` can't tell the two callers apart.
    const formSources = new Set(
      Object.values(m.connection.ui)
        .map((h) => h.optionsSource)
        .filter(Boolean),
    );
    for (const [profile, fields] of Object.entries(m.matchProfiles)) {
      fields.forEach((f, i) => {
        if (f.optionsSource && formSources.has(f.optionsSource)) {
          ctx.addIssue({
            code: 'custom',
            path: ['matchProfiles', profile, i, 'optionsSource'],
            message: 'also feeds the connection form; use a separate source for rule pickers',
          });
        }
      });
    }
    if (m.capabilities.targets && !m.targets) {
      ctx.addIssue({
        code: 'custom',
        path: ['targets'],
        message: 'capabilities.targets requires a targets declaration',
      });
    }
    if (m.targets && !m.capabilities.targets) {
      ctx.addIssue({ code: 'custom', path: ['targets'], message: 'targets requires capabilities.targets' });
    }
    const declared = new Set(m.targets?.scopes.map((s) => s.key) ?? []);
    if (m.targets && declared.size !== m.targets.scopes.length) {
      ctx.addIssue({ code: 'custom', path: ['targets', 'scopes'], message: 'scope keys must be unique' });
    }
    for (const [profile, fields] of Object.entries(m.matchProfiles)) {
      fields.forEach((f, i) => {
        if (f.field !== '$targets') return;
        if (!m.capabilities.targets) {
          ctx.addIssue({
            code: 'custom',
            path: ['matchProfiles', profile],
            message: '$targets match fields require capabilities.targets',
          });
          return;
        }
        const options = TargetFieldOptionsSchema.safeParse(f.options ?? {});
        if (!options.success) return;
        const keys = [...(options.data.scopes ?? []), ...Object.keys(options.data.filter ?? {})];
        for (const key of keys.filter((k) => !declared.has(k))) {
          ctx.addIssue({
            code: 'custom',
            path: ['matchProfiles', profile, i, 'options'],
            message: `scope "${key}" is not declared in targets.scopes`,
          });
        }
      });
    }
  });
export type Manifest = z.infer<typeof ManifestSchema>;

/** Parses and validates a manifest. Throws a `ZodError` describing every problem found. */
export function parseManifest(input: unknown): Manifest {
  return ManifestSchema.parse(input);
}

/** Whether a manifest's `sdk` range accepts the contract version implemented by core. */
export function isSdkCompatible(manifest: Pick<Manifest, 'sdk'>, sdkVersion: string = SDK_VERSION): boolean {
  return semver.satisfies(sdkVersion, manifest.sdk);
}
