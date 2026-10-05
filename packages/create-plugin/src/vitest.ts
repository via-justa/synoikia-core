import { moduleSource } from './files.js';

/** Vitest plugin loading `.yaml` and `.md` imports as `synoikia-plugin build` bundles them. */
export function pluginFiles() {
  return {
    name: 'synoikia-plugin-files',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?')[0]!;
      const source = moduleSource(file, file.endsWith('.md') ? code : undefined);
      return source === undefined ? undefined : { code: source, map: null };
    },
  };
}
