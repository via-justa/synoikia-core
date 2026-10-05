import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkManifest } from '@synoikia/plugin-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPlugin } from '../src/build.js';
import { checkPlugin } from '../src/check.js';
import { loadYamlModule, moduleSource } from '../src/files.js';
import { createRepoTool, repositoryFromRemote } from '../src/repo.js';
import { dependencyRange, findRepoRoot } from '../src/repo-root.js';
import { createRepo, fill, manifestFor, newPlugin, validateId, validateNamespace } from '../src/scaffold.js';
import { pluginFiles } from '../src/vitest.js';

const RANGES = { sdk: '^0.3.0', core: '^0.5.0', cli: '^0.1.0' };
const tmp: string[] = [];
const work = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'synoikia-cli-'));
  tmp.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The smallest manifest `synoikia-plugin check` accepts, for packing tests. */
const packManifest = (id: string, version: string) => ({
  id,
  name: id,
  version,
  sdk: '^0.2.2',
  entry: 'dist/index.js',
  binding: { namespace: id, functions: ['call'] },
  connection: { schema: { type: 'object', properties: {} }, ui: {} },
  sensitiveKeys: [],
  network: { hosts: ['example.com'] },
});

describe('templates', () => {
  it('fills only known placeholders', () => {
    expect(fill('{{name}} at {{connection.baseUrl}} {{other}}', { name: 'Acme' })).toBe(
      'Acme at {{connection.baseUrl}} {{other}}',
    );
    expect(fill('{{constructor}}', {})).toBe('{{constructor}}');
  });

  it('refuses names that would break out of generated code', () => {
    const root = path.join(work(), 'r');
    createRepo({ dir: root, ranges: RANGES });
    for (const name of ["A'; process.exit(1); '", 'A"b', 'line\nbreak', 'back\\slash'])
      expect(
        () => newPlugin({ root, id: 'acme', name, archetype: 'blank', auth: 'none', ranges: RANGES }),
        name,
      ).toThrow(/Name/);
    expect(() =>
      newPlugin({
        root,
        id: 'acme',
        name: 'Acme',
        description: 'x`y',
        archetype: 'blank',
        auth: 'none',
        ranges: RANGES,
      }),
    ).toThrow(/Description/);
    expect(() => createRepo({ dir: path.join(work(), 'Bad"Name'), ranges: RANGES })).toThrow(/directory name/);
  });

  it('validates ids and namespaces', () => {
    expect(validateId('acme-box')).toBeUndefined();
    expect(validateId('Acme')).toBeDefined();
    expect(validateId('a')).toBeDefined();
    expect(validateNamespace('acmeBox')).toBeUndefined();
    expect(validateNamespace('catalog')).toMatch(/reserved/);
    expect(validateNamespace('acme-box')).toBeDefined();
  });

  it('generates manifests that pass the secret-field checks for every auth kind', () => {
    for (const auth of ['bearer', 'api-key', 'basic', 'none'] as const) {
      const m = manifestFor({ root: '', id: 'acme', name: 'Acme', archetype: 'openapi-rest', auth }, 'acme');
      expect(checkManifest(m), auth).toEqual([]);
    }
  });

  it('writes a repository with dotfiles, optional parts, and refuses a non-empty directory', () => {
    const dir = path.join(work(), 'my-plugins');
    createRepo({ dir, repository: 'me/my-plugins', claude: true, ranges: RANGES });
    for (const f of ['.gitignore', '.github/workflows/ci.yml', '.claude/settings.json', 'CLAUDE.md', 'plugins'])
      expect(existsSync(path.join(dir, f)), f).toBe(true);
    expect(existsSync(path.join(dir, '.github/workflows/release.yml'))).toBe(false);
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(pkg).toMatchObject({
      name: 'my-plugins',
      scripts: { new: 'synoikia-plugin new' },
      synoikia: { repository: 'me/my-plugins' },
      devDependencies: { '@synoikia/core': '^0.5.0', '@synoikia/create-plugin': '^0.1.0' },
    });
    expect(() => createRepo({ dir, ranges: RANGES })).toThrow(/not empty/);
    expect(() => createRepo({ dir: path.join(work(), 'x'), repository: 'bad repo', ranges: RANGES })).toThrow();
  });

  it('adds a plugin and refuses an existing or invalid one', () => {
    const root = path.join(work(), 'r');
    createRepo({ dir: root, ranges: RANGES });
    newPlugin({
      root,
      id: 'acme',
      name: 'Acme',
      archetype: 'static-rest',
      auth: 'api-key',
      apiKeyHeader: 'X-Token',
      ranges: RANGES,
    });
    const dir = path.join(root, 'plugins', 'acme');
    expect(readFileSync(path.join(dir, 'src/auth.ts'), 'utf8')).toContain("'x-token': apiKey");
    expect(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))).toMatchObject({
      name: '@synoikia/plugin-acme',
      dependencies: { '@synoikia/plugin-sdk': '^0.3.0' },
    });
    expect(checkPlugin(dir)).toEqual([]);
    expect(findRepoRoot(dir)).toBe(root);
    expect(() => newPlugin({ root, id: 'acme', name: 'A', archetype: 'blank', auth: 'none', ranges: RANGES })).toThrow(
      /already exists/,
    );
    expect(() => newPlugin({ root, id: 'x', name: 'X', archetype: 'blank', auth: 'none', ranges: RANGES })).toThrow(
      /id/,
    );
    expect(() =>
      newPlugin({
        root,
        id: 'ok-id',
        name: 'X',
        namespace: 'registry',
        archetype: 'blank',
        auth: 'none',
        ranges: RANGES,
      }),
    ).toThrow(/reserved/);
    expect(() =>
      newPlugin({
        root,
        id: 'hdr',
        name: 'X',
        archetype: 'blank',
        auth: 'api-key',
        apiKeyHeader: 'x\r\ny',
        ranges: RANGES,
      }),
    ).toThrow(/header/);
  });

  it('resolves dependency ranges for generated packages', () => {
    expect(dependencyRange('@synoikia/create-plugin')).toMatch(/^\^\d/);
    expect(dependencyRange('@synoikia/plugin-sdk')).toMatch(/^\^\d/);
    expect(dependencyRange('yaml')).toBe('^2.9.1');
  });
});

describe('check', () => {
  it('reports version, id, plugin.yaml and manifest problems', () => {
    const root = path.join(work(), 'r');
    createRepo({ dir: root, ranges: RANGES });
    newPlugin({ root, id: 'acme', name: 'Acme', archetype: 'blank', auth: 'bearer', ranges: RANGES });
    const dir = path.join(root, 'plugins', 'acme');
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ ...manifest, version: '0.2.0', sensitiveKeys: [] }),
    );
    writeFileSync(path.join(dir, 'plugin.yaml'), 'rules:\n  - match: x\n    matchProfile: nope\n');
    expect(checkPlugin(dir)).toEqual([
      'connection.token: a secret field must be listed in sensitiveKeys',
      'plugin.yaml rules[0]: matchProfile "nope" is not in the manifest',
      'package.json version 0.1.0 and manifest.json version 0.2.0 differ',
    ]);
    writeFileSync(path.join(dir, 'plugin.yaml'), 'rules: [{ match: x, lockd: true }]\n');
    expect(checkPlugin(dir)[0]).toMatch(/^plugin.yaml: /);
    expect(checkPlugin(path.join(root, 'nope'))[0]).toMatch(/^manifest.json: /);
  });
});

describe('data files', () => {
  it('inlines YAML and Markdown, and validates plugin.yaml', () => {
    const dir = work();
    writeFileSync(path.join(dir, 'guide.md'), '# Hi\n');
    writeFileSync(path.join(dir, 'data.yaml'), 'a: [1, 2]\n');
    writeFileSync(path.join(dir, 'plugin.yaml'), 'rules: [{ match: x, locked: true }]\n');
    expect(moduleSource(path.join(dir, 'guide.md'))).toBe('export default "# Hi\\n";\n');
    expect(moduleSource(path.join(dir, 'data.yaml'))).toBe('export default {"a":[1,2]};\n');
    expect(moduleSource(path.join(dir, 'x.ts'))).toBeUndefined();
    expect(loadYamlModule(path.join(dir, 'plugin.yaml'))).toEqual({ rules: [{ match: 'x', locked: true }] });
    writeFileSync(path.join(dir, 'plugin.yaml'), 'rule: []\n');
    expect(() => loadYamlModule(path.join(dir, 'plugin.yaml'))).toThrow(/not valid plugin settings/);
    writeFileSync(path.join(dir, 'bad.yaml'), 'a: [');
    expect(() => loadYamlModule(path.join(dir, 'bad.yaml'))).toThrow(/bad.yaml/);
    const bomb = [
      'a: &a [x,x,x,x,x,x,x,x,x,x]',
      ...Array.from(
        { length: 10 },
        (_, i) =>
          `${'b'.repeat(i + 1)}: &${'b'.repeat(i + 1)} [${Array(10)
            .fill(i ? `*${'b'.repeat(i)}` : '*a')
            .join(',')}]`,
      ),
    ].join('\n');
    writeFileSync(path.join(dir, 'bomb.yaml'), bomb);
    expect(() => loadYamlModule(path.join(dir, 'bomb.yaml'))).toThrow();
  });

  it('gives vitest the same modules', () => {
    const dir = work();
    writeFileSync(path.join(dir, 'd.yaml'), 'n: 1\n');
    const plugin = pluginFiles();
    expect(plugin.transform('ignored', path.join(dir, 'd.yaml'))).toEqual({
      code: 'export default {"n":1};\n',
      map: null,
    });
    expect(plugin.transform('# x', '/a/guide.md?raw')).toEqual({ code: 'export default "# x";\n', map: null });
    expect(plugin.transform('code', '/a/x.ts')).toBeUndefined();
  });

  it('bundles plugin.yaml into a self-contained bundle', async () => {
    const dir = work();
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'plugin.yaml'), 'plugin: { greeting: hello }\n');
    writeFileSync(path.join(dir, 'src/index.ts'), "import s from '../plugin.yaml';\nconsole.log(JSON.stringify(s));\n");
    const out = await buildPlugin({ dir });
    const bundle = readFileSync(out, 'utf8');
    expect(bundle).toContain('createRequire');
    expect(bundle).not.toContain("from '../plugin.yaml'");
    expect(execFileSync(process.execPath, [out], { encoding: 'utf8' }).trim()).toBe('{"plugin":{"greeting":"hello"}}');
  });
});

describe('repo', () => {
  it('reads the repository from a GitHub remote', () => {
    expect(repositoryFromRemote('git@github.com:acme/plugins.git')).toBe('acme/plugins');
    expect(repositoryFromRemote('https://github.com/acme/plugins\n')).toBe('acme/plugins');
    expect(repositoryFromRemote('http://local_proxy@127.0.0.1:1/git/acme/plugins')).toBeUndefined();
  });

  it('packs deterministically, skips released versions and indexes signed tarballs', () => {
    const root = work();
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ synoikia: { repository: 'acme/plugins', name: 'Acme' } }),
    );
    writeFileSync(path.join(root, 'minisign.pub'), 'untrusted comment: minisign public key\nRWTESTKEY\n');
    for (const [id, version] of [
      ['one', '1.0.0'],
      ['two', '2.0.0'],
    ]) {
      const dir = path.join(root, 'plugins', id!);
      mkdirSync(path.join(dir, 'dist'), { recursive: true });
      writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(packManifest(id!, version!)));
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@acme/plugin-${id}`, version }));
      writeFileSync(path.join(dir, 'dist/index.js'), `// ${id}\n`);
    }
    const built: string[] = [];
    const logs: string[] = [];
    const tool = createRepoTool({ root, buildPlugin: (d) => built.push(path.basename(d)), log: (l) => logs.push(l) });
    expect(tool.repository).toBe('acme/plugins');
    const first = tool.pack();
    expect(first.map((r) => r.file)).toEqual(['one-1.0.0.tgz', 'two-2.0.0.tgz']);
    expect(built).toEqual(['one', 'two']);
    const again = tool.pack();
    expect(again.map((r) => r.sha256)).toEqual(first.map((r) => r.sha256));

    expect(() => tool.index()).toThrow(/not signed/);
    for (const r of first) writeFileSync(path.join(tool.out, `${r.file}.minisig`), 'sig');
    const idx = tool.index();
    expect(idx).toMatchObject({ name: 'Acme', homepage: 'https://github.com/acme/plugins', publicKey: 'RWTESTKEY' });
    expect(idx.plugins[0]!.versions[0]).toMatchObject({
      url: 'https://github.com/acme/plugins/releases/download/one-v1.0.0/one-1.0.0.tgz',
      signature: 'sig',
    });

    // Released versions are skipped; a mismatched key is refused.
    mkdirSync(path.join(root, '.repo-current'));
    writeFileSync(path.join(root, '.repo-current/index.json'), JSON.stringify(idx));
    expect(tool.pack()).toEqual([]);
    writeFileSync(path.join(root, '.repo-current/index.json'), JSON.stringify({ ...idx, publicKey: 'OTHER' }));
    expect(() => tool.pack()).toThrow(/different public key/);
    writeFileSync(path.join(root, 'plugins/one/package.json'), JSON.stringify({ version: '9.9.9' }));
    rmSync(path.join(root, '.repo-current'), { recursive: true });
    expect(() => tool.pack()).toThrow(/differ/);
  });

  it('refuses to pack a plugin that fails its checks', () => {
    const root = work();
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ synoikia: { repository: 'acme/plugins', name: 'Acme' } }),
    );
    writeFileSync(path.join(root, 'minisign.pub'), 'untrusted comment: minisign public key\nRWTESTKEY\n');
    const dir = path.join(root, 'plugins', 'one');
    mkdirSync(path.join(dir, 'dist'), { recursive: true });
    // Result secrets core masks only from contract 0.2.2, under a range older cores accept.
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...packManifest('one', '1.0.0'), sdk: '^0.2.1' }));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@acme/plugin-one', version: '1.0.0' }));
    writeFileSync(path.join(dir, 'plugin.yaml'), 'rules:\n  - match: token.make\n    sensitiveResult: whole\n');
    const built: string[] = [];
    const tool = createRepoTool({ root, buildPlugin: (d) => built.push(d), log: () => undefined });
    expect(() => tool.pack()).toThrow(/plugins\/one: .*sensitiveResult/);
    expect(built).toEqual([]);
  });

  it('refuses an invalid repository name', () => {
    const root = work();
    writeFileSync(path.join(root, 'package.json'), '{}');
    expect(() => createRepoTool({ root, repository: 'not a repo' })).toThrow(/Invalid repository/);
  });
});
