import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { checkManifest, isSdkCompatible, parseManifest, parsePluginSettings } from '@synoikia/plugin-sdk';
import type { PluginSettings } from '@synoikia/plugin-sdk';
import { parseYamlFile } from './files.js';

/** Static checks every plugin used to repeat: manifest, SDK range, secret fields, plugin.yaml and its
 * match profiles, id = directory, and matching versions. */
export function checkPlugin(dir: string): string[] {
  const read = (name: string) => JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as Record<string, unknown>;
  let manifest: unknown;
  try {
    manifest = read('manifest.json');
  } catch (err) {
    return [`manifest.json: ${(err as Error).message}`];
  }
  const issues: string[] = [];
  let settings: PluginSettings<unknown> | undefined;
  const yamlFile = path.join(dir, 'plugin.yaml');
  if (existsSync(yamlFile)) {
    try {
      settings = parsePluginSettings(parseYamlFile(yamlFile));
    } catch (err) {
      issues.push(`plugin.yaml: ${(err as Error).message}`);
    }
  }
  issues.push(...checkManifest(manifest, settings));
  if (issues.some((i) => i.startsWith('manifest:'))) return issues;
  const parsed = parseManifest(manifest);
  if (!isSdkCompatible(parsed)) issues.push(`manifest.json: sdk ${parsed.sdk} does not accept this SDK`);
  if (parsed.id !== path.basename(path.resolve(dir)))
    issues.push(`manifest.json: id ${parsed.id} is not the directory name ${path.basename(path.resolve(dir))}`);
  try {
    const pkg = read('package.json');
    if (pkg.version !== parsed.version)
      issues.push(`package.json version ${String(pkg.version)} and manifest.json version ${parsed.version} differ`);
  } catch (err) {
    issues.push(`package.json: ${(err as Error).message}`);
  }
  return issues;
}
