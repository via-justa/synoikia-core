import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkPlugin } from './check.js';

/**
 * Builds a signed plugin repository that Synoikia installs plugins from (design §4.2–4.3). Every
 * plugin version is a GitHub release `<id>-v<version>` holding `<id>-<version>.tgz` and its minisign
 * signature; `index.json` lists every released version and lives on the fixed `index` release. A
 * release workflow runs the steps in order, signing between `pack` and `index`:
 *
 *   pack     build and pack each plugin whose manifest version isn't in the current index yet
 *   index    merge the new versions, with their signatures, into the current index
 *   verify   install the new versions with Synoikia's own repository service, pinned to minisign.pub
 *   publish  create the version releases, then replace index.json on the `index` release
 *
 * Released versions are never rebuilt or removed: to ship a change, bump the plugin's version.
 */

export interface RepoOptions {
  /** The repository root (holding `plugins/` and `minisign.pub`). */
  root: string;
  /** `owner/name` on GitHub. Default: root package.json `synoikia.repository`, else the `origin` remote. */
  repository?: string;
  /** Output directory, relative to the root. Default `.repo`. */
  out?: string;
  /** The currently published index, relative to the root. Default `.repo-current/index.json`. */
  current?: string;
  /** Command that builds one plugin (receives the plugin directory). Default `pnpm --filter <dir> run build`. */
  buildPlugin?: (dir: string) => void;
  log?: (line: string) => void;
}

interface Release {
  id: string;
  version: string;
  tag: string;
  file: string;
  sha256: string;
  name: string;
  description?: string;
  sdk: string;
  minCoreVersion?: string;
}

interface IndexVersion {
  version: string;
  sdk: string;
  minCoreVersion?: string;
  url: string;
  sha256: string;
  signature: string;
}

interface RepoIndex {
  schema: number;
  name: string;
  homepage: string;
  publicKey: string;
  plugins: { id: string; name: string; description?: string; versions: IndexVersion[] }[];
}

const INDEX_TAG = 'index';

const readJson = <T = Record<string, unknown>>(file: string) => JSON.parse(readFileSync(file, 'utf8')) as T;

/** `git@github.com:owner/name.git` or `https://github.com/owner/name(.git)` → `owner/name`. */
export function repositoryFromRemote(remote: string): string | undefined {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

function resolveRepository(root: string, explicit?: string): string {
  if (explicit) return explicit;
  const pkg = readJson<{ synoikia?: { repository?: string } }>(path.join(root, 'package.json'));
  if (pkg.synoikia?.repository) return pkg.synoikia.repository;
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' });
    const repo = repositoryFromRemote(remote);
    if (repo) return repo;
  } catch {
    // no git remote
  }
  throw new Error('Set "synoikia": { "repository": "owner/name" } in package.json, or pass --repository');
}

export function createRepoTool(opts: RepoOptions) {
  const root = path.resolve(opts.root);
  const repository = resolveRepository(root, opts.repository);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error(`Invalid repository ${repository}`);
  const downloadBase = `https://github.com/${repository}/releases/download`;
  const out = path.resolve(root, opts.out ?? '.repo');
  const releasesFile = path.join(out, 'releases.json');
  const log = opts.log ?? ((line: string) => console.log(line));
  const indexName = readJson<{ synoikia?: { name?: string } }>(path.join(root, 'package.json')).synoikia?.name;
  const publicKey = () => readFileSync(path.join(root, 'minisign.pub'), 'utf8').trim().split('\n').at(-1)!.trim();
  const buildPlugin =
    opts.buildPlugin ??
    ((dir: string) =>
      execFileSync('pnpm', ['--filter', `./${path.relative(root, dir)}`, 'run', 'build'], {
        cwd: root,
        stdio: 'inherit',
      }));

  function currentIndex(): RepoIndex {
    const file = path.resolve(root, opts.current ?? '.repo-current/index.json');
    const empty: RepoIndex = {
      schema: 1,
      name: indexName ?? 'Synoikia plugins',
      homepage: `https://github.com/${repository}`,
      publicKey: publicKey(),
      plugins: [],
    };
    if (!existsSync(file)) return empty;
    const index = readJson<RepoIndex>(file);
    if (index.publicKey !== empty.publicKey) {
      throw new Error('The published index has a different public key than minisign.pub; refusing to extend it.');
    }
    return index;
  }

  const released = (index: RepoIndex, id: string, version: string) =>
    index.plugins.some((p) => p.id === id && p.versions.some((v) => v.version === version));

  function pack(): Release[] {
    const index = currentIndex();
    mkdirSync(out, { recursive: true });
    const releases: Release[] = [];
    const pluginsDir = path.join(root, 'plugins');
    for (const id of readdirSync(pluginsDir).sort()) {
      const dir = path.join(pluginsDir, id);
      if (!existsSync(path.join(dir, 'manifest.json'))) continue;
      const manifest = readJson<{ id: string; version: string; name: string; description?: string; sdk: string }>(
        path.join(dir, 'manifest.json'),
      );
      const pkg = readJson<{ version: string; synoikia?: { minCoreVersion?: string } }>(path.join(dir, 'package.json'));
      if (manifest.id !== id) throw new Error(`plugins/${id}: manifest id is ${manifest.id}`);
      if (pkg.version !== manifest.version) {
        throw new Error(`plugins/${id}: package.json ${pkg.version} and manifest.json ${manifest.version} differ`);
      }
      if (released(index, id, manifest.version)) continue;
      // The same checks the plugin's own tests run, so a release can't skip them.
      const issues = checkPlugin(dir);
      if (issues.length) throw new Error(`plugins/${id}: ${issues.join('; ')}`);

      buildPlugin(dir);
      const file = `${id}-${manifest.version}.tgz`;
      // Flat layout, what core installs: manifest.json, package.json, dist/. Sorted, with fixed times and
      // owners, so the same sources give the same bytes.
      const tarball = execFileSync(
        'tar',
        [
          '--sort=name',
          '--mtime=1970-01-01 00:00:00Z',
          '--owner=0',
          '--group=0',
          '--numeric-owner',
          '-C',
          dir,
          '-cf',
          '-',
          'manifest.json',
          'package.json',
          'dist',
        ],
        { maxBuffer: 256 * 1024 * 1024 },
      );
      const gz = execFileSync('gzip', ['-n', '-9'], { input: tarball, maxBuffer: 256 * 1024 * 1024 });
      writeFileSync(path.join(out, file), gz);
      releases.push({
        id,
        version: manifest.version,
        tag: `${id}-v${manifest.version}`,
        file,
        sha256: createHash('sha256').update(gz).digest('hex'),
        name: manifest.name,
        description: manifest.description,
        sdk: manifest.sdk,
        minCoreVersion: pkg.synoikia?.minCoreVersion,
      });
      log(`packed ${file}`);
    }
    writeFileSync(releasesFile, JSON.stringify(releases, null, 2) + '\n');
    log(releases.length ? `${releases.length} new version(s)` : 'nothing new to release');
    return releases;
  }

  function index(): RepoIndex {
    const idx = currentIndex();
    for (const r of readJson<Release[]>(releasesFile)) {
      const sigFile = path.join(out, `${r.file}.minisig`);
      if (!existsSync(sigFile)) throw new Error(`${r.file} is not signed`);
      let plugin = idx.plugins.find((p) => p.id === r.id);
      if (!plugin) idx.plugins.push((plugin = { id: r.id, name: r.name, versions: [] }));
      plugin.name = r.name;
      if (r.description) plugin.description = r.description;
      plugin.versions.push({
        version: r.version,
        sdk: r.sdk,
        ...(r.minCoreVersion ? { minCoreVersion: r.minCoreVersion } : {}),
        url: `${downloadBase}/${r.tag}/${r.file}`,
        sha256: r.sha256,
        signature: readFileSync(sigFile, 'utf8'),
      });
    }
    idx.plugins.sort((a, b) => a.id.localeCompare(b.id));
    writeFileSync(path.join(out, 'index.json'), JSON.stringify(idx, null, 2) + '\n');
    return idx;
  }

  async function verify(): Promise<void> {
    const releases = readJson<Release[]>(releasesFile);
    if (!releases.length) return log('nothing to verify');
    // Only this run's versions are local; the check installs exactly those, from the index as published.
    const full = readJson<RepoIndex>(path.join(out, 'index.json'));
    const subset = {
      ...full,
      plugins: full.plugins
        .map((p) => ({
          ...p,
          versions: p.versions.filter((v) => releases.some((r) => r.id === p.id && r.version === v.version)),
        }))
        .filter((p) => p.versions.length),
    };
    const file = path.join(out, 'verify-index.json');
    writeFileSync(file, JSON.stringify(subset));
    let testing: typeof import('@synoikia/core/testing');
    try {
      testing = await import('@synoikia/core/testing');
    } catch {
      throw new Error('verify needs @synoikia/core installed (a dev dependency of the plugin repository)');
    }
    const verified = await testing.verifyPluginRepository({ index: file, assets: out, publicKey: publicKey() });
    for (const v of verified) {
      if (!v.signatureVerified) throw new Error(`${v.id}@${v.version}: signature not verified`);
      log(`verified ${v.id}@${v.version}`);
    }
  }

  function publish(): void {
    const releases = readJson<Release[]>(releasesFile);
    if (!releases.length) return log('nothing to publish');
    const gh = (...a: string[]) => execFileSync('gh', a, { cwd: root, stdio: 'inherit' });
    const exists = (tag: string) => {
      try {
        execFileSync('gh', ['release', 'view', tag], { cwd: root, stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    };
    for (const r of releases) {
      const tarball = path.join(out, r.file);
      // Left by a run that stopped before updating the index. Released bytes never change: continue only
      // if the tarball there is exactly this run's (packing is deterministic), and only then refresh its
      // signature, which the index about to be published carries.
      if (exists(r.tag)) {
        const dir = mkdtempSync(path.join(tmpdir(), 'synoikia-release-'));
        try {
          execFileSync('gh', ['release', 'download', r.tag, '--pattern', r.file, '--dir', dir], {
            cwd: root,
            stdio: 'ignore',
          });
          const published = createHash('sha256')
            .update(readFileSync(path.join(dir, r.file)))
            .digest('hex');
          if (published !== r.sha256)
            throw new Error(`${r.tag} is already released with different contents; bump the version instead`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
        gh('release', 'upload', r.tag, `${tarball}.minisig`, '--clobber');
        continue;
      }
      gh(
        'release',
        'create',
        r.tag,
        tarball,
        `${tarball}.minisig`,
        '--title',
        `${r.name} ${r.version}`,
        '--notes',
        `${r.name} ${r.version}, signed with the key in minisign.pub. Install it from Synoikia's Plugins page.`,
        '--latest=false',
      );
    }
    if (!exists(INDEX_TAG)) {
      gh(
        'release',
        'create',
        INDEX_TAG,
        '--title',
        'Plugin index',
        '--notes',
        'The index Synoikia reads this repository from. Replaced on every release.',
        '--latest=false',
      );
    }
    gh('release', 'upload', INDEX_TAG, path.join(out, 'index.json'), '--clobber');
  }

  return { repository, out, pack, index, verify, publish };
}
