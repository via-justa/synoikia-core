import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parsePluginSettings } from '@synoikia/plugin-sdk';
import { parse } from 'yaml';

/** Inlines a plugin's data files at build time: `.yaml` as validated JSON, `.md` as text. */

/** Parses YAML as plain data: no custom tags, and aliases capped against expansion bombs. */
export function parseYamlFile(file: string): unknown {
  const text = readFileSync(file, 'utf8');
  try {
    return parse(text, { maxAliasCount: 100 }) ?? {};
  } catch (err) {
    throw new Error(`${file}: ${(err as Error).message}`, { cause: err });
  }
}

/** Parses a YAML file; a file named `plugin.yaml` must also be valid plugin settings. */
export function loadYamlModule(file: string): unknown {
  const data = parseYamlFile(file);
  if (path.basename(file) === 'plugin.yaml') {
    try {
      parsePluginSettings(data);
    } catch (err) {
      throw new Error(`${file} is not valid plugin settings:\n${(err as Error).message}`, { cause: err });
    }
  }
  return data;
}

/** The ES module source a data file compiles to. */
export function moduleSource(file: string, contents?: string): string | undefined {
  if (/\.ya?ml$/.test(file)) return `export default ${JSON.stringify(loadYamlModule(file))};\n`;
  if (file.endsWith('.md')) return `export default ${JSON.stringify(contents ?? readFileSync(file, 'utf8'))};\n`;
  return undefined;
}
