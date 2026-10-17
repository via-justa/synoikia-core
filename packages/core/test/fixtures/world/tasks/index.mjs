// The World's "Acme Tasks" plugin: speaks the JSON-RPC-over-IPC contract and calls the fake upstream over HTTP.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Flag files the World drops next to this file (the child may only read them): `down` stops every
// answer, `catalog-broken` fails the catalog sync, and a new `restart` value restarts the child once.
const flag = (name) => existsSync(path.join(HERE, name));
const flagValue = (name) => (flag(name) ? readFileSync(path.join(HERE, name), 'utf8') : '');

const op = (key, displayName, group, classification, extra = {}) => ({
  key,
  displayName,
  kind: 'method',
  group,
  classification,
  classificationReason: 'fixture',
  docs: { summary: `${displayName[0].toUpperCase()}${displayName.slice(1)}.` },
  ...extra,
});

const TASK_PARAMS = {
  type: 'object',
  properties: { list: { type: 'string' }, title: { type: 'string' } },
  required: ['list', 'title'],
};

const CATALOG = [
  op('lists.tasks', 'show the open tasks', 'lists', 'read', { matchProfile: 'list' }),
  op('lists.count', 'count the tasks', 'lists', 'read', { matchProfile: 'list' }),
  op('lists.share', 'show the share password', 'lists', 'read', { matchProfile: 'list' }),
  op('lists.rename', 'rename a list', 'lists', 'write', { kind: 'config', matchProfile: 'list' }),
  op('lists.archive', 'archive a list', 'lists', 'write', { typedConfirmation: true, matchProfile: 'list' }),
  op('lists.delete', 'delete a list', 'lists', 'write', { locked: true, matchProfile: 'list' }),
  op('tasks.add', 'add a task', 'tasks', 'write', { matchProfile: 'task', paramsSchema: TASK_PARAMS }),
  op('tasks.complete', 'complete a task', 'tasks', 'write', { matchProfile: 'task' }),
  op('tasks.import', 'import tasks', 'tasks', 'write', { attestationRequired: true, matchProfile: 'list' }),
];

let config = {};
let secrets = {};
const reply = (id, result) => process.send({ jsonrpc: '2.0', id, result: result ?? null });
const fail = (id, code, message) => process.send({ jsonrpc: '2.0', id, error: { code, message } });

async function upstream(method, path, body, headers = {}) {
  const res = await globalThis.fetch(`${config.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${secrets.token ?? ''}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status === 409) throw Object.assign(new Error('the list changed upstream'), { code: 'CONFIG_CONFLICT' });
  if (res.status === 403) throw Object.assign(new Error('insufficient permission'), { code: 'UPSTREAM_DENIED' });
  if (res.status === 404)
    throw Object.assign(new Error('not found upstream'), { code: 'UPSTREAM_ERROR', notFound: true });
  if (!res.ok)
    throw Object.assign(new Error(`upstream answered ${res.status}${text ? `: ${text}` : ''}`), {
      code: 'UPSTREAM_ERROR',
    });
  return text ? JSON.parse(text) : null;
}

const listPath = (name) => `/lists/${encodeURIComponent(name)}`;
/** Each call sends its call id, so the upstream can tell the calls apart. */
const callHeaders = (ctx) => (ctx.callId ? { 'x-call-id': ctx.callId } : {});
const openTasksWithIds = (list) => upstream('GET', `${listPath(list)}/tasks?status=open&with=ids`);

const INVOKE = {
  'lists.tasks': (p, ctx) => upstream('GET', `${listPath(p.list)}/tasks?status=open`, undefined, callHeaders(ctx)),
  'lists.count': async (p, ctx) => ({
    open: (await upstream('GET', `${listPath(p.list)}/tasks?status=open`, undefined, callHeaders(ctx))).length,
  }),
  'lists.share': (p, ctx) => upstream('GET', `${listPath(p.list)}/share`, undefined, callHeaders(ctx)),
  'lists.rename': (p, ctx) =>
    upstream(
      'PUT',
      listPath(p.list),
      { name: p.name, ...(p.sharePassword === undefined ? {} : { sharePassword: p.sharePassword }) },
      { 'if-match': ctx.expectedHash, ...callHeaders(ctx) },
    ),
  'lists.archive': (p, ctx) => upstream('POST', `${listPath(p.list)}/archive`, undefined, callHeaders(ctx)),
  'lists.delete': (p, ctx) => upstream('DELETE', listPath(p.list), undefined, callHeaders(ctx)),
  'tasks.add': (p, ctx) => upstream('POST', `${listPath(p.list)}/tasks`, { title: p.title }, callHeaders(ctx)),
  // Completes exactly the tasks core approved, by their ids.
  'tasks.complete': async (_p, ctx) => {
    const done = [];
    for (const t of ctx.targets ?? []) {
      if (t.kind !== 'task') continue;
      await upstream('POST', `/tasks/${encodeURIComponent(t.id)}/complete`, undefined, callHeaders(ctx));
      done.push(t.id);
    }
    return { completed: done };
  },
  'tasks.import': (p, ctx) => upstream('POST', `${listPath(p.list)}/import`, { tasks: p.tasks }, callHeaders(ctx)),
};

const summary = (key, p) => {
  const name = CATALOG.find((o) => o.key === key)?.displayName ?? key;
  return p.title ? `${name}: "${p.title}" in ${p.list}` : `${name}: ${p.list}`;
};

async function catalog() {
  if (flag('catalog-broken')) throw Object.assign(new Error('cannot read the catalog'), { code: 'UPSTREAM_ERROR' });
  const views = (await upstream('GET', '/views')) ?? [];
  return [...CATALOG, ...views.map((v) => op(`views.${v}`, `show the view ${v}`, 'views', 'read'))];
}

async function targetsOf(key, params) {
  if (typeof params?.list !== 'string') return [];
  try {
    if (key === 'tasks.complete') {
      const open = await openTasksWithIds(params.list);
      return open.filter((t) => t.title === params.title).map((t) => ({ kind: 'task', id: t.id, name: t.title }));
    }
    await upstream('GET', listPath(params.list));
  } catch (err) {
    if (err.notFound) throw Object.assign(new Error(`no list ${params.list}`), { code: 'TARGET_RESOLUTION_FAILED' });
    throw err;
  }
  return [{ kind: 'list', id: params.list, name: params.list }];
}

async function registry() {
  const out = [];
  for (const list of await upstream('GET', '/lists')) {
    out.push({ kind: 'list', id: list.name, name: list.name, attrs: { description: list.description ?? '' } });
    for (const t of await openTasksWithIds(list.name))
      out.push({ kind: 'task', id: t.id, name: t.title, parentId: list.name });
  }
  return out;
}

const handlers = {
  init(id, params) {
    config = params.config;
    secrets = params.secrets ?? {};
    reply(id);
  },
  testConnection: (id) => reply(id, { ok: true, upstreamVersion: '1.0' }),
  getUpstreamVersion: (id) => reply(id, '1.0'),
  syncCatalog: async (id) => reply(id, { upstreamVersion: '1.0', operations: await catalog() }),
  syncRegistry: async (id) => reply(id, await registry()),
  resolveOperation(id, { args }) {
    const [key, params = {}] = args;
    if (!CATALOG.some((o) => o.key === key) && !String(key).startsWith('views.'))
      return fail(id, 'UNKNOWN_OPERATION', `unknown operation: ${key}`);
    reply(id, { key, params });
  },
  resolveTargets: async (id, { key, params }) => reply(id, await targetsOf(key, params)),
  summarize: (id, { key, params }) =>
    reply(id, {
      text: summary(key, params ?? {}),
      ...(key === 'lists.archive' || key === 'lists.delete' ? { confirmLiteral: params.list } : {}),
    }),
  async prepareWrite(id, { params }) {
    const current = await upstream('GET', listPath(params.list));
    const diff = [{ path: '/name', before: current.name, after: params.name }];
    if (params.sharePassword !== undefined)
      diff.push({ path: '/sharePassword', before: current.sharePassword ?? null, after: params.sharePassword });
    reply(id, { params, diff, expectedHash: current.version });
  },
  async getGuide(id, { key }) {
    reply(id, await upstream('GET', `/guides/${encodeURIComponent(key)}`));
  },
  async invoke(id, { key, params, context }) {
    const run = INVOKE[key];
    if (key.startsWith('views.')) return reply(id, { view: key.slice('views.'.length) });
    if (!run) return fail(id, 'UNKNOWN_OPERATION', `unknown operation: ${key}`);
    reply(id, await run(params ?? {}, context ?? {}));
  },
  shutdown(id) {
    reply(id);
    setImmediate(() => process.exit(0));
  },
};

const restartSeen = flagValue('restart');
globalThis.setInterval(() => {
  if (flagValue('restart') !== restartSeen) process.exit(1);
}, 25);

process.on('message', (msg) => {
  if (flag('down')) process.exit(1);
  const handler = handlers[msg.method];
  if (!handler) return fail(msg.id, 'METHOD_NOT_FOUND', msg.method);
  Promise.resolve(handler(msg.id, msg.params)).catch((err) =>
    fail(msg.id, err.code ?? 'UPSTREAM_ERROR', String(err.message ?? err)),
  );
});
