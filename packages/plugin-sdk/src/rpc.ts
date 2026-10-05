import type {
  Guide,
  Option,
  PrepareWriteResult,
  RegistryEntry,
  ResolvedTarget,
  ResolveOperationResult,
  SummarizeResult,
  SyncCatalogResult,
  TestConnectionResult,
} from './operations.js';
import type { ErrorCode } from './errors.js';

type MaybePromise<T> = T | Promise<T>;

export interface InitParams {
  instanceId: string;
  /** Non-secret connection fields. */
  config: Record<string, unknown>;
  /** Decrypted `writeOnly` connection fields for this instance only. Never logged. */
  secrets: Record<string, string>;
  sdkVersion: string;
}

export interface InvokeContext {
  /** Audit correlation id; plugins may include it in upstream logs. */
  callId: string;
  /** Returned by `prepareWrite`, for optimistic locking at write time. */
  expectedHash?: string;
  /** Milliseconds left in the sandbox budget. */
  deadlineMs: number;
  /** With `targets`: exactly the targets the approver saw; act on these rather than resolving again. */
  targets?: ResolvedTarget[];
}

/** The plugin side of the core ⇄ plugin contract (design §3.3), one params object per handler. */
export interface PluginHandlers {
  init(params: InitParams): MaybePromise<void>;
  testConnection(): MaybePromise<TestConnectionResult>;
  getUpstreamVersion(): MaybePromise<string>;
  syncCatalog(): MaybePromise<SyncCatalogResult>;
  syncRegistry?(): MaybePromise<RegistryEntry[]>;
  resolveOperation(params: { fn: string; args: unknown[] }): MaybePromise<ResolveOperationResult>;
  resolveTargets?(params: { key: string; params: unknown }): MaybePromise<ResolvedTarget[]>;
  /** `params` arrive redacted (sensitive keys replaced): summaries end up in prompts, the DB and notifications. */
  summarize(params: { key: string; params: unknown; targets: ResolvedTarget[] }): MaybePromise<SummarizeResult>;
  prepareWrite?(params: { key: string; params: unknown }): MaybePromise<PrepareWriteResult>;
  invoke(params: { key: string; params: unknown; context: InvokeContext }): MaybePromise<unknown>;
  optionsFor?(params: { source: string; query?: string }): MaybePromise<Option[]>;
  getGuide?(params: { key: string }): MaybePromise<Guide>;
  shutdown?(): MaybePromise<void>;
}

export type RpcMethod = keyof PluginHandlers;

export const RPC_METHODS = [
  'init',
  'testConnection',
  'getUpstreamVersion',
  'syncCatalog',
  'syncRegistry',
  'resolveOperation',
  'resolveTargets',
  'summarize',
  'prepareWrite',
  'invoke',
  'optionsFor',
  'getGuide',
  'shutdown',
] as const satisfies readonly RpcMethod[];

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcSuccess {
  jsonrpc: '2.0';
  id: number;
  result: unknown;
}

export interface RpcFailure {
  jsonrpc: '2.0';
  id: number;
  error: { code: ErrorCode; message: string; data?: unknown };
}

export type RpcResponse = RpcSuccess | RpcFailure;

/** Plugin → core messages that need no reply. */
export type RpcNotification =
  | { jsonrpc: '2.0'; method: 'log'; params: { level: 'debug' | 'info' | 'warn' | 'error'; message: string } }
  | { jsonrpc: '2.0'; method: 'catalogChanged'; params?: { reason?: string } };

export function isRpcRequest(msg: unknown): msg is RpcRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as RpcRequest).jsonrpc === '2.0' &&
    typeof (msg as RpcRequest).id === 'number' &&
    typeof (msg as RpcRequest).method === 'string'
  );
}
