#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { askPluginOptions, PLUGIN_FLAGS, prompts } from './prompts.js';
import { createRepo, install, newPlugin } from './scaffold.js';

/** `pnpm create @synoikia/plugin <dir>`: a new plugin repository, then its first plugin. */

const USAGE = `create-plugin <dir> [--repository owner/name] [--release] [--claude] [--no-plugin]
                   [plugin flags, see: synoikia-plugin new]`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ...PLUGIN_FLAGS,
      repository: { type: 'string' },
      release: { type: 'boolean' },
      claude: { type: 'boolean' },
      'no-plugin': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.error(USAGE);
    return values.help ? 0 : 2;
  }
  const dir = path.resolve(positionals[0]!);
  prompts.intro(`Creating a Synoikia plugin repository in ${dir}`);
  const ask = !values.yes && process.stdin.isTTY === true;
  const release =
    values.release ??
    (ask
      ? await prompts.confirm({ message: 'Add the signed-release workflow (publishes a plugin repository)?' })
      : false);
  const claude =
    values.claude ??
    (ask
      ? await prompts.confirm({ message: 'Add the Claude Code setup (CLAUDE.md, skills, security reviewer)?' })
      : false);
  if (prompts.isCancel(release) || prompts.isCancel(claude)) return 1;
  createRepo({ dir, repository: values.repository, release, claude });
  if (!values['no-plugin']) {
    const opts = await askPluginOptions(dir, values);
    newPlugin(opts);
    prompts.log.success(`Created plugins/${opts.id}`);
  }
  if (!values['skip-install']) install(dir);
  prompts.outro(`Done. cd ${path.relative(process.cwd(), dir) || '.'} && pnpm test`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
