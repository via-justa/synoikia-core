import { randomBytes } from 'node:crypto';
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config/env.js';
import { loadMasterKey, MASTER_KEY_FILENAME, SecretBox } from './crypto/index.js';
import { rotateSecrets } from './crypto/rotate.js';
import { openDatabase } from './db/index.js';
import { assertServerStopped } from './lock.js';

/** Operator commands, server stopped: `node dist/cli.js rotate-master-key [--force]`. With MASTER_KEY set,
 * pass the new key as NEW_MASTER_KEY; with a key file, the new key is written as master.key.new first. */

const USAGE =
  'Usage: cli.js rotate-master-key [--force]   (stop the server first; --force skips the running-server check)';

export function rotateMasterKeyCommand(
  env: NodeJS.ProcessEnv,
  log: (line: string) => void = console.log,
  opts: { force?: boolean } = {},
) {
  const config = loadConfig(env);
  assertServerStopped(config.DATA_DIR, opts);
  const keyFile = path.join(config.DATA_DIR, MASTER_KEY_FILENAME);
  if (!config.MASTER_KEY && !existsSync(keyFile))
    throw new Error(`No master key: MASTER_KEY is unset and ${keyFile} does not exist`);
  const current = loadMasterKey({ envKey: config.MASTER_KEY, dataDir: config.DATA_DIR });

  let next: Buffer;
  if (env.NEW_MASTER_KEY) {
    next = Buffer.from(env.NEW_MASTER_KEY.trim(), 'base64');
    if (next.length !== 32)
      throw new Error('NEW_MASTER_KEY must be 32 bytes of base64 (e.g. `openssl rand -base64 32`)');
  } else if (current.source === 'env') {
    throw new Error('MASTER_KEY comes from the environment: set NEW_MASTER_KEY to the replacement key');
  } else {
    next = randomBytes(32);
  }
  if (next.equals(current.key)) throw new Error('The new key is the same as the current key');

  const db = openDatabase({ dataDir: config.DATA_DIR });
  const pending = `${keyFile}.new`;
  let committed = false;
  try {
    if (current.source === 'file') writeFileSync(pending, `${next.toString('base64')}\n`, { mode: 0o600 });
    const result = rotateSecrets(db, SecretBox.fromKey(current.key), SecretBox.fromKey(next));
    committed = true;
    // If this rename fails, master.key.new holds the only key that opens the database now.
    if (current.source === 'file') renameSync(pending, keyFile);
    log(
      `Re-encrypted ${result.instances} endpoint connection(s), ${result.notifiers} notifier(s), ` +
        `${result.users} TOTP secret(s) and ${result.oidc} OIDC secret(s); signed out ${result.sessionsCleared} session(s).`,
    );
    log(
      current.source === 'file'
        ? `New key written to ${keyFile}.`
        : 'Now set MASTER_KEY to the value of NEW_MASTER_KEY.',
    );
    return result;
  } catch (err) {
    if (current.source === 'file' && !committed) rmSync(pending, { force: true });
    throw err;
  } finally {
    db.$client.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...flags] = process.argv.slice(2);
  try {
    if (command === 'rotate-master-key' && flags.every((f) => f === '--force'))
      rotateMasterKeyCommand(process.env, console.log, { force: flags.includes('--force') });
    else {
      console.error(USAGE);
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
