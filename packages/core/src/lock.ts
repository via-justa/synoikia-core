import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

/** A running server holds `DATA_DIR/server.lock` (pid, host); offline commands such as
 * `rotate-master-key` refuse while it is held. */

export const LOCK_FILENAME = 'server.lock';

interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

const lockPath = (dataDir: string) => path.join(dataDir, LOCK_FILENAME);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

function readLock(dataDir: string): LockInfo | null {
  try {
    const info = JSON.parse(readFileSync(lockPath(dataDir), 'utf8')) as LockInfo;
    return typeof info?.pid === 'number' && typeof info.host === 'string' ? info : null;
  } catch {
    return null;
  }
}

/** The live lock holder, or null if free or stale; a lock from another host always counts as held. */
function lockHolder(dataDir: string): LockInfo | null {
  const info = readLock(dataDir);
  if (!info || info.pid === process.pid) return null;
  if (info.host !== hostname()) return info;
  return alive(info.pid) ? info : null;
}

/** Takes the lock (throws if a live server on this host holds it; another host's lock is taken over
 * with a warning, since a recreated container has a new hostname). Returns the release. */
export function acquireServerLock(
  dataDir: string,
  warn: (message: string) => void = (m) => console.warn(`WARN ${m}`),
): () => void {
  const previous = readLock(dataDir);
  if (previous && previous.pid !== process.pid) {
    if (previous.host === hostname()) {
      if (alive(previous.pid)) throw new Error(`Another server (pid ${previous.pid}) is using ${dataDir}`);
    } else {
      warn(
        `${lockPath(dataDir)} was held by pid ${previous.pid} on host ${previous.host}; taking it over. ` +
          'Two servers must never share a data directory.',
      );
    }
  }
  const info: LockInfo = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
  writeFileSync(lockPath(dataDir), `${JSON.stringify(info)}\n`, { mode: 0o600 });
  return () => {
    if (readLock(dataDir)?.pid === process.pid && readLock(dataDir)?.host === hostname())
      rmSync(lockPath(dataDir), { force: true });
  };
}

/** For offline commands: throws while a server may be running on this data directory, unless forced. */
export function assertServerStopped(dataDir: string, opts: { force?: boolean } = {}) {
  if (opts.force) return;
  const holder = lockHolder(dataDir);
  if (!holder) return;
  const where = holder.host === hostname() ? `pid ${holder.pid}` : `pid ${holder.pid} on host ${holder.host}`;
  throw new Error(
    `The server may be running (${where}, since ${holder.startedAt}); stop it first. ` +
      `If it is really stopped, run again with --force (or delete ${lockPath(dataDir)}).`,
  );
}
