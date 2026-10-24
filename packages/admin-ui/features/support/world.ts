import { createHash, createHmac, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { After, QuickPickleWorld, setWorldConstructor } from 'quickpickle';
import { afterAll, inject } from 'vitest';
import { startFakeHttp } from '@synoikia/core/testing';
import { createAppContext } from '../../../core/src/app.js';
import type { AppContext } from '../../../core/src/app.js';
import { loadConfig } from '../../../core/src/config/env.js';
import { createLogger } from '../../../core/src/log.js';
import { startServers } from '../../../core/src/server.js';
import type { RunningServers } from '../../../core/src/server.js';
import type { FakeHttp } from '@synoikia/core/testing';
import { browser as apiClient } from '../../../core/test/admin-client.js';
import {
  acmeGuard,
  acmeRoutes,
  API_TOKEN,
  CORE,
  CORE_FIXTURES,
  newRepository,
  publishedFiles,
  tasksArchive,
} from './acme.js';
import type { FakeRepository } from './acme.js';

export { API_TOKEN, CORE_FIXTURES } from './acme.js';

export const ADMIN = { username: 'admin', password: 'world admin passphrase' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = () => createLogger('error', () => undefined);

// A data directory with the migrated database, the admin, the "Acme Tasks" plugin and the admin's signed-in
// session, built once and copied for each scenario, as in core's World. Its name holds a fingerprint of the
// migrations and the plugin, so test processes share it until they change.
/** A cheap password hash, as in core's World: the real cost is pinned in core's unit tests. */
const TEST_HASH_COST = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
let template: Promise<string> | undefined;
const SESSION_FILE = '.admin-session.json';

async function buildTemplate(): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify(TEST_HASH_COST));
  for (const root of [path.join(CORE, 'drizzle'), CORE_FIXTURES])
    for (const file of (readdirSync(root, { recursive: true }) as string[]).sort())
      if (statSync(path.join(root, file)).isFile()) hash.update(file).update(readFileSync(path.join(root, file)));
  const name = `synoikia-portal-template-${hash.digest('hex').slice(0, 16)}`;
  const target = path.join(tmpdir(), name);
  if (existsSync(path.join(target, '.ready'))) return target;
  const dir = mkdtempSync(path.join(tmpdir(), 'synoikia-portal-template-build-'));
  cpSync(CORE_FIXTURES, path.join(dir, 'plugins'), { recursive: true });
  const ctx = await createAppContext(
    loadConfig({
      DATA_DIR: dir,
      ADMIN_HOST: '127.0.0.1',
      ADMIN_PORT: '0',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: '0',
      ADMIN_BOOTSTRAP_USERNAME: ADMIN.username,
      ADMIN_BOOTSTRAP_PASSWORD: ADMIN.password,
    }),
    { log: quiet(), passwordHashCost: TEST_HASH_COST },
  );
  await ctx.start();
  const servers = await startServers(ctx);
  const client = apiClient({
    request: (p, init) => fetch(`http://127.0.0.1:${servers.admin.port}${String(p)}`, { ...init, redirect: 'manual' }),
  });
  await client.init();
  const signIn = await client.post('/auth/login', ADMIN);
  if (!signIn.ok) throw new Error(`The template's admin sign-in failed: ${signIn.status}`);
  writeFileSync(path.join(dir, SESSION_FILE), JSON.stringify(Object.fromEntries(client.jar)));
  await servers.close();
  await ctx.stop();
  writeFileSync(path.join(dir, '.ready'), '');
  try {
    renameSync(dir, target);
  } catch {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const old of readdirSync(tmpdir()))
    if (old.startsWith('synoikia-portal-template-') && old !== name && !old.includes('-build-'))
      rmSync(path.join(tmpdir(), old), { recursive: true, force: true });
  return target;
}

// One Chromium for each test file; each scenario gets its own browser context, so no cookie or storage leaks.
let chromiumOnce: Promise<Browser> | undefined;
afterAll(async () => {
  const running = await chromiumOnce;
  chromiumOnce = undefined;
  await running?.close();
});

/** The RFC 6238 code (SHA-1, 6 digits, 30 s) of an authenticator app with this base32 secret, `steps` periods from now. */
export function totpCode(secret: string, steps = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '')) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + steps));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export type ApiClient = ReturnType<typeof apiClient>;

export interface Person {
  username: string;
  password: string;
  /** The base32 secret of their authenticator app, once they set one up. */
  totpSecret?: string;
  /** An SSO account signs in only with the identity provider (ADR-0025). */
  sso?: boolean;
}

/** A fresh core for each scenario, with the built portal, the "Acme Tasks" service, and a person's browser on it. */
export class PortalWorld extends QuickPickleWorld {
  dataDir = '';
  templateDir = '';
  ctx?: AppContext;
  servers?: RunningServers;
  base = '';
  context!: BrowserContext;
  page!: Page;
  /** The admin's own Admin API session, for what the admin set up before the scenario. */
  admin?: ApiClient;
  people = new Map<string, Person>();
  roles = new Map<string, string>();
  cleanups: (() => Promise<unknown>)[] = [];
  /** The fake "Acme Tasks" service and its lists, by name. */
  upstream?: FakeHttp;
  lists = new Map<string, string[]>([['Groceries', ['milk', 'eggs']]]);
  /** The instances made so far, by path, with their ids. */
  instances = new Map<string, string>();
  /** How far the World moved core's clock ahead of the real time. */
  clockMs = 0;
  /** Start-up settings core gets on top of the World's own, kept across restarts. */
  coreEnv: Record<string, string> = {};
  /** The version core reports, when a scenario names one. */
  coreVersion?: string;
  /** The plugin repositories the World publishes, by name, and what their hosts serve. */
  repositories = new Map<string, FakeRepository>();
  repoFiles = new Map<string, Buffer>();
  /** What the last question in the portal said, and how many fields it had. */
  question = { text: '', fields: 0 };
  /** The last plugin file the admin uploaded or installed. */
  lastFile?: Buffer;
  /** What a step saw for a later step to check, by name. */
  noted: Record<string, string> = {};
  /** The paths of every request the browser made, in order. */
  requests: string[] = [];
  /** Whether the browser carries the admin's session from the template. */
  private signedIn = false;

  async init() {
    await super.init();
    const { info } = this as unknown as { info: { config: { stepTimeout: number } } };
    info.config.stepTimeout = 15_000;
    this.upstream = await startFakeHttp({ routes: acmeRoutes(this.lists), guard: acmeGuard });
    this.dataDir = mkdtempSync(path.join(tmpdir(), 'synoikia-portal-'));
    this.templateDir = await (template ??= buildTemplate());
    cpSync(this.templateDir, this.dataDir, { recursive: true });
    rmSync(path.join(this.dataDir, '.ready'));
    this.people.set('admin', { ...ADMIN });
    await this.startCore();
    const shared = await (chromiumOnce ??= chromium.launch());
    this.context = await shared.newContext();
    this.page = await this.context.newPage();
    this.page.on('request', (r) => this.requests.push(new URL(r.url()).pathname));
  }

  private async startCore() {
    this.ctx = await createAppContext(
      loadConfig({
        DATA_DIR: this.dataDir,
        MCP_HOST: '127.0.0.1',
        MCP_PORT: '0',
        ADMIN_HOST: '127.0.0.1',
        ADMIN_PORT: '0',
        ADMIN_UI_DIR: inject('portalDir'),
        ...this.coreEnv,
      }),
      {
        log: quiet(),
        passwordHashCost: TEST_HASH_COST,
        oidcAllowInsecure: true,
        now: () => new Date(Date.now() + this.clockMs),
        repoFetch: (url) => this.repositoryHost(url),
        version: this.coreVersion,
      },
    );
    await this.ctx.start();
    this.servers = await startServers(this.ctx);
    this.base = `http://127.0.0.1:${this.servers.admin.port}`;
  }

  private async stopCore() {
    await this.servers?.close(1000);
    await this.ctx?.stop();
    this.servers = undefined;
    this.ctx = undefined;
  }

  /** Stops core and starts it again on the same data, with `env` added to its start-up settings. Sign-ins stay. */
  async restartCore(env: Record<string, string>) {
    await this.stopCore();
    Object.assign(this.coreEnv, env);
    await this.startCore();
  }

  /** A new server: core on an empty data directory, without any account. */
  async freshCore() {
    await this.stopCore();
    rmSync(this.dataDir, { recursive: true, force: true });
    this.dataDir = mkdtempSync(path.join(tmpdir(), 'synoikia-portal-'));
    this.people.clear();
    this.admin = undefined;
    await this.startCore();
    await this.context.close();
    this.context = await (await chromiumOnce!).newContext();
    this.page = await this.context.newPage();
  }

  async stop() {
    for (const undo of this.cleanups.splice(0).reverse()) await undo().catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    await this.stopCore();
    await this.upstream?.close();
    if (this.dataDir) rmSync(this.dataDir, { recursive: true, force: true });
  }

  // ── the Admin API, for what people set up before the scenario ──

  async expectOk(res: Promise<Response>, what: string) {
    const r = await res;
    if (!r.ok) throw new Error(`${what}: ${r.status} ${await r.text()}`);
    return (await r.json().catch(() => undefined)) as Record<string, unknown>;
  }

  /** A signed-out Admin API session of its own, like a second browser. */
  async apiSession() {
    const client = apiClient({
      request: (p, init) => fetch(`${this.base}${String(p)}`, { ...init, redirect: 'manual' }),
    });
    await client.init();
    return client;
  }

  /** The Admin API session of a person with a password; a person with an app gives its current code. */
  async apiAs(name: string) {
    const who = this.person(name);
    if (who.sso) return this.ssoApi(name);
    const client = await this.apiSession();
    const res = await this.expectOk(client.post('/auth/login', who), `sign in as ${name}`);
    if (res.status === 'totp_required')
      await this.expectOk(client.post('/auth/totp', { code: totpCode(who.totpSecret!) }), `code of ${name}`);
    return client;
  }

  /** The admin's Admin API session: the template's sign-in, or a new one once that session has expired. */
  async adminApi() {
    if (this.admin) return this.admin;
    const client = await this.apiSession();
    const saved = JSON.parse(readFileSync(path.join(this.dataDir, SESSION_FILE), 'utf8')) as Record<string, string>;
    for (const [name, value] of Object.entries(saved)) client.jar.set(name, value);
    if ((await client.get('/api/profile')).ok) return (this.admin = client);
    // A template past its session limits is built again by the next test file.
    rmSync(this.templateDir, { recursive: true, force: true });
    return (this.admin = await this.apiAs('admin'));
  }

  person(name: string) {
    const p = this.people.get(name);
    if (!p) throw new Error(`The World has no person "${name}" yet`);
    return p;
  }

  async role(name: string) {
    const known = this.roles.get(name);
    if (known) return known;
    const created = await this.expectOk((await this.adminApi()).post('/api/roles', { name }), 'create role');
    this.roles.set(name, created.id as string);
    return created.id as string;
  }

  /** A user with a password that the admin made; `roleId` defaults to a role of that name. */
  async user(name: string, role: { name: string } | { id: string }) {
    const known = this.people.get(name);
    if (known) return known;
    const roleId = 'id' in role ? role.id : await this.role(role.name);
    const username = name.startsWith('user ') ? `${name.replace(/\s+/g, '')}@acme.example` : name;
    const password = `${username} world passphrase`;
    await this.expectOk((await this.adminApi()).post('/api/users', { username, password, roleId }), 'create user');
    const p = { username, password };
    this.people.set(name, p);
    return p;
  }

  /** The person sets up an authenticator app in their profile, confirmed with the code of the previous period. */
  async authenticatorApp(name: string) {
    const client = name === 'admin' ? await this.adminApi() : await this.apiAs(name);
    const begun = await this.expectOk(client.post('/api/profile/totp/begin'), 'start two-factor setup');
    const secret = begun.secret as string;
    await this.expectOk(
      client.post('/api/profile/totp/confirm', { code: totpCode(secret, -1) }),
      'confirm two-factor setup',
    );
    this.person(name).totpSecret = secret;
  }

  /** A fake service on its own port that stops with the scenario. */
  async fakeService(routes: Parameters<typeof startFakeHttp>[0]['routes']) {
    const fake = await startFakeHttp({ routes });
    this.cleanups.push(() => fake.close());
    return fake;
  }

  // ── roles ──

  /** The role `name` has exactly the instances at `slugs`, made first where needed. */
  async roleInstances(name: string, slugs: string[]) {
    const roleId = await this.role(name);
    const instanceIds = [];
    for (const slug of slugs) instanceIds.push(await this.tasksInstance(slug));
    await this.expectOk(
      (await this.adminApi()).put(`/api/roles/${roleId}/instances`, { instanceIds }),
      'role instances',
    );
  }

  /** Turns on switches of the role `name` on the instance at `slug`. */
  async roleSwitches(name: string, slug: string, switches: Record<string, boolean>) {
    const roleId = await this.role(name);
    const id = await this.tasksInstance(slug);
    await this.expectOk((await this.adminApi()).patch(`/api/roles/${roleId}/endpoints/${id}`, switches), 'switches');
  }

  /** The most the role `name` may do in a group, or with one operation by its key, on the instance at `slug`. */
  async roleLevel(name: string, slug: string, target: { group: string } | { operation: string }, level: string) {
    const roleId = await this.role(name);
    const id = await this.tasksInstance(slug);
    const admin = await this.adminApi();
    if ('group' in target) {
      await this.expectOk(admin.put(`/api/roles/${roleId}/endpoints/${id}/groups/${target.group}`, { level }), 'level');
      return;
    }
    const ops = (await this.expectOk(admin.get(`/api/instances/${id}/operations`), 'operations')) as unknown as {
      id: string;
      key: string;
    }[];
    const op = ops.find((o) => o.key === target.operation)!;
    await this.expectOk(admin.put(`/api/roles/${roleId}/endpoints/${id}/operations/${op.id}`, { level }), 'level');
  }

  // ── "Acme Tasks": the plugin, its instances and its repositories ──

  /** The admin's row of the plugin "tasks", if it is installed. */
  async tasksPlugin() {
    const list = (await this.expectOk((await this.adminApi()).get('/api/plugins'), 'list plugins')) as unknown as {
      id: string;
      pluginId: string;
      enabled: boolean;
      repoId: string | null;
    }[];
    return list.find((p) => p.pluginId === 'tasks');
  }

  async enableTasks() {
    const plugin = (await this.tasksPlugin())!;
    if (!plugin.enabled)
      await this.expectOk((await this.adminApi()).patch(`/api/plugins/${plugin.id}`, { enabled: true }), 'enable');
  }

  /** The instance at /`slug` of "Acme Tasks", made and synced through the Admin API. */
  async tasksInstance(slug: string, extra: Record<string, unknown> = {}) {
    const known = this.instances.get(slug);
    if (known) return known;
    await this.enableTasks();
    const created = await this.expectOk(
      (await this.adminApi()).post('/api/instances', {
        pluginId: 'tasks',
        slug,
        connection: { url: this.upstream!.url, token: API_TOKEN },
        ...extra,
      }),
      'create instance',
    );
    const id = created.id as string;
    await this.expectOk((await this.adminApi()).post(`/api/instances/${id}/sync`), 'sync instance');
    this.instances.set(slug, id);
    return id;
  }

  /** The instance as the admin's overview shows it. */
  async instance(slug: string) {
    const overview = await this.expectOk((await this.adminApi()).get('/api/overview'), 'read overview');
    return (overview.instances as { slug: string; [k: string]: unknown }[]).find((i) => i.slug === slug);
  }

  /** Changes the manifest of the plugin "tasks" in its folder, and has core read it again. */
  async editTasksManifest(change: (m: Record<string, unknown>) => void) {
    const file = path.join(this.dataDir, 'plugins', 'tasks', 'manifest.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    change(manifest);
    writeFileSync(file, JSON.stringify(manifest, null, 2));
    await this.expectOk((await this.adminApi()).post('/api/plugins/rescan'), 'rescan plugins');
  }

  /** Flag files the fixture plugin reads, such as `catalog-changes` (see its index.mjs). */
  pluginFlag(name: string, value: string) {
    writeFileSync(path.join(this.dataDir, 'plugins', 'tasks', name), value);
  }

  repository(name: string) {
    let repo = this.repositories.get(name);
    if (!repo) this.repositories.set(name, (repo = newRepository(name)));
    return repo;
  }

  /** `name` offers exactly these versions of "Acme Tasks" from now on. */
  offer(name: string, versions: string[]) {
    const repo = this.repository(name);
    repo.builds = versions.map((version) => ({ version, archive: tasksArchive(version) }));
    for (const [url, body] of publishedFiles(repo)) this.repoFiles.set(url, body);
    return repo;
  }

  /** The admin installs "Acme Tasks" `version` from `name` in place of the hand-copied one, and enables it. */
  async installedFrom(name: string, version: string) {
    const admin = await this.adminApi();
    const current = await this.tasksPlugin();
    if (current && !current.repoId) await this.expectOk(admin.del(`/api/plugins/${current.id}`), 'uninstall');
    const repo = this.offer(name, [version]);
    const added = await this.expectOk(
      admin.post('/api/plugin-repos', {
        url: repo.url,
        signingMode: repo.key ? 'signed' : 'unsigned',
        ...(repo.key ? { confirmPublicKey: repo.key.publicKey } : {}),
      }),
      'add repository',
    );
    repo.id = added.id as string;
    await this.expectOk(admin.post('/api/plugins/install', { repoId: repo.id, pluginId: 'tasks', version }), 'install');
    await this.enableTasks();
  }

  /** The admin uploads a file and installs it through the Admin API. */
  async installedFile(fileName: string, archive: Buffer) {
    const admin = await this.adminApi();
    const staged = await this.expectOk(
      admin.req('POST', '/api/plugins/uploads', new Uint8Array(archive), {
        'x-file-name': encodeURIComponent(fileName),
      }),
      'upload',
    );
    await this.expectOk(admin.post(`/api/plugins/uploads/${String(staged.uploadId)}/install`), 'install upload');
  }

  /** What a repository host answers core; a host outside the World does not answer. */
  private repositoryHost(url: string) {
    const body = this.repoFiles.get(url);
    if (body) return Promise.resolve(new Response(new Uint8Array(body)));
    if (new URL(url).hostname.endsWith('.acme.example'))
      return Promise.resolve(new Response('missing', { status: 404 }));
    return Promise.reject(new TypeError('connection refused'));
  }

  // ── the identity provider "Acme ID" ──

  /** The admin points core's single sign-on at a fake identity provider that signs in `acme.next`. */
  async singleSignOn(label: string) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'acme-id-1', alg: 'RS256', use: 'sig' };
    const codes = new Map<string, { nonce: string; sub: string; email?: string }>();
    const b64 = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');
    const idp = await this.fakeService({
      'GET /.well-known/openid-configuration': () => ({
        body: {
          issuer: idp.url,
          authorization_endpoint: `${idp.url}/authorize`,
          token_endpoint: `${idp.url}/token`,
          jwks_uri: `${idp.url}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        },
      }),
      'GET /jwks': () => ({ body: { keys: [jwk] } }),
      'GET /authorize': (req) => {
        const code = randomBytes(12).toString('hex');
        codes.set(code, { nonce: req.query.get('nonce')!, sub: this.acmeNext, email: this.acmeNextEmail });
        const back = new URL(req.query.get('redirect_uri')!);
        back.searchParams.set('code', code);
        back.searchParams.set('state', req.query.get('state')!);
        back.searchParams.set('iss', idp.url);
        return { status: 302, headers: { location: back.toString() } };
      },
      'POST /token': (req) => {
        const grant = codes.get(new URLSearchParams(String(req.body)).get('code') ?? '');
        if (!grant) return { status: 400, body: { error: 'invalid_grant' } };
        const now = Math.floor(Date.now() / 1000);
        const claims = {
          iss: idp.url,
          sub: grant.sub,
          aud: 'synoikia',
          nonce: grant.nonce,
          iat: now,
          exp: now + 300,
          ...(grant.email ? { email: grant.email, email_verified: true } : {}),
        };
        const input = `${b64({ alg: 'RS256', kid: 'acme-id-1', typ: 'JWT' })}.${b64(claims)}`;
        const signature = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
        return { body: { access_token: 'acme-at', token_type: 'Bearer', id_token: `${input}.${signature}` } };
      },
    });
    await this.expectOk(
      (await this.adminApi()).put('/api/settings/oidc', {
        enabled: true,
        issuer: idp.url,
        clientId: 'synoikia',
        label,
      }),
      'set up single sign-on',
    );
  }

  /** The subject the identity provider signs in next. */
  acmeNext = 'acme-admin';

  /** The verified address the identity provider signs in next, if any. */
  acmeNextEmail: string | undefined;

  /** An SSO account that the admin made for the person's address (ADR-0025). */
  async ssoUser(name: string, role: { name: string }) {
    const known = this.people.get(name);
    if (known) return known;
    const roleId = await this.role(role.name);
    const username = `${name.replace(/\s+/g, '')}@acme.example`;
    await this.expectOk(
      (await this.adminApi()).post('/api/users', { username, kind: 'sso', oidcEmail: username, roleId }),
      'create SSO account',
    );
    const p = { username, password: '', sso: true };
    this.people.set(name, p);
    return p;
  }

  /** The Admin API session of an SSO account, signed in through the identity provider. */
  private async ssoApi(name: string) {
    const client = await this.apiSession();
    this.acmeNext = `acme-${name.replace(/\D+/g, '') || name}`;
    this.acmeNextEmail = this.person(name).username;
    let at = new URL('/auth/oidc/start', this.base);
    for (let hop = 0; hop < 10; hop++) {
      if (at.origin === this.base && !at.pathname.startsWith('/auth/')) {
        if (at.pathname !== '/') throw new Error(`single sign-on of ${name} ended at ${at.pathname}${at.search}`);
        return client;
      }
      const res =
        at.origin === this.base ? await client.get(at.pathname + at.search) : await fetch(at, { redirect: 'manual' });
      const next = res.headers.get('location');
      if (!next) throw new Error(`single sign-on of ${name} stopped at ${at.pathname}: ${res.status}`);
      at = new URL(next, at);
    }
    throw new Error('single sign-on: too many redirects');
  }

  // ── the browser ──

  async open(where: string) {
    await this.page.goto(`${this.base}${where}`);
  }

  /** The admin's browser with the admin's session, open at `where`. */
  async openAsAdmin(where: string) {
    if (!this.signedIn) {
      const admin = await this.adminApi();
      await this.context.addCookies(
        [...admin.jar].map(([name, value]) => ({ name, value, domain: '127.0.0.1', path: '/' })),
      );
      this.signedIn = true;
    }
    await this.open(where);
  }

  /** The admin's overview, in a page that marks itself so that `sameLoad` can tell it did not reload. */
  async overviewOpen() {
    await this.openAsAdmin('/');
    await this.page.getByRole('heading', { name: 'Overview', level: 1 }).waitFor({ state: 'visible', timeout: 10_000 });
    await this.page.evaluate(() => ((window as unknown as { sameLoad: boolean }).sameLoad = true));
  }

  /** Whether the page is still the one `overviewOpen` marked. */
  async sameLoad() {
    return this.page.evaluate(() => (window as unknown as { sameLoad?: boolean }).sameLoad === true);
  }

  /** The browser of a person other than the admin, signed in through the Admin API, open at `where`. */
  async openAs(name: string, where: string) {
    const client = await this.apiAs(name);
    await this.context.addCookies(
      [...client.jar].map(([cookie, value]) => ({ name: cookie, value, domain: '127.0.0.1', path: '/' })),
    );
    await this.open(where);
  }

  /** The open question in the portal: its text and fields are kept, then the person picks `action`. */
  async answerQuestion(action: string) {
    const dialog = this.page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    this.question = { text: (await dialog.textContent()) ?? '', fields: await dialog.getByRole('textbox').count() };
    await dialog.getByRole('button', { name: action, exact: true }).click();
  }

  /** The person fills in the sign-in form in the browser and sends it. */
  async signIn(name: string, password = this.person(name).password) {
    await this.page.getByLabel('Username').fill(this.person(name).username);
    await this.page.getByLabel('Password').fill(password);
    await this.page.getByRole('button', { name: 'Sign in' }).click();
  }
}

setWorldConstructor(PortalWorld);

// Quickpickle gives the After hook the 3 s step limit; a slow stop ends in the background.
After(async (world: PortalWorld) => {
  await Promise.race([world.stop(), sleep(2500)]);
});
