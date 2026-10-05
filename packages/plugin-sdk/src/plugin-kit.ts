import { ErrorCodes, PluginError } from './errors.js';
import type { InitParams, InvokeContext, PluginHandlers } from './rpc.js';

/** The lifecycle every plugin repeats: client per `init`, no calls before it, cache resets, close on
 * `shutdown`, `{ ok: false }` connection tests, upstream version and timeouts. */

export interface Lazy<T> {
  /** The cached value, loading it on first use (concurrent callers share one load). */
  get(): Promise<T>;
  /** The cached value if loaded, without loading it. */
  peek(): T | undefined;
  /** Loads again, replacing the cached value. */
  reload(): Promise<T>;
  /** Forgets the cached value. */
  reset(): void;
}

/** A value loaded once and cached until `reset` (`definePlugin` resets its own on every `init`). */
export function lazy<T>(load: () => Promise<T>): Lazy<T> {
  let value: { v: T } | undefined;
  let loading: Promise<T> | undefined;
  let generation = 0;
  const reload = () => {
    const gen = ++generation;
    const p = load().then((v) => {
      if (gen === generation) value = { v };
      return v;
    });
    loading = p;
    const clear = () => {
      if (loading === p) loading = undefined;
    };
    p.then(clear, clear);
    return p;
  };
  return {
    get: () => (value ? Promise.resolve(value.v) : (loading ?? reload())),
    peek: () => value?.v,
    reload,
    reset: () => {
      generation++;
      value = undefined;
      loading = undefined;
    },
  };
}

export interface PluginKit<C> {
  /** The client built by `connect`; throws INTERNAL before `init`. */
  client(): C;
  /** The current `init` params (config and secrets). Throws before `init`. */
  init(): InitParams;
  /** A cached value that is forgotten on every `init`. */
  lazy<T>(load: () => Promise<T>): Lazy<T>;
  /** Timeout for an upstream call from `invoke`: the sandbox budget left, at least one second. */
  timeout(context: InvokeContext): number;
  /** Runs `fn` after every successful `init`, e.g. to clear plugin-held state. */
  onInit(fn: () => void): void;
  /** The upstream's version (the definition's `version`). */
  version(): Promise<string>;
}

export interface PluginDefinition<C> {
  /** Validates the connection and builds the client. Called on every `init`. */
  connect(init: InitParams): C;
  /** Releases a client: called on re-`init` and `shutdown`. */
  close?(client: C): void | Promise<void>;
  /** The upstream's version string. Also used by the default `testConnection`. */
  version(kit: PluginKit<C>): Promise<string>;
  /** Runs before `version` in `testConnection`, e.g. a call that proves the credentials work. */
  probe?(kit: PluginKit<C>): Promise<void>;
  /** The remaining handlers. `init`, `shutdown`, `testConnection` and `getUpstreamVersion` are provided. */
  handlers(kit: PluginKit<C>): Omit<PluginHandlers, 'init' | 'shutdown' | 'testConnection' | 'getUpstreamVersion'>;
}

export function definePlugin<C>(def: PluginDefinition<C>): PluginHandlers {
  let current: { client: C; init: InitParams } | undefined;
  const caches: Lazy<unknown>[] = [];
  const hooks: (() => void)[] = [];
  const active = () => {
    if (!current) throw new PluginError(ErrorCodes.Internal, 'init has not been called');
    return current;
  };
  const kit: PluginKit<C> = {
    client: () => active().client,
    init: () => active().init,
    lazy: (load) => {
      const l = lazy(load);
      caches.push(l as Lazy<unknown>);
      return l;
    },
    timeout: (context) => Math.max(1000, context.deadlineMs),
    onInit: (fn) => hooks.push(fn),
    version: () => def.version(kit),
  };
  const handlers = def.handlers(kit);
  const close = async () => {
    const previous = current;
    current = undefined;
    if (previous) await def.close?.(previous.client);
  };
  const version = () => def.version(kit);
  return {
    ...handlers,
    async init(params) {
      const client = def.connect(params);
      await close();
      current = { client, init: params };
      for (const c of caches) c.reset();
      for (const fn of hooks) fn();
    },
    async testConnection() {
      try {
        await def.probe?.(kit);
        return { ok: true, upstreamVersion: await version() };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
    getUpstreamVersion: version,
    async shutdown() {
      await close();
    },
  };
}

/** A required non-empty string connection field, or INVALID_PARAMS "`<name>` is required". */
export function requireString(record: Record<string, unknown>, name: string): string {
  const v = record[name];
  if (typeof v !== 'string' || !v) throw new PluginError(ErrorCodes.InvalidParams, `${name} is required`);
  return v;
}

/** Shortens `text` to `max` characters, marking the cut with `…`. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** `fn()`, or undefined if it throws. For best-effort lookups in summaries. */
export async function tryOr<T>(fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/** A non-null, non-array object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A non-empty string, or a number as a string; otherwise undefined. */
export function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : undefined;
}
