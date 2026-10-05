import {
  compileRules,
  definePlugin,
  ErrorCodes,
  isPlainObject,
  parsePluginSettings,
  PluginError,
  requireString,
  staticCatalog,
  truncate,
} from '@synoikia/plugin-sdk';
import type { PluginHandlers } from '@synoikia/plugin-sdk';
import raw from '../plugin.yaml';
import { authHeaders } from './auth.js';

/**
 * The {{name}} plugin. The sandbox calls `{{namespace}}.call(operation, params)`. Fill in the client
 * (`connect`), the version, and `invoke`; operations and their rules live in plugin.yaml.
 */

const SERVICE = '{{name}}';

export const settings = parsePluginSettings(raw);

interface Client {
  baseUrl: string;
  headers: () => Record<string, string>;
}

export function create{{Pascal}}Plugin(): PluginHandlers {
  return definePlugin<Client>({
    // TODO: build a real client (HttpJsonClient for HTTP APIs, PendingRequests for socket protocols).
    connect: (init) => ({ baseUrl: requireString(init.config, 'baseUrl'), headers: authHeaders(init) }),

    // TODO: ask the upstream for its version.
    version: async () => '0.0.0',

    handlers(kit) {
      const rules = compileRules(settings);
      const operations = staticCatalog(rules);
      const known = new Set(settings.operations.map((o) => o.key));
      return {
        async syncCatalog() {
          return { upstreamVersion: await kit.version(), operations };
        },

        resolveOperation({ fn, args }) {
          if (fn !== 'call')
            throw new PluginError(ErrorCodes.UnknownOperation, `{{namespace}}.${fn} is not a binding function`);
          const [key, params] = args;
          if (typeof key !== 'string' || !known.has(key))
            throw new PluginError(ErrorCodes.UnknownOperation, `${String(key)} is not a ${SERVICE} operation`);
          if (params !== undefined && !isPlainObject(params))
            throw new PluginError(ErrorCodes.InvalidParams, 'params must be an object');
          // A split twin declared in plugin.yaml is locked; take it unless code here decides the call is safe.
          const split = rules.splits(key)[0];
          return { key: split ? `${key}#${split}` : key, params: params ?? {} };
        },

        async summarize({ key, params, targets }) {
          const json = JSON.stringify(params ?? {});
          const text = `${SERVICE} ${key}${json === '{}' ? '' : ` ${truncate(json, 400)}`}`;
          const literal = await rules.confirmLiteral({ key, params, targets });
          return literal ? { text, confirmLiteral: literal } : { text };
        },

        invoke({ key }) {
          // TODO: call the upstream with kit.client() and return its result. Core masks the secrets
          // plugin.yaml's `sensitiveResult` declares for this key.
          throw new PluginError(ErrorCodes.NotImplemented, `${key} is not implemented yet`);
        },
      };
    },
  });
}
