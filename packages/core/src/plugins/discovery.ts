import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isSdkCompatible, parseManifest, SDK_VERSION } from '@synoikia/plugin-sdk';
import type { Manifest } from '@synoikia/plugin-sdk';
import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { writeAudit } from '../audit.js';
import type { Db } from '../db/index.js';
import { plugins } from '../db/schema.js';

/** Plugin discovery (design §4.1): the plugins installed in `DATA_DIR/plugins`. */

export type DiscoveredPlugin =
  | { status: 'ok'; dir: string; manifest: Manifest }
  | {
      status: 'invalid' | 'incompatible';
      dir: string;
      manifest?: Manifest;
      pluginId: string;
      error: string;
    };

function explain(err: unknown): string {
  if (err instanceof ZodError) return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  return err instanceof Error ? err.message : String(err);
}

export function inspectPluginDir(dir: string): DiscoveredPlugin {
  const fallbackId = path.basename(dir);
  let manifest: Manifest;
  try {
    manifest = parseManifest(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
  } catch (err) {
    return { status: 'invalid', dir, pluginId: fallbackId, error: `manifest.json: ${explain(err)}` };
  }
  const entry = path.join(dir, manifest.entry);
  if (!existsSync(entry)) {
    return {
      status: 'invalid',
      dir,
      manifest,
      pluginId: manifest.id,
      error: `entry ${manifest.entry} not found (not built?)`,
    };
  }
  // The child may only read its own directory (design §4.4), so the entry must not escape it via symlinks.
  const realDir = realpathSync(dir);
  if (!realpathSync(entry).startsWith(realDir + path.sep)) {
    return {
      status: 'invalid',
      dir,
      manifest,
      pluginId: manifest.id,
      error: 'entry resolves outside the plugin directory',
    };
  }
  if (!isSdkCompatible(manifest)) {
    return {
      status: 'incompatible',
      dir,
      manifest,
      pluginId: manifest.id,
      error: `requires plugin SDK ${manifest.sdk}; core implements ${SDK_VERSION}`,
    };
  }
  return { status: 'ok', dir, manifest };
}

/** Scans the plugins directory's immediate subdirectories that contain a manifest.json. */
export function discoverPlugins(root: string): DiscoveredPlugin[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .map((name) => path.join(root, name))
    .filter((dir) => statSync(dir).isDirectory() && existsSync(path.join(dir, 'manifest.json')))
    .map((dir) => inspectPluginDir(dir));
}

const pluginIdOf = (p: DiscoveredPlugin) => (p.status === 'ok' ? p.manifest.id : p.pluginId);

/** Upserts discovered plugins: new ones start disabled (design §4.2), duplicate ids keep the first, and
 * missing ones are marked invalid, never deleted. */
export function syncPluginRegistry(
  db: Db,
  discovered: DiscoveredPlugin[],
  opts: { now?: Date } = {},
): { added: string[]; updated: string[]; missing: string[]; rejected: string[] } {
  const now = opts.now ?? new Date();
  const out = { added: [] as string[], updated: [] as string[], missing: [] as string[], rejected: [] as string[] };

  db.transaction((tx) => {
    const existing = new Map(
      tx
        .select()
        .from(plugins)
        .all()
        .map((p) => [p.pluginId, p]),
    );
    const seen = new Set<string>();
    for (const p of discovered) {
      const pluginId = pluginIdOf(p);
      if (seen.has(pluginId)) {
        out.rejected.push(pluginId);
        continue;
      }
      seen.add(pluginId);
      const fields = {
        version: p.manifest?.version ?? '0.0.0',
        path: p.dir,
        manifest: p.manifest ?? {},
        status: p.status,
        statusError: p.status === 'ok' ? null : p.error,
      };
      const prev = existing.get(pluginId);
      if (!prev) {
        tx.insert(plugins)
          .values({ id: randomUUID(), pluginId, ...fields, enabled: false, installedAt: now })
          .run();
        out.added.push(pluginId);
        writeAudit(
          tx,
          {
            kind: 'plugin',
            decision: 'plugin_discovered',
            actorKind: 'system',
            detail: { pluginId, ...fields, manifest: undefined, enabled: false },
          },
          now,
        );
      } else {
        tx.update(plugins).set(fields).where(eq(plugins.id, prev.id)).run();
        out.updated.push(pluginId);
      }
    }
    for (const prev of existing.values()) {
      if (!seen.has(prev.pluginId) && prev.status !== 'invalid') {
        tx.update(plugins)
          .set({ status: 'invalid', statusError: 'plugin directory not found' })
          .where(eq(plugins.id, prev.id))
          .run();
        out.missing.push(prev.pluginId);
      }
    }
  });
  return out;
}
