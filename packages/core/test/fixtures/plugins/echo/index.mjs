// Self-contained test plugin: speaks the JSON-RPC-over-IPC contract without importing the SDK,
// because under the permission model it may only read its own directory.
import fs from 'node:fs';

const op = (key, classification, extra = {}) => ({
  key,
  kind: 'method',
  group: 'echo',
  classification,
  classificationReason: 'fixture',
  ...extra,
});
const CATALOG = [
  op('echo.query', 'read', { docs: { summary: 'Echoes the query back.' } }),
  op('echo.set', 'write', { matchProfile: 'name-prefix', sensitiveParams: ['/pin'] }),
  op('echo.delete', 'write', { locked: true }),
  op('echo.nolit', 'write', { locked: true }),
  op('echo.guided', 'write', { attestationRequired: true }),
];

let config = {};
let resolutions = 0;
let secrets = {};
const reply = (id, result) => process.send({ jsonrpc: '2.0', id, result: result ?? null });
const fail = (id, code, message) => process.send({ jsonrpc: '2.0', id, error: { code, message } });

const handlers = {
  init(id, params) {
    config = params.config;
    secrets = params.secrets;
    if (config.mode === 'crash-init') process.exit(3);
    if (config.mode === 'fail-init') return fail(id, 'UPSTREAM_ERROR', 'cannot reach upstream');
    if (config.mode === 'hang-init') return;
    // An upstream error that echoes the credential back (as some APIs do).
    if (config.mode === 'leak-init') return fail(id, 'UPSTREAM_ERROR', `401 for token ${secrets.token}`);
    reply(id);
  },
  testConnection: (id) => reply(id, { ok: true, upstreamVersion: '1.0' }),
  getUpstreamVersion: (id) => reply(id, config.version ?? '1.0'),
  syncCatalog(id) {
    if (config.mode === 'bad-output') return reply(id, { upstreamVersion: '1.0', operations: 'nope' });
    if (config.mode === 'leak-sync') return fail(id, 'UPSTREAM_ERROR', `sync refused for ${secrets.token}`);
    reply(id, { upstreamVersion: config.version ?? '1.0', operations: CATALOG });
  },
  resolveOperation(id, { args }) {
    const [key, params = {}] = args;
    if (!CATALOG.some((o) => o.key === key)) return fail(id, 'UNKNOWN_OPERATION', `unknown operation: ${key}`);
    reply(id, { key, params });
  },
  // `drift: true` resolves to a different entity every time, like an area whose members change.
  resolveTargets(id, { params }) {
    if (!params?.drift) return reply(id, []);
    resolutions++;
    reply(id, [{ kind: 'entity', id: `widget.e${resolutions}`, name: `Widget ${resolutions}`, scopes: {} }]);
  },
  summarize(id, { key, params }) {
    const confirmLiteral = key === 'echo.delete' ? params.name : undefined;
    reply(id, { text: `${key} ${JSON.stringify(params)}`, ...(confirmLiteral ? { confirmLiteral } : {}) });
  },
  getGuide: (id) => reply(id, { version: 'v1', content: 'Read me first.' }),
  // An option whose label and meta carry the connection secret, as a careless plugin might.
  optionsFor: (id, { query }) =>
    reply(id, [{ value: 'a', label: `A ${secrets.token ?? ''} ${query ?? ''}`, meta: { token: 'meta-secret' } }]),
  invoke(id, { key, params, context }) {
    const tryFs = (fn) => {
      try {
        fn();
        return 'ok';
      } catch (e) {
        return e.code;
      }
    };
    if (params.action === 'context') return reply(id, context);
    // The upstream was upgraded while the plugin kept running (mid-session version recheck).
    if (params.action === 'set-version') {
      config = { ...config, version: params.version };
      return reply(id, config.version);
    }
    switch (params.action) {
      case 'env':
        return reply(id, Object.keys(process.env).sort());
      case 'secrets':
        return reply(id, Object.keys(secrets));
      case 'read-own':
        return reply(
          id,
          tryFs(() => fs.readFileSync(new URL('./manifest.json', import.meta.url))),
        );
      case 'read':
        return reply(
          id,
          tryFs(() => fs.readFileSync(params.path)),
        );
      case 'write':
        return reply(
          id,
          tryFs(() => fs.writeFileSync(new URL('./written.txt', import.meta.url), 'x')),
        );
      case 'crash':
        return process.exit(1);
      case 'hang':
        return;
      case 'upstream-denied':
        return fail(id, 'UPSTREAM_DENIED', 'insufficient permission');
      case 'upstream-echo':
        // An upstream error that quotes the request back, as many APIs do.
        return fail(id, 'UPSTREAM_ERROR', `upstream rejected: ${params.text}`);
      default:
        return reply(id, key.startsWith('echo.') ? { key, params, password: 'hunter2' } : params);
    }
  },
  shutdown(id) {
    reply(id);
    setImmediate(() => process.exit(0));
  },
};

process.on('message', (msg) => {
  const handler = handlers[msg.method];
  if (!handler) return fail(msg.id, 'METHOD_NOT_FOUND', msg.method);
  handler(msg.id, msg.params);
});
