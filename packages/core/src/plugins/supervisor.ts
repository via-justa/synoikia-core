import type { InitParams } from '@synoikia/plugin-sdk';
import { SDK_VERSION } from '@synoikia/plugin-sdk';
import { PluginProcess, PluginUnavailableError } from './process.js';
import type { SpawnOptions } from './process.js';

/**
 * Keeps one plugin instance's child process alive (design §4.4): spawn → `init` → ready. On an
 * unexpected exit the instance goes to `error` and restarts with exponential backoff. A crashed or
 * restarting plugin never makes the gate fail open: callers just get `PluginUnavailableError`.
 */

export type InstanceStatus = 'stopped' | 'starting' | 'ready' | 'error';

export interface SupervisorOptions extends SpawnOptions {
  /** Called on every start with this instance's config and freshly decrypted secrets. */
  loadInit: () => Omit<InitParams, 'sdkVersion' | 'instanceId'>;
  onStatus?: (status: InstanceStatus, error?: string) => void;
  onLog?: (level: string, message: string) => void;
  onCatalogChanged?: (reason?: string) => void;
  initTimeoutMs?: number;
  backoff?: { initialMs: number; maxMs: number };
}

export class PluginSupervisor {
  private proc?: PluginProcess;
  private _status: InstanceStatus = 'stopped';
  private stopping = false;
  private restartTimer?: NodeJS.Timeout;
  private attempt = 0;
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: SupervisorOptions) {}

  get status(): InstanceStatus {
    return this._status;
  }

  /** The live process for RPC calls. Throws unless the instance is ready. */
  get client(): PluginProcess {
    if (this._status !== 'ready' || !this.proc?.running) throw new PluginUnavailableError();
    return this.proc;
  }

  async start(): Promise<void> {
    return this.serial(async () => {
      this.stopping = false;
      if (this.proc) return; // already running or starting
      await this.spawn();
    });
  }

  async stop(): Promise<void> {
    this.halt();
    return this.serial(() => this.shutdown());
  }

  /** Restart now (e.g. after the admin changed the connection config or secrets). */
  async restart(): Promise<void> {
    this.halt();
    return this.serial(async () => {
      await this.shutdown();
      this.attempt = 0;
      this.stopping = false;
      await this.spawn();
    });
  }

  /**
   * Lifecycle changes run one at a time, so concurrent restarts can't leave two children alive and a
   * stop can't be undone by a start that was already under way.
   */
  private serial(fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Supersedes whatever is in flight at once: a child still in `init` is killed, not waited for. */
  private halt() {
    this.stopping = true;
    this.generation++;
    clearTimeout(this.restartTimer);
    if (this._status === 'starting') this.proc?.kill();
  }

  private async shutdown() {
    this.stopping = true;
    this.generation++;
    clearTimeout(this.restartTimer);
    const proc = this.proc;
    this.proc = undefined;
    await proc?.stop();
    this.setStatus('stopped');
  }

  private setStatus(status: InstanceStatus, error?: string) {
    this._status = status;
    this.opts.onStatus?.(status, error);
  }

  private async spawn(): Promise<void> {
    const generation = ++this.generation;
    this.setStatus('starting');
    const proc = new PluginProcess(this.opts);
    this.proc = proc;
    proc.on('log', (level, message) => this.opts.onLog?.(level, message));
    proc.on('catalogChanged', (reason) => this.opts.onCatalogChanged?.(reason));
    proc.on('exit', (code, signal) => {
      if (this.stopping || generation !== this.generation) return;
      this.scheduleRestart(`plugin exited unexpectedly (${signal ?? `code ${code}`})`);
    });
    try {
      // Before the fork: what loadInit records about the bundle (its version) describes the code the
      // child is about to load, not whatever replaced it after.
      const init = this.opts.loadInit();
      proc.start();
      await proc.call(
        'init',
        { ...init, instanceId: this.opts.instanceId, sdkVersion: SDK_VERSION },
        this.opts.initTimeoutMs ?? 30_000,
      );
    } catch (err) {
      proc.kill();
      if (generation !== this.generation) return;
      this.scheduleRestart(`init failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (generation !== this.generation) {
      // Superseded (stopped or restarted) during init: this child must not outlive its turn.
      proc.kill();
      return;
    }
    this.attempt = 0;
    this.setStatus('ready');
  }

  private scheduleRestart(reason: string) {
    if (this.stopping) return;
    this.generation++;
    this.proc = undefined;
    this.setStatus('error', reason);
    const { initialMs, maxMs } = this.opts.backoff ?? { initialMs: 1000, maxMs: 60_000 };
    const delay = Math.min(maxMs, initialMs * 2 ** this.attempt++);
    clearTimeout(this.restartTimer);
    const generation = this.generation;
    this.restartTimer = setTimeout(() => {
      void this.serial(async () => {
        if (!this.stopping && generation === this.generation) await this.spawn();
      });
    }, delay);
  }
}
