import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Manifest } from '@synoikia/plugin-sdk';
import { eq } from 'drizzle-orm';
import semver from 'semver';
import { createAppContext } from '../app.js';
import { loadConfig } from '../config/env.js';
import { plugins } from '../db/schema.js';
import { PluginProcess, PluginRpcError } from '../plugins/process.js';
import { IndexSchema } from '../plugins/repos.js';

/** Where the index appears to live; relative tarball URLs resolve against it. */
const INDEX_URL = 'https://plugin-repository.test/index.json';

export interface VerifyRepositoryOptions {
  /** The built `index.json`. */
  index: string;
  /** Directory holding the tarballs, found by the file name of each version's `url`. */
  assets: string;
  /** The key the repository is published under (`RW…`), as admins will pin it. */
  publicKey: string;
}

export interface VerifiedPlugin {
  id: string;
  version: string;
  signatureVerified: boolean;
}

/** Checks a repository before publishing: installs the newest version of each plugin as core would
 * (pinned key, sha256, signature, archive checks) and starts each bundle. Throws on the first failure. */
export async function verifyPluginRepository(opts: VerifyRepositoryOptions): Promise<VerifiedPlugin[]> {
  const indexBytes = readFileSync(opts.index);
  const index = IndexSchema.parse(JSON.parse(indexBytes.toString('utf8')));
  const work = mkdtempSync(path.join(tmpdir(), 'synoikia-repo-check-'));
  const ctx = await createAppContext(loadConfig({ DATA_DIR: path.join(work, 'data') }), {
    memoryDb: true,
    repoFetch: async (url) => {
      if (url === INDEX_URL) return new Response(new Uint8Array(indexBytes));
      const file = path.join(opts.assets, path.basename(new URL(url).pathname));
      try {
        return new Response(new Uint8Array(readFileSync(file)));
      } catch {
        return new Response(`${url}: no ${file}`, { status: 404 });
      }
    },
  });
  try {
    const repo = await ctx.repos.add({ url: INDEX_URL, signingMode: 'signed', confirmPublicKey: opts.publicKey });
    const verified: VerifiedPlugin[] = [];
    for (const plugin of index.plugins) {
      const version = semver.rsort(plugin.versions.map((v) => v.version))[0];
      if (!version) throw new Error(`${plugin.id}: no versions`);
      try {
        await ctx.repos.install({ repoId: repo.id, pluginId: plugin.id, version });
      } catch (err) {
        throw new Error(`${plugin.id}@${version}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      const row = ctx.db.select().from(plugins).where(eq(plugins.pluginId, plugin.id)).get();
      if (row?.status !== 'ok') {
        throw new Error(`${plugin.id}@${version} does not load: ${row?.statusError ?? 'not discovered'}`);
      }
      await startsAndAnswers(row.path, (row.manifest as Manifest).entry, `${plugin.id}@${version}`);
      verified.push({ id: plugin.id, version, signatureVerified: row.signatureVerified });
    }
    return verified;
  } finally {
    await ctx.stop();
    rmSync(work, { recursive: true, force: true });
  }
}

/** Starts an installed bundle as core does and asks it to shut down (no `init`, so no upstream). */
async function startsAndAnswers(dir: string, entry: string, label: string) {
  const proc = new PluginProcess({ dir, entry, instanceId: 'repository-check', defaultTimeoutMs: 10_000 });
  const stderr: string[] = [];
  proc.on('log', (level, message) => level === 'error' && stderr.push(message));
  proc.start();
  try {
    await proc.call('shutdown');
  } catch (err) {
    if (!(err instanceof PluginRpcError)) {
      await new Promise((r) => setTimeout(r, 100)); // stderr can arrive just after the exit
      const detail = stderr
        .join('\n')
        .split('\n')
        .filter((l) => l.trim() && !/^\s+at /.test(l))
        .slice(0, 6)
        .join('\n');
      throw new Error(
        `${label} does not start: ${err instanceof Error ? err.message : String(err)}${detail ? `\n${detail}` : ''}`,
        {
          cause: err,
        },
      );
    }
  } finally {
    await proc.stop(2000);
  }
}
