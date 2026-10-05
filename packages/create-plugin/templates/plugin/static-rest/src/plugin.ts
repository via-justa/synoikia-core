import {
  compileRules,
  definePlugin,
  ErrorCodes,
  HttpJsonClient,
  isPlainObject,
  joinApiPath,
  parsePluginSettings,
  PluginError,
  requireString,
  restLookup,
  staticCatalog,
  staticHttpBinding,
  stringOr,
} from '@synoikia/plugin-sdk';
import type { PluginHandlers } from '@synoikia/plugin-sdk';
import raw from '../plugin.yaml';
import { authHeaders } from './auth.js';

/** The {{name}} plugin: operations declared in plugin.yaml; the sandbox calls
 * `{{namespace}}.call(operation, { path, query, body })`. */

const SERVICE = '{{name}}';

export const settings = parsePluginSettings(raw, {
  parse(value) {
    const p = isPlainObject(value) ? value : {};
    const text = (key: string) => {
      if (typeof p[key] !== 'string') throw new Error(`plugin.yaml plugin.${key} must be a string`);
      return p[key];
    };
    return { apiPath: text('apiPath'), versionPath: text('versionPath'), versionField: text('versionField') };
  },
});

export function create{{Pascal}}Plugin(): PluginHandlers {
  return definePlugin({
    connect: (init) =>
      new HttpJsonClient({
        baseUrl: joinApiPath(requireString(init.config, 'baseUrl'), settings.plugin.apiPath),
        service: SERVICE,
        verifyTls: init.config.verifyTls !== false,
        headers: authHeaders(init),
        timeoutMs: settings.defaults.timeouts.request,
      }),

    async version(kit) {
      const status = await kit.client().request('GET', settings.plugin.versionPath);
      const version = isPlainObject(status) ? stringOr(status[settings.plugin.versionField]) : undefined;
      if (!version) throw new PluginError(ErrorCodes.UpstreamError, `${SERVICE} reported no version`);
      return version;
    },

    handlers(kit) {
      const rules = compileRules(settings, { lookup: restLookup(kit.client) });
      const operations = staticCatalog(rules);
      const binding = staticHttpBinding({ namespace: '{{namespace}}', service: SERVICE, rules, client: kit.client });
      return {
        async syncCatalog() {
          return { upstreamVersion: await kit.version(), operations };
        },
        resolveOperation: binding.resolveOperation,
        summarize: binding.summarize,
        invoke: binding.invoke,
      };
    },
  });
}
