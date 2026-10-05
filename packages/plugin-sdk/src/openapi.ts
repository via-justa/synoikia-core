import { parse } from 'yaml';
import { baseKey, toGroup } from './catalog-helpers.js';
import { ErrorCodes, PluginError } from './errors.js';
import type { HttpJsonClient } from './http-client.js';
import { queryString } from './http-client.js';
import type { OperationDescriptor, ResolvedTarget, SummarizeResult } from './operations.js';
import { isPlainObject, truncate } from './plugin-kit.js';
import type { InvokeContext } from './rpc.js';
import type { CompiledRules, OperationDraft } from './rules.js';

/** A catalog and `request({ method, path, query, body })` binding from an OpenAPI 3 spec (design §3.3).
 * Keys are verb + path template; GET reads, other verbs write, action-like GETs are writes for review. */

export const HTTP_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const isParam = (segment: string) => segment.startsWith('{') && segment.endsWith('}');
export type HttpVerb = (typeof HTTP_VERBS)[number];

/** Summary/description words that suggest a GET changes something. */
export const DEFAULT_ACTION_WORDS =
  /\b(reset\w*|regenerat\w*|sync\w*|flush\w*|run|runs|cancel\w*|invok\w*|delet\w*|remov\w*|clear\w*|restart\w*|reboot\w*|shut\s?down\w*|purg\w*|refresh\w*|trigger\w*|start\w*|stop\w*|log\s?out\w*|execut\w*|appl(y|ies)|rotat\w*|revok\w*)\b/i;

/** Path words suggesting a GET changes something (`/cache/flush`), checked since specs may say nothing. */
export const DEFAULT_PATH_ACTION_WORDS =
  /^(reset|regenerate|sync|flush|run|cancel|invoke|delete|remove|clear|restart|reboot|shutdown|purge|refresh|scan|test|trigger|start|stop|logout|execute|apply|rotate|revoke|enable|disable|import|install|upgrade)$/i;

export class SpecError extends Error {}

export interface OpenApiOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown[];
  requestBody?: unknown;
}

export interface RestOperation {
  key: string;
  method: HttpVerb;
  template: string;
  /** Template segments; `{name}` marks a path parameter. */
  segments: string[];
}

export interface OpenApiCatalog {
  operations: OperationDescriptor[];
  /** Operations by verb, most specific template first (literal segments beat `{params}`). */
  byVerb: Map<HttpVerb, RestOperation[]>;
}

export interface OpenApiCatalogOptions {
  /** The upstream's name in errors ("The Seerr API spec …"). */
  service: string;
  rules: CompiledRules<unknown>;
  /** Refuse a catalog smaller than this: an empty or truncated spec must not replace a real one. */
  minOperations?: number;
  /** GET-as-action heuristic on the summary, description and query parameter text; `null` turns it off. */
  actionWords?: RegExp | null;
  /** GET-as-action heuristic on the words of each literal path segment; `null` turns it off. */
  pathActionWords?: RegExp | null;
  /** Group used for operations without a tag. */
  defaultGroup?: string;
}

/** Parses (if text) and validates the spec; throws `SpecError` rather than returning a partial catalog. */
export function parseOpenApi(spec: string | Record<string, unknown>, service?: string): Record<string, unknown> {
  const name = service ? `${service} API spec` : 'API spec';
  let doc: unknown = spec;
  if (typeof spec === 'string') {
    try {
      // JSON is YAML too. The alias cap stops billion-laughs expansion.
      doc = parse(spec, { maxAliasCount: 100 });
    } catch {
      throw new SpecError(`The ${name} is not valid YAML`);
    }
  }
  if (!isPlainObject(doc)) throw new SpecError(`The ${name} is empty`);
  if (typeof doc.openapi !== 'string' || !/^3\.[01]\./.test(doc.openapi))
    throw new SpecError(`The ${name} is not OpenAPI 3.0`);
  if (!isPlainObject(doc.paths)) throw new SpecError(`The ${name} has no paths`);
  return doc;
}

const MAX_SCHEMA_DEPTH = 6;
const MAX_NESTING = 64;

/** How many schema nodes one catalog build may produce: a spec with huge `$ref` fan-out is refused, not expanded. */
export interface RefBudget {
  left: number;
}
export const DEFAULT_REF_BUDGET = 500_000;

/** Resolves local `$ref`s, cutting cycles and deep nesting, within `budget` (else `SpecError`). */
export function resolveRefs(
  spec: Record<string, unknown>,
  value: unknown,
  depth = 0,
  seen: string[] = [],
  budget: RefBudget = { left: DEFAULT_REF_BUDGET },
  nesting = 0,
): unknown {
  if (--budget.left < 0) throw new SpecError('The API spec expands to too many schema nodes');
  if (nesting > MAX_NESTING) return { description: 'Nested too deeply' };
  if (Array.isArray(value)) return value.map((v) => resolveRefs(spec, v, depth, seen, budget, nesting + 1));
  if (!value || typeof value !== 'object') return value;
  const ref = (value as { $ref?: unknown }).$ref;
  if (typeof ref === 'string') {
    if (!ref.startsWith('#/') || seen.includes(ref) || depth >= MAX_SCHEMA_DEPTH) return { description: `See ${ref}` };
    let target: unknown = spec;
    for (const part of ref.slice(2).split('/')) {
      target = isPlainObject(target) && Object.hasOwn(target, part) ? target[part] : undefined;
    }
    return target === undefined
      ? { description: `See ${ref}` }
      : resolveRefs(spec, target, depth + 1, [...seen, ref], budget, nesting + 1);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value))
    Object.defineProperty(out, k, {
      value: resolveRefs(spec, v, depth, seen, budget, nesting + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return out;
}

/** `{ path, query, body }`, the shape the binding produces, as one JSON schema. */
function paramsSchema(spec: Record<string, unknown>, pathParams: unknown[], op: OpenApiOperation, budget: RefBudget) {
  const groups: Record<'path' | 'query', { properties: Record<string, unknown>; required: string[] }> = {
    path: { properties: {}, required: [] },
    query: { properties: {}, required: [] },
  };
  for (const raw of [...pathParams, ...(op.parameters ?? [])]) {
    const p = resolveRefs(spec, raw, 0, [], budget) as {
      name?: unknown;
      in?: unknown;
      required?: unknown;
      schema?: unknown;
      description?: unknown;
    };
    if (typeof p.name !== 'string' || (p.in !== 'path' && p.in !== 'query')) continue;
    const g = groups[p.in];
    g.properties[p.name] = {
      ...(p.schema as object),
      ...(typeof p.description === 'string' ? { description: p.description } : {}),
    };
    if (p.required === true && !g.required.includes(p.name)) g.required.push(p.name);
  }
  const properties: Record<string, unknown> = {};
  for (const [name, g] of Object.entries(groups)) {
    if (Object.keys(g.properties).length)
      properties[name] = {
        type: 'object',
        properties: g.properties,
        ...(g.required.length ? { required: g.required } : {}),
      };
  }
  const body = resolveRefs(spec, op.requestBody, 0, [], budget) as
    { content?: Record<string, { schema?: unknown }> } | undefined;
  const bodySchema = body?.content?.['application/json']?.schema;
  if (bodySchema) properties.body = bodySchema;
  return Object.keys(properties).length ? { type: 'object', properties } : undefined;
}

/** The text the GET-as-action heuristic reads: summary, description and query parameter descriptions. */
export function actionText(
  spec: Record<string, unknown>,
  pathParams: unknown[],
  op: OpenApiOperation,
  budget?: RefBudget,
): string {
  const params = [...pathParams, ...(op.parameters ?? [])]
    .map((raw) => resolveRefs(spec, raw, 0, [], budget) as { in?: unknown; description?: unknown })
    .filter((p) => p.in === 'query' && typeof p.description === 'string')
    .map((p) => p.description as string);
  return [op.summary ?? '', op.description ?? '', ...params].join(' ');
}

/** The heuristic draft classification of one operation, before rules apply. */
export function classifyRest(
  key: string,
  text: string,
  actionWords: RegExp | null = DEFAULT_ACTION_WORDS,
  pathActionWords: RegExp | null = DEFAULT_PATH_ACTION_WORDS,
): Pick<OperationDraft, 'classification' | 'classificationReason' | 'needsReview'> {
  const [method, template = ''] = key.split(' ');
  if (method === 'GET') {
    const pathWords = template
      .split('/')
      .filter((s) => s && !isParam(s))
      .flatMap((s) => s.split(/[-_.]/));
    if (actionWords?.test(text) || (pathActionWords && pathWords.some((w) => pathActionWords.test(w))))
      return { classification: 'write', classificationReason: 'heuristic:get-as-action', needsReview: true };
    return { classification: 'read', classificationReason: 'verb:GET', needsReview: false };
  }
  return { classification: 'write', classificationReason: `verb:${method}`, needsReview: false };
}

/** Literal segments beat `{params}`, compared left to right. */
function bySpecificity(a: RestOperation, b: RestOperation): number {
  for (let i = 0; i < Math.min(a.segments.length, b.segments.length); i++) {
    const pa = isParam(a.segments[i]!);
    const pb = isParam(b.segments[i]!);
    if (pa !== pb) return pa ? 1 : -1;
  }
  return 0;
}

/** Builds the catalog; throws `SpecError` for an invalid or tiny spec, or one with indistinguishable
 * templates (`/user/{id}`, `/user/{userId}/`) that could route around a lock. */
export function buildOpenApiCatalog(
  specText: string | Record<string, unknown>,
  opts: OpenApiCatalogOptions,
): OpenApiCatalog {
  const spec = parseOpenApi(specText, opts.service);
  const actionWords = opts.actionWords === undefined ? DEFAULT_ACTION_WORDS : opts.actionWords;
  const pathActionWords = opts.pathActionWords === undefined ? DEFAULT_PATH_ACTION_WORDS : opts.pathActionWords;
  const budget: RefBudget = { left: DEFAULT_REF_BUDGET };
  const shapes = new Map<string, string>();
  const operations: OperationDescriptor[] = [];
  const byVerb = new Map<HttpVerb, RestOperation[]>(HTTP_VERBS.map((v) => [v, []]));
  for (const [template, item] of Object.entries(spec.paths as Record<string, unknown>)) {
    if (!isPlainObject(item) || !/^\/[A-Za-z0-9_\-./{}]*$/.test(template)) continue;
    const segments = template.split('/').filter(Boolean);
    if (segments.some((s) => s === '.' || s === '..')) continue;
    const pathLevel = Array.isArray(item.parameters) ? (item.parameters as unknown[]) : [];
    for (const [verb, rawOp] of Object.entries(item)) {
      const method = verb.toUpperCase() as HttpVerb;
      if (!HTTP_VERBS.includes(method) || !isPlainObject(rawOp)) continue;
      const op = rawOp as OpenApiOperation;
      const key = `${method} ${template}`;
      if (opts.rules.excluded(key)) continue;
      const shape = `${method} /${segments.map((s) => (isParam(s) ? '{}' : s)).join('/')}`;
      const twin = shapes.get(shape);
      if (twin) throw new SpecError(`The ${opts.service} API spec has two operations for ${shape}: ${twin} and ${key}`);
      shapes.set(shape, key);
      const schema = paramsSchema(spec, pathLevel, op, budget);
      const summary = op.summary?.trim().slice(0, 500);
      const description = op.description?.trim().slice(0, 2000);
      operations.push(
        ...opts.rules.describe({
          key,
          kind: 'rest',
          group: toGroup(
            Array.isArray(op.tags) && typeof op.tags[0] === 'string' ? op.tags[0] : '',
            opts.defaultGroup ?? 'other',
          ),
          ...classifyRest(key, actionText(spec, pathLevel, op, budget), actionWords, pathActionWords),
          ...(schema ? { paramsSchema: schema } : {}),
          ...(summary || description
            ? { docs: { ...(summary ? { summary } : {}), ...(description ? { description } : {}) } }
            : {}),
        }),
      );
      byVerb.get(method)!.push({ key, method, template, segments });
    }
  }
  const min = opts.minOperations ?? 1;
  if (operations.length < min)
    throw new SpecError(
      `The ${opts.service} API spec has only ${operations.length} operations; refusing a partial catalog`,
    );
  for (const list of byVerb.values()) list.sort(bySpecificity);
  return { operations: operations.sort((a, b) => a.key.localeCompare(b.key)), byVerb };
}

/** Matches a concrete path against the catalog: the operation and its path params, or undefined. */
export function matchPath(
  catalog: OpenApiCatalog,
  method: string,
  rawPath: string,
  stripPrefix?: string,
): { op: RestOperation; pathParams: Record<string, string> } | undefined {
  const ops = catalog.byVerb.get(method.toUpperCase() as HttpVerb);
  if (!ops) return undefined;
  let path = rawPath.split('?')[0]!;
  if (stripPrefix && (path === stripPrefix || path.startsWith(`${stripPrefix}/`)))
    path = path.slice(stripPrefix.length) || '/';
  if (!path.startsWith('/')) return undefined;
  const parts = path.split('/').slice(1);
  if (parts.length && parts.at(-1) === '') parts.pop(); // trailing slash
  let decoded: string[];
  try {
    decoded = parts.map((p) => decodeURIComponent(p));
  } catch {
    return undefined;
  }
  if (decoded.some((p) => p === '' || p === '.' || p === '..' || p.includes('/'))) return undefined;
  for (const op of ops) {
    if (op.segments.length !== decoded.length) continue;
    const pathParams: Record<string, string> = {};
    const ok = op.segments.every((seg, i) => {
      if (isParam(seg)) {
        Object.defineProperty(pathParams, seg.slice(1, -1), {
          value: decoded[i]!,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        return true;
      }
      return seg === decoded[i];
    });
    if (ok) return { op, pathParams };
  }
  return undefined;
}

/** Fills a template from path parameters (each value URL-encoded). Throws `SpecError` for a missing one. */
export function fillTemplate(template: string, pathParams: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = Object.hasOwn(pathParams, name) ? pathParams[name] : undefined;
    if (value === undefined || value === null || value === '') throw new SpecError(`Missing path parameter ${name}`);
    if (typeof value === 'object') throw new SpecError(`Path parameter ${name} must be a string or number`);
    const text = String(value);
    // `encodeURIComponent` keeps dots, and a `.` or `..` segment would make the URL resolve elsewhere.
    if (text === '.' || text === '..') throw new SpecError(`Path parameter ${name} cannot be ${text}`);
    return encodeURIComponent(text);
  });
}

/** Params of a REST operation, as the binding produces them. */
export interface RestParams {
  path?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
}

export interface RestCall {
  key: string;
  method: HttpVerb;
  template: string;
  params: RestParams;
  /** The `request(...)` argument as the sandbox passed it. */
  request: Record<string, unknown>;
}

export interface RestBindingOptions {
  /** Sandbox namespace and function: `seerr.request(...)`. */
  namespace: string;
  fn?: string;
  /** The upstream's name in summaries and errors. */
  service: string;
  rules: CompiledRules<unknown>;
  catalog(): Promise<OpenApiCatalog>;
  client(): HttpJsonClient;
  /** A path prefix the model may include and that is dropped (`/api/v1`). */
  stripPrefix?: string;
  /** Adjusts params after matching (e.g. make an implicit default explicit). */
  adjust?(call: RestCall): RestParams;
  /** When a call takes a split twin, by suffix; a twin without a predicate is always taken. */
  splitWhen?: Record<string, (call: RestCall) => boolean | Promise<boolean>>;
  /** Longest body shown in a summary. Default 400. */
  maxSummaryBody?: number;
}

export interface RestBinding {
  resolveOperation(params: { fn: string; args: unknown[] }): Promise<{ key: string; params: RestParams }>;
  summarize(params: { key: string; params: unknown; targets: ResolvedTarget[] }): Promise<SummarizeResult>;
  invoke(params: { key: string; params: unknown; context: InvokeContext }, timeoutMs?: number): Promise<unknown>;
}

/** `resolveOperation`, `summarize` and `invoke` for a REST catalog. */
export function restBinding(opts: RestBindingOptions): RestBinding {
  const fn = opts.fn ?? 'request';
  const maxBody = opts.maxSummaryBody ?? 400;
  const split = (key: string, method: string, template: string) => {
    const [m, t] = baseKey(key).split(' ') as [string, string];
    return { method: m || method, template: t || template };
  };
  return {
    async resolveOperation({ fn: called, args }) {
      if (called !== fn)
        throw new PluginError(ErrorCodes.UnknownOperation, `${opts.namespace}.${called} is not a binding function`);
      const [req] = args;
      if (!isPlainObject(req))
        throw new PluginError(
          ErrorCodes.InvalidParams,
          `${opts.namespace}.${fn}({ method, path, query, body }) takes one object`,
        );
      const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET';
      if (!(HTTP_VERBS as readonly string[]).includes(method))
        throw new PluginError(ErrorCodes.InvalidParams, `Unsupported HTTP method ${String(req.method)}`);
      if (typeof req.path !== 'string' || !req.path.startsWith('/'))
        throw new PluginError(ErrorCodes.InvalidParams, 'path must be a string starting with /');
      if (req.path.includes('?') || req.path.includes('#'))
        throw new PluginError(ErrorCodes.InvalidParams, 'Pass query parameters in `query`, not in the path');
      if (req.query !== undefined && !isPlainObject(req.query))
        throw new PluginError(ErrorCodes.InvalidParams, 'query must be an object');
      const match = matchPath(await opts.catalog(), method, req.path, opts.stripPrefix);
      if (!match)
        throw new PluginError(
          ErrorCodes.UnknownOperation,
          `${method} ${req.path} is not a ${opts.service} API operation`,
        );
      const params: RestParams = {
        ...(Object.keys(match.pathParams).length ? { path: match.pathParams } : {}),
        ...(isPlainObject(req.query) && Object.keys(req.query).length ? { query: req.query } : {}),
        ...(req.body !== undefined && method !== 'GET' ? { body: req.body } : {}),
      };
      const call: RestCall = {
        key: match.op.key,
        method: match.op.method,
        template: match.op.template,
        params,
        request: req,
      };
      call.params = opts.adjust?.(call) ?? params;
      for (const suffix of opts.rules.splits(call.key)) {
        const when = opts.splitWhen?.[suffix];
        if (!when || (await when(call))) return { key: `${call.key}#${suffix}`, params: call.params };
      }
      return { key: call.key, params: call.params };
    },

    async summarize({ key, params, targets }) {
      const p = (isPlainObject(params) ? params : {}) as RestParams;
      const { method, template } = split(key, '', '');
      let path = template;
      try {
        path = fillTemplate(template, p.path ?? {});
      } catch {
        // keep the template
      }
      const body = p.body === undefined ? '' : JSON.stringify(p.body);
      const notes = opts.rules.summaryNotes(key);
      const text = `${opts.service} ${method} ${path}${queryString(p.query)}${body ? ` ${truncate(body, maxBody)}` : ''}${notes.map((n) => ` ${n}`).join('')}`;
      const literal = await opts.rules.confirmLiteral({ key, params: p, targets });
      return literal ? { text, confirmLiteral: literal } : { text };
    },

    async invoke({ key, params, context }, timeoutMs) {
      const p = (isPlainObject(params) ? params : {}) as RestParams;
      const { method, template } = split(key, '', '');
      const known = await opts.catalog();
      if (!known.byVerb.get(method as HttpVerb)?.some((op) => op.template === template))
        throw new PluginError(ErrorCodes.UnknownOperation, `${baseKey(key)} is not a ${opts.service} API operation`);
      let path: string;
      try {
        path = fillTemplate(template, p.path ?? {});
      } catch (err) {
        throw new PluginError(ErrorCodes.InvalidParams, (err as Error).message);
      }
      // Declared secrets in the result (`sensitiveResult`) are masked by core, from the descriptor.
      return opts.client().request(method, path, {
        query: p.query,
        body: p.body,
        timeoutMs: timeoutMs ?? Math.max(1000, context.deadlineMs),
      });
    },
  };
}

/** A `lookup` hook for `compileRules` on REST: GETs only, so a confirmation lookup changes nothing. */
export function restLookup(client: () => HttpJsonClient) {
  return async (op: string, args: unknown[], timeoutMs: number): Promise<unknown> => {
    const [method, template] = op.split(' ') as [string, string | undefined];
    if (method !== 'GET' || !template?.startsWith('/'))
      throw new PluginError(ErrorCodes.InvalidParams, `plugin.yaml lookup ${op}: only GET /path lookups are allowed`);
    const pathParams = isPlainObject(args[0]) ? args[0] : {};
    return client().request('GET', fillTemplate(template, pathParams), { timeoutMs });
  };
}

export interface FetchSpecOptions {
  service: string;
  /** Tried in order; a 404 moves on to the next, any other failure stops. */
  candidates: { url: string; ref: string }[];
  maxBytes?: number;
  timeoutMs?: number;
}

/** Downloads a spec by the instance's version tag, then a fallback branch; no credentials sent. */
export async function fetchSpec(opts: FetchSpecOptions): Promise<{ text: string; ref: string }> {
  const name = `${opts.service} API spec`;
  for (const { url, ref } of opts.candidates) {
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
    } catch {
      throw new PluginError(ErrorCodes.UpstreamError, `Could not fetch the ${name} from ${new URL(url).host}`);
    }
    if (res.ok) {
      const max = opts.maxBytes ?? 5 * 1024 * 1024;
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = res.body?.getReader();
      for (;;) {
        const chunk = reader ? await reader.read() : { done: true as const, value: undefined };
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > max) {
          await reader?.cancel();
          throw new PluginError(ErrorCodes.UpstreamError, `The ${name} is too large`);
        }
        chunks.push(chunk.value);
      }
      return { text: Buffer.concat(chunks).toString('utf8'), ref };
    }
    await res.body?.cancel();
    if (res.status !== 404)
      throw new PluginError(ErrorCodes.UpstreamError, `Fetching the ${name} failed: HTTP ${res.status}`);
  }
  throw new PluginError(
    ErrorCodes.UpstreamError,
    `No ${name} found for ${opts.candidates.map((c) => c.ref).join(' or ')}`,
  );
}
