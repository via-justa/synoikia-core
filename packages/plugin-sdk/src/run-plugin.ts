import semver from 'semver';
import { ErrorCodes, PluginError } from './errors.js';
import { RPC_METHODS, isRpcRequest } from './rpc.js';
import type { PluginHandlers, RpcNotification, RpcRequest, RpcResponse } from './rpc.js';
import { SENSITIVE_RESULT_SINCE } from './version.js';

type Catalog = { operations?: { key: string; sensitiveResult?: unknown }[] } | null | undefined;
const sensitiveKeys = (catalog: Catalog) =>
  new Set((catalog?.operations ?? []).filter((op) => op.sensitiveResult !== undefined).map((op) => op.key));

const olderCoreError = (core: unknown, keys: Iterable<string>) =>
  new PluginError(
    ErrorCodes.Internal,
    `This plugin declares result secrets (${[...keys].slice(0, 3).join(', ')}) that core masks from plugin contract ${SENSITIVE_RESULT_SINCE}; ` +
      `this core implements ${String(core)}. Upgrade Synoikia, or require ^${SENSITIVE_RESULT_SINCE} in manifest.sdk.`,
  );

/**
 * Builds the request dispatcher used by `runPlugin`. Exposed separately so plugins can unit-test
 * their handlers through the exact same error mapping core will see.
 */
export function createDispatcher(handlers: PluginHandlers): (req: RpcRequest) => Promise<RpcResponse> {
  // Core masks an operation's `sensitiveResult` itself from contract 0.2.2 (design §5.5), so the
  // bindings return raw results. An older core drops the field: fail closed there, whatever the
  // manifest's `sdk` range let through. Its catalog sync is refused, and so is any call to an
  // operation that declares result secrets (it may still serve a catalog synced before).
  let coreVersion: unknown;
  let olderCore = false;
  let sensitive: Promise<Set<string>> | undefined;
  const guard = async (method: string, params: unknown) => {
    if (method === 'init') {
      coreVersion = (params as { sdkVersion?: unknown } | null)?.sdkVersion;
      olderCore = !(
        typeof coreVersion === 'string' &&
        semver.valid(coreVersion) &&
        semver.gte(coreVersion, SENSITIVE_RESULT_SINCE)
      );
      sensitive = undefined;
    } else if (olderCore && method === 'invoke') {
      sensitive ??= Promise.resolve(handlers.syncCatalog()).then(sensitiveKeys);
      const keys = await sensitive.catch((err: unknown) => {
        sensitive = undefined;
        throw err;
      });
      const key = (params as { key?: unknown } | null)?.key;
      if (typeof key === 'string' && keys.has(key)) throw olderCoreError(coreVersion, [key]);
    }
  };
  const check = (method: string, result: unknown) => {
    if (!olderCore || method !== 'syncCatalog') return;
    const keys = sensitiveKeys(result as Catalog);
    sensitive = Promise.resolve(keys);
    if (keys.size) throw olderCoreError(coreVersion, keys);
  };
  return async (req) => {
    const method = req.method as (typeof RPC_METHODS)[number];
    const handler = RPC_METHODS.includes(method) ? handlers[method] : undefined;
    if (typeof handler !== 'function') {
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: ErrorCodes.MethodNotFound, message: `Method not supported: ${req.method}` },
      };
    }
    try {
      await guard(method, req.params);
      const result = await (handler as (params: unknown) => unknown).call(handlers, req.params);
      check(method, result);
      return { jsonrpc: '2.0', id: req.id, result: result ?? null };
    } catch (err) {
      if (err instanceof PluginError) {
        return { jsonrpc: '2.0', id: req.id, error: { code: err.code, message: err.message, data: err.data } };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { jsonrpc: '2.0', id: req.id, error: { code: ErrorCodes.Internal, message } };
    }
  };
}

/** Sends a notification (log line, catalogChanged) to core. No-op when not running under core. */
export function notify(notification: Omit<RpcNotification, 'jsonrpc'>): void {
  process.send?.({ jsonrpc: '2.0', ...notification });
}

/**
 * Entry point for a plugin child process. Core forks the plugin's `manifest.entry` with an IPC
 * channel; this wires incoming JSON-RPC requests to `handlers` and exits after `shutdown`.
 */
export function runPlugin(handlers: PluginHandlers): void {
  if (typeof process.send !== 'function') {
    throw new Error('runPlugin() must be started by the Synoikia core (no IPC channel)');
  }
  const dispatch = createDispatcher(handlers);
  process.on('message', (msg: unknown) => {
    if (!isRpcRequest(msg)) return;
    void dispatch(msg).then((res) => {
      process.send?.(res);
      if (msg.method === 'shutdown') process.exit(0);
    });
  });
  process.on('disconnect', () => process.exit(0));
}
