import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { After, QuickPickleWorld, setWorldConstructor } from 'quickpickle';
import { createAppContext } from '../../src/app.js';
import type { AppContext } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { startServers } from '../../src/server.js';
import type { RunningServers } from '../../src/server.js';
import { startFakeHttp } from '../../src/testing/index.js';
import type { FakeHttp, FakeRequest } from '../../src/testing/index.js';
import { browser } from '../../test/admin-client.js';

const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/world');
const ADMIN = { username: 'admin', password: 'world admin passphrase' };
/** The upstream's API token, stored as the instance's secret. */
export const API_TOKEN = 'acme-tok-9f8e7d6c'; // gitleaks:allow (the fake upstream's test token)

/** The World's operations by the names the feature files use. */
export const OPERATIONS: Record<string, string> = {
  'show the open tasks': 'lists.tasks',
  'count the tasks': 'lists.count',
  'show the share password': 'lists.share',
  'rename a list': 'lists.rename',
  'archive a list': 'lists.archive',
  'delete a list': 'lists.delete',
  'add a task': 'tasks.add',
  'complete a task': 'tasks.complete',
  'import tasks': 'tasks.import',
};

export const opKey = (name: string) => {
  const key = OPERATIONS[name];
  if (!key) throw new Error(`The World has no operation "${name}"`);
  return key;
};

type Task = { title: string; done: boolean };
type Portal = ReturnType<typeof browser>;
export type Access = 'read' | 'write';

interface Agent {
  token: string;
  /** The user whose credential this is: "admin" or "user 12". */
  owner: string;
  client?: Client;
  transport?: StreamableHTTPClientTransport;
}

/** What an agent's app was asked to show: a page link (`url`) or an in-session form (`form`). */
export interface Prompt {
  mode: 'url' | 'form';
  message: string;
  url?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `check` until it holds, for at most `ms`. */
export async function eventually(check: () => boolean | Promise<boolean>, what: string, ms = 5000) {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

interface Person {
  id: string;
  username: string;
  password: string;
  portal?: Portal;
}

/** A fresh Synoikia for each scenario: core on real listeners, its admin, and the fake "Acme Tasks" upstream. */
export class SynoikiaWorld extends QuickPickleWorld {
  dataDir = '';
  ctx?: AppContext;
  servers?: RunningServers;
  upstream?: FakeHttp;
  /** The upstream's lists, by name. */
  lists = new Map<string, Task[]>();
  archived = new Set<string>();
  sharePasswords = new Map<string, string>();
  descriptions = new Map<string, string>();
  /** Acme's best-practice guides, by operation key. */
  guides = new Map<string, { version: string; content: string }>([
    ['tasks.import', { version: '1', content: 'Import at most 100 tasks at once, one title for each line.' }],
  ]);
  /** Acme's saved views; each one is a read in the catalog. */
  views: string[] = [];
  /** How Acme misbehaves: refuses every request, or answers with an error that quotes the API token. */
  upstreamFault?: 'denied' | 'leaky';
  /** How long Acme takes to answer a request about the tasks of a list. */
  upstreamDelayMs = 0;
  /** Sessions an agent left behind when it opened a new one. */
  oldClients: Client[] = [];
  admin!: Portal;
  adminBase = '';
  mcpBase = '';
  instances = new Map<string, string>();
  lastInstance = '';
  agents = new Map<string, Agent>();
  people = new Map<string, Person>();
  roles = new Map<string, string>();
  /** What the last agent call returned; `refused` holds the message when the instance refused the credential. */
  answer: Record<string, unknown> = {};
  /** What the last refused portal change answered. */
  portalAnswer: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };

  async init() {
    await super.init();
    this.upstream = await startFakeHttp({ routes: this.upstreamRoutes(), guard: (req) => this.guardUpstream(req) });
    this.dataDir = mkdtempSync(path.join(tmpdir(), 'synoikia-world-'));
    cpSync(PLUGINS, path.join(this.dataDir, 'plugins'), { recursive: true });
    this.ctx = await createAppContext(
      loadConfig({
        DATA_DIR: this.dataDir,
        MCP_HOST: '127.0.0.1',
        MCP_PORT: '0',
        ADMIN_HOST: '127.0.0.1',
        ADMIN_PORT: '0',
        ADMIN_BOOTSTRAP_USERNAME: ADMIN.username,
        ADMIN_BOOTSTRAP_PASSWORD: ADMIN.password,
      }),
    );
    await this.ctx.start();
    this.servers = await startServers(this.ctx);
    this.adminBase = `http://127.0.0.1:${this.servers.admin.port}`;
    this.mcpBase = `http://127.0.0.1:${this.servers.mcp.port}`;
    this.admin = await this.portal(ADMIN.username, ADMIN.password);
    const me = await this.expectOk(this.admin.get('/api/profile'), 'read profile');
    this.people.set('admin', { id: me.id as string, ...ADMIN, portal: this.admin });
  }

  async stop() {
    for (const agent of this.agents.values()) await agent.client?.close().catch(() => undefined);
    for (const client of this.oldClients) await client.close().catch(() => undefined);
    await this.servers?.close();
    await this.ctx?.stop();
    await this.upstream?.close();
    if (this.dataDir) rmSync(this.dataDir, { recursive: true, force: true });
  }

  // ── the fake "Acme Tasks" upstream ──

  private guardUpstream(req: FakeRequest) {
    if (req.headers.authorization !== `Bearer ${API_TOKEN}`) return { status: 401 };
    if (this.upstreamFault === 'denied') return { status: 403 };
    if (this.upstreamFault === 'leaky') return { status: 500, body: `token ${API_TOKEN} is not valid for this list` };
    return undefined;
  }

  private listVersion(name: string) {
    return createHash('sha256')
      .update(JSON.stringify([name, this.lists.get(name)]))
      .digest('hex')
      .slice(0, 16);
  }

  private upstreamRoutes() {
    const live = (name: string) => (this.archived.has(name) ? undefined : this.lists.get(name));
    const missing = { status: 404 };
    const slow = async () => {
      if (this.upstreamDelayMs) await sleep(this.upstreamDelayMs);
    };
    return {
      'GET /lists': () => ({
        body: [...this.lists.keys()]
          .filter((name) => !this.archived.has(name))
          .map((name) => ({ name, description: this.descriptions.get(name) ?? '' })),
      }),
      'GET /lists/{name}': (req: FakeRequest) => {
        const name = req.params.name!;
        return live(name)
          ? { body: { name, version: this.listVersion(name), sharePassword: this.sharePasswords.get(name) ?? null } }
          : missing;
      },
      'GET /lists/{name}/tasks': async (req: FakeRequest) => {
        const name = req.params.name!;
        const tasks = live(name);
        if (!tasks) return missing;
        if (req.query.get('with') === 'ids')
          return {
            body: tasks.flatMap((t, i) => (t.done ? [] : [{ id: `${name}#${i}`, title: t.title }])),
          };
        await slow();
        return { body: tasks.filter((t) => !t.done) };
      },
      'POST /lists/{name}/tasks': async (req: FakeRequest) => {
        const tasks = live(req.params.name!);
        if (!tasks) return missing;
        await slow();
        const task = { title: String((req.body as { title?: unknown }).title), done: false };
        tasks.push(task);
        return { status: 201, body: task };
      },
      'POST /tasks/{id}/complete': (req: FakeRequest) => {
        const id = req.params.id!;
        const at = id.lastIndexOf('#');
        const task = live(id.slice(0, at))?.[Number(id.slice(at + 1))];
        if (!task || task.done) return missing;
        task.done = true;
        return { body: task };
      },
      'PUT /lists/{name}': (req: FakeRequest) => {
        const name = req.params.name!;
        const tasks = live(name);
        if (!tasks) return missing;
        if (req.headers['if-match'] !== this.listVersion(name)) return { status: 409 };
        const body = req.body as { name?: unknown; sharePassword?: unknown };
        const to = String(body.name);
        const password = typeof body.sharePassword === 'string' ? body.sharePassword : this.sharePasswords.get(name);
        this.lists.delete(name);
        this.sharePasswords.delete(name);
        this.lists.set(to, tasks);
        if (password !== undefined) this.sharePasswords.set(to, password);
        return { body: { name: to } };
      },
      'POST /lists/{name}/archive': (req: FakeRequest) => {
        const name = req.params.name!;
        if (!live(name)) return missing;
        this.archived.add(name);
        return { body: { name, archived: true } };
      },
      'DELETE /lists/{name}': (req: FakeRequest) =>
        this.lists.delete(req.params.name!) ? { body: { deleted: req.params.name } } : missing,
      'POST /lists/{name}/import': (req: FakeRequest) => {
        const tasks = live(req.params.name!);
        if (!tasks) return missing;
        const titles = (req.body as { tasks?: unknown[] }).tasks ?? [];
        for (const title of titles) tasks.push({ title: String(title), done: false });
        return { body: { imported: titles.length } };
      },
      'GET /lists/{name}/share': (req: FakeRequest) => {
        const name = req.params.name!;
        if (!live(name)) return missing;
        return { body: { list: name, password: this.sharePasswords.get(name) ?? null } };
      },
      'GET /guides/{key}': (req: FakeRequest) => {
        const guide = this.guides.get(req.params.key!);
        return guide ? { body: guide } : missing;
      },
      'GET /views': () => ({ body: this.views }),
    };
  }

  /** What Acme received for one route, such as `POST /lists/Groceries/tasks`. */
  upstreamRequests(method: string, pathname: string) {
    return this.upstream!.requests.filter((r) => r.method === method && r.path === pathname);
  }

  // ── the World's "Acme Tasks" plugin on disk ──

  pluginFile(name: string) {
    return path.join(this.dataDir, 'plugins', 'tasks', name);
  }

  /** Drops a flag file the fixture plugin reads: `down`, `restart` or `catalog-broken`. */
  pluginFlag(name: 'down' | 'restart' | 'catalog-broken', value = '') {
    writeFileSync(this.pluginFile(name), value);
  }

  /** Changes the plugin's manifest on disk; `rescan` makes core read it again. */
  async editManifest(change: (m: Record<string, unknown>) => void, rescan = true) {
    const file = this.pluginFile('manifest.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    change(manifest);
    writeFileSync(file, JSON.stringify(manifest, null, 2));
    if (rescan) await this.expectOk(this.admin.post('/api/plugins/rescan'), 'rescan plugins');
  }

  /** Restarts the plugin child of `slug` the way a crash does, and waits until it serves again. */
  async restartPlugin(slug: string) {
    const id = await this.tasksInstance(slug);
    const status = async () =>
      (await this.expectOk(this.admin.get(`/api/instances/${id}`), 'read instance')).status as string;
    this.pluginFlag('restart', String(Date.now()));
    await eventually(async () => (await status()) !== 'ready', 'the plugin to stop');
    await eventually(async () => (await status()) === 'ready', 'the plugin to be ready');
  }

  // ── the admin portal and the Admin API ──

  async expectOk(res: Promise<Response>, what: string) {
    const r = await res;
    if (!r.ok) throw new Error(`${what}: ${r.status} ${await r.text()}`);
    return (await r.json().catch(() => undefined)) as Record<string, unknown>;
  }

  /** Keeps a refused portal change for the Then step; fails if the change went through. */
  async expectRefused(res: Promise<Response>, what: string) {
    const r = await res;
    if (r.ok) throw new Error(`${what}: expected a refusal, got ${r.status}`);
    this.portalAnswer = { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  }

  /** A portal session in its own browser, signed in with a password. */
  async portal(username: string, password: string) {
    const page = browser({ request: (p, init) => fetch(`${this.adminBase}${String(p)}`, init) });
    await page.init();
    await this.expectOk(page.post('/auth/login', { username, password }), `sign in as ${username}`);
    return page;
  }

  /** The instance "slug" of the World's "Acme Tasks" plugin, created and synced through the Admin API. */
  async tasksInstance(slug: string) {
    const known = this.instances.get(slug);
    if (known) return known;
    const plugins = (await this.expectOk(this.admin.get('/api/plugins'), 'list plugins')) as unknown as {
      id: string;
      pluginId: string;
    }[];
    const plugin = plugins.find((p) => p.pluginId === 'tasks')!;
    await this.expectOk(this.admin.patch(`/api/plugins/${plugin.id}`, { enabled: true }), 'enable plugin');
    const created = await this.expectOk(
      this.admin.post('/api/instances', {
        pluginId: 'tasks',
        slug,
        connection: { url: this.upstream!.url, token: API_TOKEN },
      }),
      'create instance',
    );
    const id = created.id as string;
    await this.expectOk(this.admin.post(`/api/instances/${id}/sync`), 'sync instance');
    this.instances.set(slug, id);
    this.lastInstance = slug;
    return id;
  }

  /** Changes instance settings through the Admin API; core restarts the plugin child with them. */
  async instanceSettings(slug: string, settings: Record<string, unknown>) {
    const id = await this.tasksInstance(slug);
    await this.expectOk(this.admin.patch(`/api/instances/${id}`, { settings }), 'change instance settings');
  }

  async sync(slug: string) {
    const id = await this.tasksInstance(slug);
    await this.expectOk(this.admin.post(`/api/instances/${id}/sync`), 'sync instance');
  }

  async setGroupLevel(slug: string, group: string, level: string) {
    const id = await this.tasksInstance(slug);
    await this.expectOk(this.admin.patch(`/api/instances/${id}/groups/${group}`, { level }), 'set group level');
  }

  /** The instance's operations as the admin sees them. */
  async operations(slug: string) {
    const id = await this.tasksInstance(slug);
    return (await this.expectOk(this.admin.get(`/api/instances/${id}/operations`), 'list operations')) as unknown as {
      id: string;
      key: string;
      levelOverride: string | null;
      level: string;
      allowedLevels: string[];
      writeAcknowledged: boolean;
    }[];
  }

  async operation(slug: string, name: string) {
    const key = opKey(name);
    const op = (await this.operations(slug)).find((o) => o.key === key);
    if (!op) throw new Error(`No operation ${key} on ${slug}`);
    return op;
  }

  async groups(slug: string) {
    const id = await this.tasksInstance(slug);
    return (await this.expectOk(this.admin.get(`/api/instances/${id}/groups`), 'list groups')) as unknown as {
      key: string;
      level: string;
      counts: { pendingReview: number };
    }[];
  }

  /** The admin's own level for one operation; `expect: 'refused'` keeps the refusal instead. */
  async setOperationLevel(slug: string, name: string, level: string | null, expect: 'ok' | 'refused' = 'ok') {
    const id = await this.tasksInstance(slug);
    const op = await this.operation(slug, name);
    const res = this.admin.patch(`/api/instances/${id}/operations/${op.id}`, { level });
    if (expect === 'refused') await this.expectRefused(res, 'set operation level');
    else await this.expectOk(res, 'set operation level');
  }

  async acknowledge(slug: string, name: string, acknowledged: boolean) {
    const id = await this.tasksInstance(slug);
    const op = await this.operation(slug, name);
    await this.expectOk(
      this.admin.patch(`/api/instances/${id}/operations/${op.id}`, { acknowledged }),
      'set acknowledgement',
    );
  }

  async audit(query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString();
    return (await this.expectOk(this.admin.get(`/api/audit?${qs}`), 'read audit')).rows as {
      decision: string;
      operationKey: string | null;
      detail: Record<string, unknown> | null;
    }[];
  }

  // ── roles, users and their own levels ──

  async role(name: string) {
    const known = this.roles.get(name);
    if (known) return known;
    const created = await this.expectOk(this.admin.post('/api/roles', { name }), 'create role');
    this.roles.set(name, created.id as string);
    return created.id as string;
  }

  async setRoleInstances(roleName: string, slugs: string[]) {
    const role = await this.role(roleName);
    const instanceIds = await Promise.all(slugs.map((s) => this.tasksInstance(s)));
    await this.expectOk(this.admin.put(`/api/roles/${role}/instances`, { instanceIds }), 'set role instances');
  }

  async setRoleSwitches(roleName: string, slug: string, switches: Record<string, boolean>) {
    const role = await this.role(roleName);
    const id = await this.tasksInstance(slug);
    await this.expectOk(this.admin.patch(`/api/roles/${role}/endpoints/${id}`, switches), 'set role switches');
  }

  /** A role maximum for a group (`{ group }`) or an operation (`{ op }`); null clears it. */
  async setRoleMaximum(
    roleName: string,
    slug: string,
    target: { group: string } | { op: string },
    level: string | null,
  ) {
    const role = await this.role(roleName);
    const id = await this.tasksInstance(slug);
    const where =
      'group' in target ? `groups/${target.group}` : `operations/${(await this.operation(slug, target.op)).id}`;
    await this.expectOk(this.admin.put(`/api/roles/${role}/endpoints/${id}/${where}`, { level }), 'set role maximum');
  }

  /** A user with a password, signed in to the portal in their own browser. */
  async user(person: string, roleName: string) {
    const known = this.people.get(person);
    if (known) return known;
    const roleId = await this.role(roleName);
    const username = person.replace(/\s+/g, '');
    const password = `${username} world passphrase`;
    const created = await this.expectOk(this.admin.post('/api/users', { username, password, roleId }), 'create user');
    const portal = await this.portal(username, password);
    const p = { id: created.id as string, username, password, portal };
    this.people.set(person, p);
    return p;
  }

  person(name: string) {
    const p = this.people.get(name);
    if (!p) throw new Error(`The World has no person "${name}" yet`);
    return p;
  }

  /** A user's own level for one operation, set in their own portal session. */
  async setOwnLevel(person: string, slug: string, name: string, level: string | null, expect: 'ok' | 'refused' = 'ok') {
    const id = await this.tasksInstance(slug);
    const op = await this.operation(slug, name);
    const res = this.person(person).portal!.put(`/api/me/endpoints/${id}/operations/${op.id}`, { level });
    if (expect === 'refused') await this.expectRefused(res, 'set own level');
    else await this.expectOk(res, 'set own level');
  }

  // ── agents ──

  /** A new credential of `owner` for the agent; without `access`, it takes what the portal offers first. */
  async credential(agent: string, owner: string, access?: Access, name = `agent ${agent}`) {
    const portal = this.person(owner).portal!;
    const created = await this.expectOk(
      portal.post('/api/me/tokens', { name, scope: ['*'], ...(access ? { access } : {}) }),
      'create token',
    );
    await this.agents
      .get(agent)
      ?.client?.close()
      .catch(() => undefined);
    this.agents.set(agent, { token: created.token as string, owner });
  }

  /** An MCP session of the agent on the instance, kept open for later calls. */
  async session(agent: string, slug: string) {
    const a = this.agents.get(agent);
    if (!a) throw new Error(`The World has no agent ${agent} yet`);
    if (a.client) return a.client;
    return this.connect(agent, slug);
  }

  /** A fresh MCP session of the agent; with `prompts`, its app can show approval prompts of that kind. */
  async connect(
    agent: string,
    slug: string,
    prompts?: { mode: 'url' | 'form'; answer: (p: Prompt) => Promise<'accept' | 'decline'> },
  ) {
    const a = this.agents.get(agent);
    if (!a) throw new Error(`The World has no agent ${agent} yet`);
    if (a.client) this.oldClients.push(a.client);
    const capabilities = prompts ? { elicitation: prompts.mode === 'url' ? { url: {} } : { form: {} } } : {};
    const client = new Client({ name: `agent ${agent}`, version: '1.0.0' }, { capabilities });
    if (prompts)
      client.setRequestHandler(ElicitRequestSchema, async (req) => {
        const p = req.params as { mode?: string; message: string; url?: string };
        const action = await prompts.answer({
          mode: p.mode === 'url' ? 'url' : 'form',
          message: p.message,
          url: p.url,
        });
        return action === 'accept' && p.mode !== 'url' ? { action, content: {} } : { action };
      });
    const url = new URL(`${this.mcpBase}/${slug}`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${a.token}` } },
    });
    await client.connect(transport);
    a.client = client;
    a.transport = transport;
    return client;
  }

  /** The id of the agent's current MCP session. */
  sessionId(agent: string) {
    return this.agents.get(agent)?.transport?.sessionId;
  }

  /** Runs `code` with `execute`; `signal` cancels the agent's request. */
  async execute(agent: string, slug: string, code: string, signal?: AbortSignal) {
    try {
      const client = await this.session(agent, slug);
      const res = (await client.callTool({ name: 'execute', arguments: { code } }, undefined, { signal })) as {
        content: { text: string }[];
      };
      this.answer = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    } catch (err) {
      this.answer = { refused: err instanceof Error ? err.message : String(err) };
    }
  }

  async search(agent: string, slug: string, code: string) {
    const client = await this.session(agent, slug);
    const res = (await client.callTool({ name: 'search', arguments: { code } })) as { content: { text: string }[] };
    this.answer = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
  }

  /** The agent reads the guide of an operation in its session, and gets the best-practice key back. */
  async readGuide(agent: string, name: string) {
    await this.search(agent, this.lastInstance, `return await guides.get(${JSON.stringify(opKey(name))});`);
    return (this.answer.result as { best_practice_key?: string } | undefined)?.best_practice_key;
  }

  /** The agent calls one operation by name with these params, and gets its result back. */
  async call(agent: string, name: string, params: Record<string, unknown>) {
    await this.execute(
      agent,
      this.lastInstance,
      `return await tasks.call(${JSON.stringify(opKey(name))}, ${JSON.stringify(params)});`,
    );
  }

  async resume(agent: string, executionId: string) {
    const client = await this.session(agent, this.lastInstance);
    const res = (await client.callTool({ name: 'resume', arguments: { executionId } })) as {
      content: { text: string }[];
    };
    this.answer = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
  }

  // ── the approval page ──

  /** The approval page of the last parked call (or of `url`), in a fresh browser that signs in as `person`. */
  async approvalPage(person: string, url?: string) {
    const link = url ?? (this.answer.approval as { url: string } | undefined)?.url;
    if (!link) throw new Error(`No approval to open: ${JSON.stringify(this.answer)}`);
    const pagePath = new URL(link, this.mcpBase).pathname;
    const jar = new Map<string, string>();
    const send = async (p: string, form?: Record<string, string>) => {
      const res = await fetch(`${this.mcpBase}${p}`, {
        method: form ? 'POST' : 'GET',
        redirect: 'manual',
        headers: {
          cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: form ? new URLSearchParams(form).toString() : undefined,
      });
      for (const sc of res.headers.getSetCookie()) {
        const pair = sc.split(';')[0]!;
        const eq = pair.indexOf('=');
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      return res;
    };
    const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
    const { username, password } = this.person(person);
    const login = await (await send(pagePath)).text();
    await send('/oauth/login', { csrf: csrfOf(login), continue: pagePath, username, password });
    const html = await (await send(pagePath)).text();
    return {
      html,
      decide: async (decision: 'approve' | 'deny' | 'approve_session', confirm?: string) => {
        const res = await send(pagePath, {
          csrf: csrfOf(html),
          decision,
          ...(confirm ? { confirm } : {}),
          ...(decision === 'approve_session' ? { grant: '1' } : {}),
        });
        if (!res.ok) throw new Error(`decide: ${res.status} ${await res.text()}`);
      },
    };
  }

  /** `person` approves the agent's parked call on the approval page, and the agent resumes it. */
  async approveAndResume(agent: string, person: string, confirm?: string) {
    const executionId = this.answer.executionId as string;
    const page = await this.approvalPage(person);
    await page.decide('approve', confirm);
    await this.resume(agent, executionId);
  }
}

setWorldConstructor(SynoikiaWorld);

After(async (world: SynoikiaWorld) => {
  await world.stop();
});
