import { z } from 'zod';

/**
 * Shapes a plugin returns over RPC. Core treats plugin output as untrusted and validates every
 * result against these schemas before using it (design §3.3).
 */

/**
 * Secrets in an operation's result that no key name gives away: the whole result (a generated token),
 * or the fields named `keys` in the result or each row of it, at any depth with `deep`. Core masks
 * them before anything else sees the result (design §5.5).
 */
export const SensitiveResultSchema = z.union([
  z.literal('whole'),
  z
    .object({
      keys: z.array(z.string().min(1).max(128)).min(1).max(32),
      deep: z.boolean().default(false),
    })
    .strict(),
]);
export type SensitiveResult = z.input<typeof SensitiveResultSchema>;

export const OperationDescriptorSchema = z.object({
  /** Stable catalog key, unique per instance: `widget.list`, `POST /orders`, `widget.set`. */
  key: z.string().min(1).max(512),
  displayName: z.string().optional(),
  /**
   * Plugin-defined kind: 'method' | 'rest' | 'service' | 'ws_command' … The kind `config` is reserved:
   * writes of that kind go through `prepareWrite` (diff + optimistic lock) when the plugin declares
   * `capabilities.configTransform`.
   */
  kind: z.string().min(1),
  /**
   * Access group: admins set one none/read/write level per group instead of toggling each operation
   * (design §5.2). Derived during discovery: a method namespace, an OpenAPI tag, a service domain.
   */
  group: z
    .string()
    .max(128)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, dots, dashes and underscores'),
  groupLabel: z.string().max(128).optional(),
  /** Free-form tag for filtering/display; not used for access. */
  tag: z.string().optional(),
  /** Read or write, from what the upstream API says. Core takes it as is; `locked` always makes it a write. */
  classification: z.enum(['read', 'write']),
  classificationReason: z.string().min(1),
  locked: z.boolean().default(false),
  /** Defaults to `locked` when omitted. */
  typedConfirmation: z.boolean().optional(),
  attestationRequired: z.boolean().default(false),
  /** Flags the operation for explicit admin review (e.g. a GET that acts, an unknown command). */
  needsReview: z.boolean().default(false),
  matchProfile: z.string().optional(),
  paramsSchema: z.record(z.string(), z.unknown()).optional(),
  /**
   * Params that hold a secret but have no key name for `sensitiveKeys` to catch, such as a positional
   * password: JSON-pointer paths into the params (`/1`, `/0/password`). Core replaces them with
   * `[REDACTED]` wherever params are shown or stored (summaries, approvals, notifications, audit); the
   * plugin's `invoke` still gets the real values.
   */
  sensitiveParams: z
    .array(z.string().regex(/^(\/[^/]{1,128}){1,8}$/, 'a JSON pointer such as /1 or /0/password'))
    .max(32)
    .optional(),
  /** Secrets in the result core masks before the result goes anywhere (needs contract 0.2.2). */
  sensitiveResult: SensitiveResultSchema.optional(),
  docs: z
    .object({
      summary: z.string().optional(),
      description: z.string().optional(),
      guidance: z.string().optional(),
    })
    .optional(),
});
export type OperationDescriptor = z.input<typeof OperationDescriptorSchema>;
export type ParsedOperationDescriptor = z.output<typeof OperationDescriptorSchema>;

export const SyncCatalogResultSchema = z.object({
  upstreamVersion: z.string(),
  /** Where the catalog came from, e.g. the version or git ref of the spec it was read from. */
  sourceRef: z.string().optional(),
  operations: z.array(OperationDescriptorSchema),
});
export type SyncCatalogResult = z.input<typeof SyncCatalogResultSchema>;

export const RegistryEntrySchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
  name: z.string(),
  parentId: z.string().optional(),
  /** Scope values of this entry (see the manifest's `targets.scopes`), used to filter pickers and `registry.find`. */
  scopes: z.record(z.string(), z.string()).optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

export const ResolvedTargetSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
  name: z.string(),
  /** The target's value for each scope declared in the manifest's `targets.scopes`, e.g. `{ zone: 'zone-a' }`. */
  scopes: z.record(z.string(), z.string()).default({}),
});
export type ResolvedTarget = z.input<typeof ResolvedTargetSchema>;

export const ResolveOperationResultSchema = z.object({
  key: z.string().min(1),
  params: z.unknown(),
});
export type ResolveOperationResult = z.infer<typeof ResolveOperationResultSchema>;

export const SummarizeResultSchema = z.object({
  text: z.string().min(1),
  /** Literal the approver must type for typed-confirmation operations. */
  confirmLiteral: z.string().min(1).optional(),
});
export type SummarizeResult = z.infer<typeof SummarizeResultSchema>;

export const PrepareWriteResultSchema = z.object({
  params: z.unknown(),
  diff: z.array(
    z.object({
      path: z.string(),
      before: z.unknown().optional(),
      after: z.unknown().optional(),
    }),
  ),
  expectedHash: z.string().min(1),
});
export type PrepareWriteResult = z.infer<typeof PrepareWriteResultSchema>;

export const TestConnectionResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  upstreamVersion: z.string().optional(),
});
export type TestConnectionResult = z.infer<typeof TestConnectionResultSchema>;

export const OptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type Option = z.infer<typeof OptionSchema>;

export const GuideSchema = z.object({
  version: z.string().min(1),
  content: z.string(),
});
export type Guide = z.infer<typeof GuideSchema>;
