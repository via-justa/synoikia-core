import {
  buildOpenApiCatalog,
  compileRules,
  definePlugin,
  ErrorCodes,
  HttpJsonClient,
  isPlainObject,
  joinApiPath,
  parsePluginSettings,
  PluginError,
  requireString,
  restBinding,
  restLookup,
  stringOr,
} from '@synoikia/plugin-sdk';
import type { PluginHandlers } from '@synoikia/plugin-sdk';
import raw from '../plugin.yaml';
import { authHeaders } from './auth.js';

/** The {{name}} plugin: catalog from its OpenAPI spec; the sandbox calls
 * `{{namespace}}.request({ method, path, query, body })`. */

const SERVICE = '{{name}}';

export const settings = parsePluginSettings(raw, {
  parse(value) {
    const p = isPlainObject(value) ? value : {};
    const text = (key: string) => {
      if (typeof p[key] !== 'string') throw new Error(`plugin.yaml plugin.${key} must be a string`);
      return p[key];
    };
    return {
      apiPath: text('apiPath'),
      specPath: text('specPath'),
      versionPath: text('versionPath'),
      versionField: text('versionField'),
      minOperations: typeof p.minOperations === 'number' ? p.minOperations : 1,
    };
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
      const catalog = kit.lazy(async () => {
        const spec = await kit.client().request('GET', settings.plugin.specPath);
        if (typeof spec !== 'string' && !isPlainObject(spec))
          throw new PluginError(ErrorCodes.UpstreamError, `${SERVICE} served no OpenAPI spec`);
        return buildOpenApiCatalog(spec, { service: SERVICE, rules, minOperations: settings.plugin.minOperations });
      });
      const binding = restBinding({
        namespace: '{{namespace}}',
        service: SERVICE,
        rules,
        catalog: catalog.get,
        client: kit.client,
        stripPrefix: settings.plugin.apiPath,
      });
      return {
        async syncCatalog() {
          const upstreamVersion = await kit.version();
          return { upstreamVersion, operations: (await catalog.reload()).operations };
        },
        resolveOperation: binding.resolveOperation,
        summarize: binding.summarize,
        invoke: (params) => binding.invoke(params),
      };
    },
  });
}
