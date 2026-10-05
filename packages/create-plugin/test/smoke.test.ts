import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPlugin } from '../src/build.js';
import { checkPlugin } from '../src/check.js';
import { PACKAGE_DIR } from '../src/repo-root.js';
import { createRepo, newPlugin } from '../src/scaffold.js';
import type { Archetype, AuthKind } from '../src/scaffold.js';

/** Every template scaffolded fresh must pass check, typecheck, build and its own unit and e2e tests,
 * against this commit's SDK and core sources. */

const SMOKE = path.join(PACKAGE_DIR, '.smoke');
const require = createRequire(import.meta.url);
const TSC = require.resolve('typescript/bin/tsc');
const VITEST = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const RANGES = { sdk: 'workspace:*', core: 'workspace:*', cli: 'workspace:*' };

const CASES: [Archetype, AuthKind][] = [
  ['openapi-rest', 'bearer'],
  ['openapi-rest', 'api-key'],
  ['openapi-rest', 'basic'],
  ['openapi-rest', 'none'],
  ['static-rest', 'api-key'],
  ['websocket-rpc', 'bearer'],
  ['blank', 'none'],
];

const only = process.env.SMOKE_ONLY;

describe.each(CASES.filter(([a, auth]) => !only || only === `${a}-${auth}`))('%s with %s auth', (archetype, auth) => {
  it('checks, typechecks, builds and passes its own tests', async () => {
    const root = path.join(SMOKE, `${archetype}-${auth}`);
    rmSync(root, { recursive: true, force: true });
    createRepo({ dir: root, repository: 'acme/plugins', release: true, claude: true, ranges: RANGES });
    newPlugin({ root, id: 'acme-box', name: 'Acme Box', archetype, auth, ranges: RANGES });
    const dir = path.join(root, 'plugins', 'acme-box');

    expect(checkPlugin(dir)).toEqual([]);
    for (const f of ['manifest.json', 'plugin.yaml', 'src/plugin.ts', 'src/auth.ts', 'README.md']) {
      expect(existsSync(path.join(dir, f)), f).toBe(true);
    }
    expect(readFileSync(path.join(dir, 'src/plugin.ts'), 'utf8')).not.toMatch(/\{\{[a-zA-Z]+\}\}/);

    execFileSync(
      process.execPath,
      [TSC, '-p', path.join(dir, 'tsconfig.json'), '--customConditions', 'synoikia-source'],
      {
        stdio: 'pipe',
      },
    );
    await buildPlugin({ dir, conditions: ['synoikia-source'] });

    // The repository's own vitest.shared.ts, with the plugin-files loader taken from this checkout.
    const config = path.join(root, 'vitest.smoke.mts');
    writeFileSync(
      config,
      `import { defineConfig } from 'vitest/config';
import { pluginFiles } from ${JSON.stringify(path.join(PACKAGE_DIR, 'src/vitest.ts'))};
const conditions = ['synoikia-source', 'module', 'node', 'development|production'];
export default defineConfig({
  plugins: [pluginFiles()],
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: { include: ['test/**/*.test.ts'], execArgv: ['--no-node-snapshot'], testTimeout: 60000, hookTimeout: 60000 },
});
`,
    );
    try {
      execFileSync(process.execPath, [VITEST, 'run', '--root', dir, '--config', config], {
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`generated tests failed:\n${e.stdout ?? ''}\n${e.stderr ?? ''}`, { cause: err });
    }
  });
});
