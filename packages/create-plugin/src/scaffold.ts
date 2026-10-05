import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RESERVED_NAMESPACES, SDK_VERSION } from '@synoikia/plugin-sdk';
import { dependencyRange, TEMPLATES_DIR } from './repo-root.js';

/** Scaffolds plugin repositories and plugins from templates with `{{name}}` placeholders (nothing runs;
 * `_`-prefixed files become dotfiles), using only published SDK and core APIs. */

export const ARCHETYPES = {
  'openapi-rest': 'REST API that serves an OpenAPI spec: the catalog is the spec, rules lock and describe',
  'static-rest': 'REST API without a spec: operations are declared in plugin.yaml',
  'websocket-rpc': 'JSON-RPC 2.0 over WebSocket: methods declared in plugin.yaml',
  blank: 'A minimal plugin to fill in by hand',
} as const;
export type Archetype = keyof typeof ARCHETYPES;

export const AUTH_KINDS = {
  bearer: 'Bearer token (Authorization: Bearer …)',
  'api-key': 'API key header (e.g. X-Api-Key)',
  basic: 'Username and password (HTTP Basic)',
  none: 'No authentication',
} as const;
export type AuthKind = keyof typeof AUTH_KINDS;

export interface NewPluginOptions {
  /** The plugin repository root. */
  root: string;
  id: string;
  name: string;
  /** Sandbox namespace; defaults to the id in camelCase. */
  namespace?: string;
  description?: string;
  archetype: Archetype;
  auth: AuthKind;
  /** Header for `api-key` auth. Default `X-Api-Key`. */
  apiKeyHeader?: string;
  /** Override dependency ranges (tests). */
  ranges?: Partial<Record<'sdk' | 'core' | 'cli', string>>;
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const JS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export const camelCase = (id: string) => id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
export const pascalCase = (id: string) => camelCase(id).replace(/^./, (c) => c.toUpperCase());

/** Problems with a plugin id or namespace, or undefined. */
export function validateId(id: string, root?: string): string | undefined {
  if (!ID_PATTERN.test(id)) return 'Use 2–63 lowercase letters, digits and dashes, starting with a letter or digit';
  if (root && existsSync(path.join(root, 'plugins', id))) return `plugins/${id} already exists`;
  return undefined;
}

/** Names and descriptions land in generated code, YAML and Markdown: plain text only. */
const SAFE_TEXT = /^[\p{L}\p{N}][\p{L}\p{N} .,:()&+_/-]*$/u;

export function validateName(name: string): string | undefined {
  if (name.length > 64 || !SAFE_TEXT.test(name))
    return 'Use letters, digits, spaces and . , : ( ) & + _ / - (up to 64 characters)';
  return undefined;
}

export function validateDescription(text: string): string | undefined {
  if (text.length > 200 || !SAFE_TEXT.test(text))
    return 'Use plain text without quotes or newlines (up to 200 characters)';
  return undefined;
}

export function validateNamespace(ns: string): string | undefined {
  if (!JS_IDENTIFIER.test(ns)) return 'Must be a JavaScript identifier';
  if ((RESERVED_NAMESPACES as readonly string[]).includes(ns)) return `"${ns}" is reserved by core`;
  return undefined;
}

const PLACEHOLDER = /\{\{([a-zA-Z]+)\}\}/g;

/** Replaces `{{name}}` for the names in `vars`; anything else (e.g. `{{connection.baseUrl}}`) stays. */
export function fill(text: string, vars: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => (Object.hasOwn(vars, name) ? vars[name]! : whole));
}

const outName = (name: string) => (/^_[a-zA-Z]/.test(name) ? `.${name.slice(1)}` : name);

/** Copies a template directory, filling placeholders. Refuses to overwrite an existing file. */
export function renderTemplate(
  from: string,
  to: string,
  vars: Record<string, string>,
  written: string[] = [],
): string[] {
  for (const entry of readdirSync(from).sort()) {
    const src = path.join(from, entry);
    const dest = path.join(to, outName(entry));
    if (statSync(src).isDirectory()) {
      renderTemplate(src, dest, vars, written);
      continue;
    }
    if (existsSync(dest)) throw new Error(`${dest} already exists`);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, fill(readFileSync(src, 'utf8'), vars));
    written.push(dest);
  }
  return written;
}

const write = (file: string, text: string, written: string[]) => {
  if (existsSync(file)) throw new Error(`${file} already exists`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  written.push(file);
};

interface AuthSpec {
  secret?: { name: string; title: string; help: string };
  user?: boolean;
  source: (header: string) => string;
  fake: (header: string) => string;
}

const AUTH: Record<AuthKind, AuthSpec> = {
  bearer: {
    secret: {
      name: 'token',
      title: 'API token',
      help: 'A long-lived API token for a dedicated, least-privileged user.',
    },
    source: () => `/** Authenticates every request with the connection's API token. */
export function authHeaders({ secrets }: InitParams): () => Record<string, string> {
  const token = requireString(secrets, 'token');
  return () => ({ authorization: \`Bearer \${token}\` });
}
`,
    fake: () => `export const CREDENTIALS = { token: 'fake-api-token-abcdef' };

export const authorized = (headers: IncomingHttpHeaders) => headers.authorization === \`Bearer \${CREDENTIALS.token}\`;
`,
  },
  'api-key': {
    secret: { name: 'apiKey', title: 'API key', help: 'An API key for a dedicated, least-privileged user.' },
    source: (header) => `/** Authenticates every request with the connection's API key. */
export function authHeaders({ secrets }: InitParams): () => Record<string, string> {
  const apiKey = requireString(secrets, 'apiKey');
  return () => ({ '${header}': apiKey });
}
`,
    fake: (header) => `export const CREDENTIALS = { apiKey: 'fake-api-key-abcdef' };

export const authorized = (headers: IncomingHttpHeaders) => headers['${header}'] === CREDENTIALS.apiKey;
`,
  },
  basic: {
    secret: { name: 'password', title: 'Password', help: 'The password of a dedicated, least-privileged user.' },
    user: true,
    source: () => `/** Authenticates every request with the connection's username and password (HTTP Basic). */
export function authHeaders({ config, secrets }: InitParams): () => Record<string, string> {
  const credentials = Buffer.from(\`\${requireString(config, 'username')}:\${requireString(secrets, 'password')}\`).toString('base64');
  return () => ({ authorization: \`Basic \${credentials}\` });
}
`,
    fake: () => `export const CREDENTIALS = { username: 'synoikia', password: 'fake-password-abcdef' };

export const authorized = (headers: IncomingHttpHeaders) =>
  headers.authorization === \`Basic \${Buffer.from(\`\${CREDENTIALS.username}:\${CREDENTIALS.password}\`).toString('base64')}\`;
`,
  },
  none: {
    source: () => `/** The upstream needs no authentication. */
export function authHeaders(_init: InitParams): () => Record<string, string> {
  return () => ({});
}
`,
    fake: () => `export const CREDENTIALS = {};

export const authorized = (_headers: IncomingHttpHeaders) => true;
`,
  },
};

function authModule(auth: AuthKind, header: string): string {
  const spec = AUTH[auth];
  const usesRequire = auth !== 'none';
  return `${usesRequire ? "import { requireString } from '@synoikia/plugin-sdk';\n" : ''}import type { InitParams } from '@synoikia/plugin-sdk';

${spec.source(header)}`;
}

function fakeAuthModule(auth: AuthKind, header: string): string {
  return `import type { IncomingHttpHeaders } from 'node:http';

/** The connection the tests use, and how the fake upstream checks it. */
${AUTH[auth].fake(header)}`;
}

/** The generated manifest: connection form, secrets, network hosts and binding. */
export function manifestFor(opts: NewPluginOptions, namespace: string): Record<string, unknown> {
  const spec = AUTH[opts.auth];
  const properties: Record<string, unknown> = {
    baseUrl: { type: 'string', format: 'uri', title: 'Base URL' },
    ...(spec.user ? { username: { type: 'string', title: 'Username' } } : {}),
    ...(spec.secret ? { [spec.secret.name]: { type: 'string', title: spec.secret.title, writeOnly: true } } : {}),
    verifyTls: { type: 'boolean', title: 'Verify TLS certificate', default: true },
  };
  const ui: Record<string, unknown> = {
    baseUrl: { widget: 'url', placeholder: `https://${opts.id}.internal.lan` },
    ...(spec.user ? { username: { widget: 'text' } } : {}),
    ...(spec.secret ? { [spec.secret.name]: { widget: 'secret', help: spec.secret.help } } : {}),
    verifyTls: { widget: 'bool' },
  };
  const required = ['baseUrl', ...(spec.user ? ['username'] : []), ...(spec.secret ? [spec.secret.name] : [])];
  const sensitiveKeys = [
    ...new Set([...(spec.secret ? [spec.secret.name] : []), 'apiKey', 'api_key', 'token', 'password', 'secret']),
  ];
  return {
    id: opts.id,
    name: opts.name,
    version: '0.1.0',
    sdk: `^${SDK_VERSION}`,
    description: opts.description ?? `${opts.name} for Synoikia.`,
    entry: 'dist/index.js',
    binding: { namespace, functions: [opts.archetype === 'openapi-rest' ? 'request' : 'call'] },
    connection: {
      schema: { type: 'object', required, properties },
      ui,
      help: `1. In ${opts.name}, create a dedicated user with only the access Synoikia should have${spec.secret ? `, and its ${spec.secret.title.toLowerCase()}` : ''}.\n2. Enter the base URL and credentials, then **Test connection**.\n3. Keep *Verify TLS* on unless ${opts.name} uses a self-signed certificate on a trusted network.\n\nAfter the first sync, raise groups on the Access page as needed.`,
    },
    sensitiveKeys,
    network: { hosts: ['{{connection.baseUrl}}'] },
  };
}

function packageFor(opts: NewPluginOptions): Record<string, unknown> {
  const range = (k: 'sdk' | 'core' | 'cli', name: string) => opts.ranges?.[k] ?? dependencyRange(name);
  const ws = opts.archetype === 'websocket-rpc';
  return {
    name: `@synoikia/plugin-${opts.id}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    main: 'dist/index.js',
    scripts: {
      build: 'synoikia-plugin build',
      check: 'synoikia-plugin check',
      typecheck: 'tsc -p tsconfig.json --noEmit',
      test: 'synoikia-plugin check && synoikia-plugin build && vitest run',
    },
    dependencies: {
      '@synoikia/plugin-sdk': range('sdk', '@synoikia/plugin-sdk'),
      ...(ws ? { ws: '^8.22.0' } : {}),
    },
    devDependencies: {
      '@synoikia/core': range('core', '@synoikia/core'),
      '@synoikia/create-plugin': range('cli', '@synoikia/create-plugin'),
      ...(ws ? { '@types/ws': '^8.18.1' } : {}),
    },
  };
}

/** Writes `plugins/<id>/` from the archetype's template. Returns the files written. */
export function newPlugin(opts: NewPluginOptions): string[] {
  const idProblem = validateId(opts.id, opts.root);
  if (idProblem) throw new Error(`Plugin id: ${idProblem}`);
  const namespace = opts.namespace ?? camelCase(opts.id);
  const nsProblem = validateNamespace(namespace);
  if (nsProblem) throw new Error(`Namespace: ${nsProblem}`);
  const nameProblem = validateName(opts.name);
  if (nameProblem) throw new Error(`Name: ${nameProblem}`);
  const descProblem = opts.description === undefined ? undefined : validateDescription(opts.description);
  if (descProblem) throw new Error(`Description: ${descProblem}`);
  if (!ARCHETYPES[opts.archetype]) throw new Error(`Unknown archetype ${opts.archetype}`);
  if (!AUTH[opts.auth]) throw new Error(`Unknown auth ${opts.auth}`);
  const header = (opts.apiKeyHeader ?? 'X-Api-Key').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(header)) throw new Error('The API key header may only hold letters, digits and dashes');

  const dir = path.join(opts.root, 'plugins', opts.id);
  const vars = {
    id: opts.id,
    name: opts.name,
    namespace,
    Pascal: pascalCase(opts.id),
    description: opts.description ?? `${opts.name} for Synoikia.`,
    fn: opts.archetype === 'openapi-rest' ? 'request' : 'call',
    archetype: opts.archetype,
  };
  const written: string[] = [];
  renderTemplate(path.join(TEMPLATES_DIR, 'plugin', 'common'), dir, vars, written);
  renderTemplate(path.join(TEMPLATES_DIR, 'plugin', opts.archetype), dir, vars, written);
  write(path.join(dir, 'manifest.json'), `${JSON.stringify(manifestFor(opts, namespace), null, 2)}\n`, written);
  write(path.join(dir, 'package.json'), `${JSON.stringify(packageFor(opts), null, 2)}\n`, written);
  write(path.join(dir, 'src', 'auth.ts'), authModule(opts.auth, header), written);
  if (opts.archetype !== 'blank')
    write(path.join(dir, 'test', 'fake-auth.ts'), fakeAuthModule(opts.auth, header), written);
  return written;
}

export interface CreateRepoOptions {
  /** The new repository's directory (must not exist, or be empty). */
  dir: string;
  /** `owner/name` on GitHub, for the release index. */
  repository?: string;
  /** Add the signed-release workflow. */
  release?: boolean;
  /** Add the Claude Code setup (CLAUDE.md, skills, hooks, security reviewer). */
  claude?: boolean;
  ranges?: Partial<Record<'core' | 'cli', string>>;
}

/** Writes a new plugin repository. Returns the files written. */
export function createRepo(opts: CreateRepoOptions): string[] {
  const dir = path.resolve(opts.dir);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty`);
  const name = path.basename(dir);
  // The directory name becomes the package name and appears in generated files.
  if (!/^[a-z0-9][a-z0-9._-]{0,213}$/.test(name))
    throw new Error(`${name}: use a lowercase directory name (letters, digits, . _ -), as for an npm package`);
  const repository = opts.repository ?? `OWNER/${name}`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('repository must look like owner/name');
  const vars = {
    repoName: name,
    repository,
    coreRange: opts.ranges?.core ?? dependencyRange('@synoikia/core'),
    cliRange: opts.ranges?.cli ?? dependencyRange('@synoikia/create-plugin'),
  };
  const written: string[] = [];
  renderTemplate(path.join(TEMPLATES_DIR, 'repo', 'base'), dir, vars, written);
  if (opts.release) renderTemplate(path.join(TEMPLATES_DIR, 'repo', 'release'), dir, vars, written);
  if (opts.claude) renderTemplate(path.join(TEMPLATES_DIR, 'repo', 'claude'), dir, vars, written);
  mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  return written;
}

/** `pnpm install` in the repository (links a new plugin, updates the lockfile). */
export function install(root: string): void {
  execFileSync('pnpm', ['install'], { cwd: root, stdio: 'inherit' });
}
