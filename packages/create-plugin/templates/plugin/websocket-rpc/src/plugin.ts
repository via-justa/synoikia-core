import {
  baseKey,
  compileRules,
  definePlugin,
  ErrorCodes,
  isPlainObject,
  parsePluginSettings,
  PluginError,
  requireString,
  staticCatalog,
  stringOr,
  truncate,
} from '@synoikia/plugin-sdk';
import type { PluginHandlers } from '@synoikia/plugin-sdk';
import raw from '../plugin.yaml';
import { authHeaders } from './auth.js';
import { RpcClient } from './client.js';

/** The {{name}} plugin: JSON-RPC methods declared in plugin.yaml; the sandbox calls
 * `{{namespace}}.call(method, params)`. */

const SERVICE = '{{name}}';

export const settings = parsePluginSettings(raw, {
  parse(value) {
    const p = isPlainObject(value) ? value : {};
    if (typeof p.path !== 'string') throw new Error('plugin.yaml plugin.path must be a string');
    return { path: p.path };
  },
});

export function create{{Pascal}}Plugin(): PluginHandlers {
  return definePlugin({
    connect: (init) =>
      new RpcClient({
        baseUrl: requireString(init.config, 'baseUrl'),
        path: settings.plugin.path,
        verifyTls: init.config.verifyTls !== false,
        headers: authHeaders(init),
        timeoutMs: settings.defaults.timeouts.request,
      }),
    close: (client) => client.close(),

    async version(kit) {
      const info = await kit.client().call('system.info', {});
      const version = isPlainObject(info) ? stringOr(info.version) : undefined;
      if (!version) throw new PluginError(ErrorCodes.UpstreamError, `${SERVICE} reported no version`);
      return version;
    },

    handlers(kit) {
      const rules = compileRules(settings, {
        // Confirmation lookups may only call declared reads.
        lookup: (op, args, timeoutMs) => {
          if (settings.operations.find((o) => o.key === op)?.classification !== 'read')
            throw new PluginError(ErrorCodes.InvalidParams, `plugin.yaml lookup ${op} is not a read`);
          return kit.client().call(op, args[0] ?? {}, timeoutMs);
        },
      });
      const operations = staticCatalog(rules);
      const known = new Set(settings.operations.map((o) => o.key));
      return {
        async syncCatalog() {
          return { upstreamVersion: await kit.version(), operations };
        },

        resolveOperation({ fn, args }) {
          if (fn !== 'call')
            throw new PluginError(ErrorCodes.UnknownOperation, `{{namespace}}.${fn} is not a binding function`);
          const [method, params] = args;
          if (typeof method !== 'string' || !known.has(method))
            throw new PluginError(ErrorCodes.UnknownOperation, `${String(method)} is not a ${SERVICE} method`);
          if (params !== undefined && !isPlainObject(params))
            throw new PluginError(ErrorCodes.InvalidParams, 'params must be an object');
          // A split twin declared in plugin.yaml is locked; take it unless code here decides the call is safe.
          const split = rules.splits(method)[0];
          return { key: split ? `${method}#${split}` : method, params: params ?? {} };
        },

        async summarize({ key, params, targets }) {
          const json = JSON.stringify(params ?? {});
          const notes = rules.summaryNotes(key).map((n) => ` ${n}`).join('');
          const text = `${SERVICE} ${key}(${json === '{}' ? '' : truncate(json, 400)})${notes}`;
          const literal = await rules.confirmLiteral({ key, params, targets });
          return literal ? { text, confirmLiteral: literal } : { text };
        },

        async invoke({ key, params, context }) {
          const method = baseKey(key);
          if (!known.has(method)) throw new PluginError(ErrorCodes.UnknownOperation, `${method} is not a ${SERVICE} method`);
          // Core masks the result's declared secrets (plugin.yaml `sensitiveResult`).
          return kit.client().call(method, params, kit.timeout(context));
        },
      };
    },
  });
}
