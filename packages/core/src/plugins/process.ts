import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import {
  GuideSchema,
  OptionSchema,
  PrepareWriteResultSchema,
  RegistryEntrySchema,
  ResolvedTargetSchema,
  ResolveOperationResultSchema,
  SummarizeResultSchema,
  SyncCatalogResultSchema,
  TestConnectionResultSchema,
} from '@synoikia/plugin-sdk';
import type { ErrorCode, PluginHandlers, RpcMethod, RpcNotification, RpcResponse } from '@synoikia/plugin-sdk';
import { z } from 'zod';

/** One plugin child and its JSON-RPC-over-IPC channel (design §3.3, §4.4); every result is validated. */

export class PluginRpcError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'PluginRpcError';
  }
}

/** The child is not running (never started, crashed, or stopped). Callers surface `PluginUnavailable`. */
export class PluginUnavailableError extends Error {
  constructor(message = 'Plugin process is not available') {
    super(message);
    this.name = 'PluginUnavailableError';
  }
}

export class PluginTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`Plugin did not answer ${method} within ${ms} ms`);
    this.name = 'PluginTimeoutError';
  }
}

/** The plugin answered with something that violates the contract. */
export class PluginProtocolError extends Error {
  constructor(method: string, detail: string) {
    super(`Invalid ${method} result from plugin: ${detail}`);
    this.name = 'PluginProtocolError';
  }
}

const nullish = z.unknown().transform(() => null);
const RESULT_SCHEMAS: { [M in RpcMethod]: z.ZodType } = {
  init: nullish,
  testConnection: TestConnectionResultSchema,
  getUpstreamVersion: z.string().min(1),
  syncCatalog: SyncCatalogResultSchema,
  syncRegistry: z.array(RegistryEntrySchema),
  resolveOperation: ResolveOperationResultSchema,
  resolveTargets: z.array(ResolvedTargetSchema),
  summarize: SummarizeResultSchema,
  prepareWrite: PrepareWriteResultSchema,
  invoke: z.unknown(),
  optionsFor: z.array(OptionSchema),
  getGuide: GuideSchema,
  shutdown: nullish,
};

type Params<M extends RpcMethod> = Parameters<NonNullable<PluginHandlers[M]>>[0];
type Result<M extends RpcMethod> = Awaited<ReturnType<NonNullable<PluginHandlers[M]>>>;

export interface SpawnOptions {
  /** Plugin package directory; the only path the child may read. */
  dir: string;
  entry: string;
  instanceId: string;
  memoryMb?: number;
  defaultTimeoutMs?: number;
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface PluginProcessEvents {
  exit: [code: number | null, signal: NodeJS.Signals | null];
  log: [level: string, message: string];
  catalogChanged: [reason?: string];
}

export class PluginProcess extends EventEmitter<PluginProcessEvents> {
  private child?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private exited = false;

  constructor(private readonly opts: SpawnOptions) {
    super();
  }

  get running(): boolean {
    return !!this.child && !this.exited;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Forks the entry under the Node permission model: read-only access to its own dir, nothing else. */
  start(): void {
    if (this.child) throw new Error('Plugin process already started');
    // The permission model checks real paths, but the grant is taken literally: through a symlinked dir (macOS's
    // /var -> /private/var tmpdir, a symlinked DATA_DIR) the child could not even load its own entry.
    const dir = realpathSync(path.resolve(this.opts.dir));
    this.child = fork(path.resolve(dir, this.opts.entry), [], {
      cwd: dir,
      execArgv: ['--permission', `--allow-fs-read=${dir}`, `--max-old-space-size=${this.opts.memoryMb ?? 256}`],
      // Scrubbed environment: no MASTER_KEY, DB paths or admin config ever reach the plugin.
      env: { NODE_ENV: process.env.NODE_ENV ?? 'production', PLUGIN_INSTANCE_ID: this.opts.instanceId },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    });
    this.child.stdout?.on('data', (d: Buffer) => this.emit('log', 'info', d.toString().trimEnd()));
    this.child.stderr?.on('data', (d: Buffer) => this.emit('log', 'error', d.toString().trimEnd()));
    this.child.on('message', (msg) => this.onMessage(msg));
    this.child.on('error', (err) => this.emit('log', 'error', `plugin process error: ${err.message}`));
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new PluginUnavailableError(`Plugin exited (${signal ?? code}) during ${p.method}`));
      }
      this.pending.clear();
      this.emit('exit', code, signal);
    });
  }

  async call<M extends RpcMethod>(method: M, params?: Params<M>, timeoutMs?: number): Promise<Result<M>> {
    const child = this.child;
    if (!child || this.exited || !child.connected) throw new PluginUnavailableError();
    const id = this.nextId++;
    const ms = timeoutMs ?? this.opts.defaultTimeoutMs ?? 30_000;
    const raw = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PluginTimeoutError(method, ms));
      }, ms);
      this.pending.set(id, { method, resolve, reject, timer });
      child.send({ jsonrpc: '2.0', id, method, params }, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new PluginUnavailableError(`Could not send ${method}: ${err.message}`));
      });
    });
    const parsed = RESULT_SCHEMAS[method].safeParse(raw);
    if (!parsed.success) {
      throw new PluginProtocolError(
        method,
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      );
    }
    return parsed.data as Result<M>;
  }

  /** Graceful stop: `shutdown` RPC, then SIGKILL if the child hasn't exited within `graceMs`. */
  async stop(graceMs = 2000): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    this.call('shutdown', undefined, graceMs).catch(() => undefined);
    const killTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    await exited;
    clearTimeout(killTimer);
  }

  kill(): void {
    this.child?.kill('SIGKILL');
  }

  private onMessage(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null || (msg as { jsonrpc?: unknown }).jsonrpc !== '2.0') return;
    if ('id' in msg && typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      const res = msg as RpcResponse;
      if ('error' in res) pending.reject(new PluginRpcError(res.error.code, res.error.message, res.error.data));
      else pending.resolve(res.result);
      return;
    }
    const note = msg as RpcNotification;
    if (note.method === 'log') this.emit('log', note.params.level, note.params.message);
    else if (note.method === 'catalogChanged') this.emit('catalogChanged', note.params?.reason);
  }
}
