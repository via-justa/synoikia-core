import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The plugin repository root: the nearest directory up from `start` with a `pnpm-workspace.yaml`. */
export function findRepoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No plugin repository (pnpm-workspace.yaml) above ${start}`);
    dir = parent;
  }
}

/** This package's directory. */
export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATES_DIR = path.join(PACKAGE_DIR, 'templates');

function installedVersion(name: string): string | undefined {
  let dir = PACKAGE_DIR;
  for (;;) {
    const file = path.join(dir, 'node_modules', ...name.split('/'), 'package.json');
    if (existsSync(file)) return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The range generated packages use for one of this tool's dependencies: as published, else installed. */
export function dependencyRange(name: string): string {
  const own = JSON.parse(readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  if (name === own.name) return `^${own.version}`;
  const declared = own.dependencies?.[name] ?? own.peerDependencies?.[name] ?? own.devDependencies?.[name];
  if (declared && !declared.startsWith('workspace:')) return declared;
  const version = installedVersion(name);
  if (!version) throw new Error(`Cannot tell which version of ${name} to use`);
  return `^${version}`;
}
