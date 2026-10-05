import { baseKey } from './catalog-helpers.js';
import { ErrorCodes, PluginError } from './errors.js';
import type { HttpJsonClient } from './http-client.js';
import { queryString } from './http-client.js';
import type { OperationDescriptor, ResolvedTarget, SummarizeResult } from './operations.js';
import { fillTemplate } from './openapi.js';
import type { RestParams } from './openapi.js';
import { isPlainObject, truncate } from './plugin-kit.js';
import type { InvokeContext } from './rpc.js';
import type { CompiledRules, StaticOperation } from './rules.js';

/** A catalog declared in `plugin.yaml` `operations:` for upstreams with nothing to discover. */

export interface StaticCatalogOptions {
  /** `classificationReason` prefix when an operation gives no `reason`: `declared:read`. */
  reasonPrefix?: string;
}

/** The descriptors of `settings.operations` (and their split twins), with rules applied. */
export function staticCatalog(rules: CompiledRules<unknown>, opts: StaticCatalogOptions = {}): OperationDescriptor[] {
  const prefix = opts.reasonPrefix ?? 'declared';
  return rules.settings.operations.flatMap((op) =>
    rules.describe({
      key: op.key,
      kind: op.kind,
      group: op.group,
      classification: op.classification,
      classificationReason: op.reason ?? `${prefix}:${op.classification}`,
      attestationRequired: op.attestation ?? false,
      ...(op.paramsSchema ? { paramsSchema: op.paramsSchema } : {}),
      docs: { summary: op.summary, ...(op.description ? { description: op.description } : {}) },
    }),
  );
}

export interface StaticHttpBindingOptions {
  /** Sandbox namespace and function: `acme.call(key, { path, query, body })`. */
  namespace: string;
  fn?: string;
  service: string;
  rules: CompiledRules<unknown>;
  client(): HttpJsonClient;
  /** When a call takes a split twin, by suffix; a declared twin without a predicate is always taken. */
  splitWhen?: Record<string, (key: string, params: RestParams) => boolean | Promise<boolean>>;
  maxSummaryBody?: number;
}

/** `resolveOperation`, `summarize` and `invoke` for `operations:` that declare an `http` request. */
export function staticHttpBinding(opts: StaticHttpBindingOptions) {
  const fn = opts.fn ?? 'call';
  const byKey = new Map<string, StaticOperation>(
    opts.rules.settings.operations.filter((op) => op.http).map((op) => [op.key, op]),
  );
  const find = (key: string) => {
    const op = byKey.get(baseKey(key));
    if (!op?.http) throw new PluginError(ErrorCodes.UnknownOperation, `${key} is not a ${opts.service} operation`);
    return op as StaticOperation & { http: NonNullable<StaticOperation['http']> };
  };
  const pathStrings = (path: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(path).map(([k, v]) => {
        if (typeof v !== 'string' && typeof v !== 'number')
          throw new PluginError(ErrorCodes.InvalidParams, `path.${k} must be a string or number`);
        return [k, String(v)];
      }),
    );
  const asParams = (raw: unknown): RestParams => {
    if (raw === undefined) return {};
    if (!isPlainObject(raw)) throw new PluginError(ErrorCodes.InvalidParams, 'params must be an object');
    const { path, query, body } = raw;
    if (path !== undefined && !isPlainObject(path))
      throw new PluginError(ErrorCodes.InvalidParams, 'path must be an object');
    if (query !== undefined && !isPlainObject(query))
      throw new PluginError(ErrorCodes.InvalidParams, 'query must be an object');
    return {
      ...(path && Object.keys(path).length ? { path: pathStrings(path) } : {}),
      ...(query && Object.keys(query).length ? { query } : {}),
      ...(body !== undefined ? { body } : {}),
    };
  };
  return {
    async resolveOperation({ fn: called, args }: { fn: string; args: unknown[] }) {
      if (called !== fn)
        throw new PluginError(ErrorCodes.UnknownOperation, `${opts.namespace}.${called} is not a binding function`);
      const [key, raw] = args;
      if (typeof key !== 'string' || !key || key.includes('#'))
        throw new PluginError(
          ErrorCodes.InvalidParams,
          `${opts.namespace}.${fn}(operation, params): operation must be a name`,
        );
      const op = find(key);
      const params = asParams(raw);
      if (op.http.method === 'GET') delete params.body;
      for (const suffix of opts.rules.splits(key)) {
        const when = opts.splitWhen?.[suffix];
        if (!when || (await when(key, params))) return { key: `${key}#${suffix}`, params };
      }
      return { key, params };
    },

    async summarize({
      key,
      params,
      targets,
    }: {
      key: string;
      params: unknown;
      targets: ResolvedTarget[];
    }): Promise<SummarizeResult> {
      const op = find(key);
      const p = (isPlainObject(params) ? params : {}) as RestParams;
      let path = op.http.path;
      try {
        path = fillTemplate(path, p.path ?? {});
      } catch {
        // keep the template
      }
      const body = p.body === undefined ? '' : JSON.stringify(p.body);
      const notes = opts.rules.summaryNotes(key);
      const text = `${opts.service} ${op.key}: ${op.http.method} ${path}${queryString(p.query)}${body ? ` ${truncate(body, opts.maxSummaryBody ?? 400)}` : ''}${notes.map((n) => ` ${n}`).join('')}`;
      const literal = await opts.rules.confirmLiteral({ key, params: p, targets });
      return literal ? { text, confirmLiteral: literal } : { text };
    },

    async invoke({ key, params, context }: { key: string; params: unknown; context: InvokeContext }) {
      const op = find(key);
      const p = (isPlainObject(params) ? params : {}) as RestParams;
      let path: string;
      try {
        path = fillTemplate(op.http.path, p.path ?? {});
      } catch (err) {
        throw new PluginError(ErrorCodes.InvalidParams, (err as Error).message);
      }
      // Declared secrets in the result (`sensitiveResult`) are masked by core, from the descriptor.
      return opts.client().request(op.http.method, path, {
        query: p.query,
        body: p.body,
        timeoutMs: Math.max(1000, context.deadlineMs),
      });
    },
  };
}
