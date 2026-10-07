import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseManifest } from '@synoikia/plugin-sdk';
import type { Manifest } from '@synoikia/plugin-sdk';
import { and, eq } from 'drizzle-orm';
import { createAppContext } from '../app.js';
import type { AppContext, AppOptions } from '../app.js';
import { setGroupLevel, updateOperation } from '../catalog/groups.js';
import { createRule } from '../catalog/rules.js';
import { loadConfig } from '../config/env.js';
import { secretFieldNames } from '../instances/connection.js';
import { auditLog, operations, pendingApprovals, plugins, registryEntries } from '../db/schema.js';
import type { AccessLevel } from '../gate/access.js';
import type { CallerContext } from '../gate/pipeline.js';
import { executeCode, resumeExecution, searchCode } from '../runtime/index.js';
import type { ExecuteResult, PendingResult } from '../runtime/executions.js';
import type { SandboxResult } from '../sandbox/index.js';

/** Harness for plugin packages (`@synoikia/core/testing`): boots the real core on a built bundle, run
 * as in production, and drives it the way an MCP client does. */

export interface PluginHarnessOptions {
  /** The plugin package directory (the one holding `manifest.json`); its entry must be built. */
  pluginDir: string;
  /** Connection config and secrets, as the admin portal would submit them. */
  connection: Record<string, unknown>;
  /** Endpoint slug; defaults to the plugin id. */
  slug?: string;
  /** Run a catalog/registry sync before returning (default true). */
  sync?: boolean;
  supervisor?: AppOptions['supervisor'];
}

/** An approval as the harness hands it to `onApproval`: decide it like the approval page would. */
export interface HarnessApproval {
  id: string;
  operationKey: string;
  /** The prompt the MCP client was shown. */
  message: string;
  /** The stored approval (operation, params, targets, diff, confirmation literal). */
  pending: typeof pendingApprovals.$inferSelect;
  /** Throws, as the approval page refuses it, when `confirm` doesn't match a typed confirmation. */
  approve(confirm?: string): void;
  deny(): void;
}

export interface ExecuteOptions {
  /** Decides each approval; without it, or if it throws or leaves one open, the approval is denied. */
  onApproval?: (approval: HarnessApproval) => void | Promise<void>;
  /** Without `onApproval`, act as a client with no prompts: the call parks (design §5.6). Decide it with
   * `parkedApproval(result)`, then collect it with `resume`. */
  park?: boolean;
}

export interface PluginHarness {
  ctx: AppContext;
  instanceId: string;
  manifest: Manifest;
  /** Errors thrown by `onApproval` handlers, oldest first. */
  approvalErrors: unknown[];
  /** A parked call (`opts.park`) answers with a `PendingResult`; it is also an `ok: false` SandboxResult. */
  execute(code: string, opts?: ExecuteOptions): Promise<ExecuteResult>;
  /** Follows a parked execution, as the `resume` tool does. */
  resume(executionId: string): Promise<ExecuteResult>;
  /** The approval a parked result waits on, to decide it as the approval page would. */
  parkedApproval(result: ExecuteResult): HarnessApproval;
  search(code: string): Promise<SandboxResult>;
  setGroupLevel(group: string, level: AccessLevel): void;
  /** The operation's own level; `null` makes it follow its group again. */
  setOperationLevel(key: string, level: AccessLevel | null): void;
  addRule(rule: { operation: string; match: unknown[]; reason: string }): { id: string };
  operation(key: string): typeof operations.$inferSelect;
  operations(): (typeof operations.$inferSelect)[];
  registry(): (typeof registryEntries.$inferSelect)[];
  audit(filter?: { operationKey?: string }): (typeof auditLog.$inferSelect)[];
  instance(): ReturnType<AppContext['instances']['get']>;
  /** Runs the plugin's `testConnection` in a throwaway child with this connection. */
  testConnection(connection: Record<string, unknown>): Promise<unknown>;
  syncNow(): ReturnType<AppContext['instances']['syncNow']>;
  stop(): Promise<void>;
}

/** Copies what a release ships (manifest, package.json, the entry's top-level path) into `root/<id>`. */
function stagePlugin(pluginDir: string, manifest: Manifest, root: string): string {
  const entry = path.join(pluginDir, manifest.entry);
  if (!existsSync(entry)) {
    throw new Error(`${manifest.id}: entry ${manifest.entry} not found in ${pluginDir}. Build the plugin first.`);
  }
  const dest = path.join(root, manifest.id);
  mkdirSync(dest, { recursive: true });
  const top = path.normalize(manifest.entry).split(path.sep)[0]!;
  for (const name of new Set(['manifest.json', 'package.json', top])) {
    const from = path.join(pluginDir, name);
    if (existsSync(from)) cpSync(from, path.join(dest, name), { recursive: true });
  }
  return dest;
}

export async function startPluginHarness(opts: PluginHarnessOptions): Promise<PluginHarness> {
  const manifest = parseManifest(JSON.parse(readFileSync(path.join(opts.pluginDir, 'manifest.json'), 'utf8')));
  const work = mkdtempSync(path.join(tmpdir(), `synoikia-harness-${manifest.id}-`));
  let ctx: AppContext | undefined;
  try {
    // Staged where an install puts it, then enabled as an admin would.
    const dataDir = path.join(work, 'data');
    stagePlugin(opts.pluginDir, manifest, path.join(dataDir, 'plugins'));
    ctx = await createAppContext(loadConfig({ DATA_DIR: dataDir }), {
      memoryDb: true,
      supervisor: opts.supervisor ?? { initTimeoutMs: 5000, rpcTimeoutMs: 10_000 },
    });
    const row = ctx.db.select().from(plugins).where(eq(plugins.pluginId, manifest.id)).get();
    if (row?.status !== 'ok') {
      throw new Error(`${manifest.id} was not loaded: ${row ? `${row.status}: ${row.statusError}` : 'not discovered'}`);
    }
    await ctx.instances.setPluginEnabled(row.id, true);
    const instanceId = (
      await ctx.instances.create({ pluginId: manifest.id, slug: opts.slug ?? manifest.id, connection: opts.connection })
    ).id;
    if (opts.sync ?? true) await ctx.instances.syncNow(instanceId);
    return harness(ctx, manifest, instanceId, work);
  } catch (err) {
    await ctx?.stop();
    rmSync(work, { recursive: true, force: true });
    throw err;
  }
}

function harness(ctx: AppContext, manifest: Manifest, instanceId: string, work: string): PluginHarness {
  const approvalErrors: unknown[] = [];
  const operation = (key: string) => {
    const op = ctx.db
      .select()
      .from(operations)
      .where(and(eq(operations.instanceId, instanceId), eq(operations.key, key)))
      .get();
    if (!op) throw new Error(`No operation ${key} in the synced catalog`);
    return op;
  };

  const caller = (opts: ExecuteOptions = {}): CallerContext => {
    const onApproval = opts.onApproval;
    return {
      client: { kind: 'mcp_client', id: 'harness' },
      principal: { ceiling: 'write' },
      mcpSessionId: 'harness-session',
      parkable: !onApproval && !!opts.park,
      prompts: onApproval
        ? {
            url: async (req) => {
              // Decide after the prompt returns, as a human on the approval page would.
              setTimeout(() => void decide(req.approvalId, req.message, onApproval), 10);
              return { action: 'accept' };
            },
          }
        : undefined,
    };
  };

  const approvalOf = (id: string, message: string, onDecided: () => void = () => {}): HarnessApproval => {
    const pending = ctx.db.select().from(pendingApprovals).where(eq(pendingApprovals.id, id)).get()!;
    const operationKey = ctx.db.select().from(operations).where(eq(operations.id, pending.operationId)).get()!.key;
    return {
      id,
      operationKey,
      message,
      pending,
      approve(confirm) {
        ctx.approvals.decide(id, { approve: true, confirm, decidedBy: 'harness' });
        onDecided();
      },
      deny() {
        ctx.approvals.decide(id, { approve: false, decidedBy: 'harness' });
        onDecided();
      },
    };
  };

  const decide = async (id: string, message: string, onApproval: NonNullable<ExecuteOptions['onApproval']>) => {
    let decided = false;
    const approval = approvalOf(id, message, () => (decided = true));
    const operationKey = approval.operationKey;
    try {
      await onApproval(approval);
      if (!decided) throw new Error(`onApproval left approval ${id} (${operationKey}) open`);
    } catch (err) {
      approvalErrors.push(err);
      if (!decided) ctx.approvals.decide(id, { approve: false, decidedBy: 'harness' });
    }
  };

  return {
    ctx,
    instanceId,
    manifest,
    approvalErrors,
    execute: (code, opts) => executeCode(ctx.gateDeps(), ctx.instances.runtime(instanceId), caller(opts), code),
    resume: (executionId) =>
      resumeExecution(ctx.gateDeps(), ctx.instances.runtime(instanceId), caller({ park: true }), executionId),
    parkedApproval(result) {
      const parked = (result as Partial<PendingResult>).approval;
      if (!parked) throw new Error('This result is not waiting for an approval');
      const link = ctx.links.resolve(parked.path.slice('/a/'.length));
      if (!link) throw new Error('The approval is no longer open');
      return approvalOf(link.approvalId, parked.summary);
    },
    search: (code) => searchCode(ctx.gateDeps(), ctx.instances.runtime(instanceId), caller(), code),
    setGroupLevel(group, level) {
      setGroupLevel(ctx.db, instanceId, group, level);
    },
    setOperationLevel(key, level) {
      updateOperation(ctx.db, instanceId, operation(key).id, { level });
    },
    addRule({ operation: key, match, reason }) {
      return createRule(ctx.db, ctx.instances.runtime(instanceId).manifest, instanceId, {
        operationId: operation(key).id,
        match,
        reason,
      });
    },
    operation,
    operations: () => ctx.db.select().from(operations).where(eq(operations.instanceId, instanceId)).all(),
    registry: () => ctx.db.select().from(registryEntries).where(eq(registryEntries.instanceId, instanceId)).all(),
    audit(filter = {}) {
      const rows = ctx.db.select().from(auditLog).where(eq(auditLog.instanceId, instanceId)).all();
      return filter.operationKey ? rows.filter((a) => a.operationKey === filter.operationKey) : rows;
    },
    instance: () => ctx.instances.get(instanceId),
    testConnection: (connection) => ctx.instances.testConnection(instanceId, splitConnection(manifest, connection)),
    syncNow: () => ctx.instances.syncNow(instanceId),
    async stop() {
      await ctx.stop();
      rmSync(work, { recursive: true, force: true });
    },
  };
}

/** `testConnection` takes config and secrets apart; the manifest's `writeOnly` fields are the secrets. */
function splitConnection(manifest: Manifest, connection: Record<string, unknown>) {
  const secretNames = new Set(secretFieldNames(manifest));
  const config: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(connection)) {
    if (secretNames.has(k)) secrets[k] = String(v);
    else config[k] = v;
  }
  return { config, secrets };
}

export type { ExecuteResult, PendingResult } from '../runtime/executions.js';
export { verifyPluginRepository } from './repository.js';
export type { VerifiedPlugin, VerifyRepositoryOptions } from './repository.js';
export { startFakeHttp } from './fake-http.js';
export type { FakeHttp, FakeHttpOptions, FakeRequest, FakeResponse, FakeRoute } from './fake-http.js';
export { checkPluginContract } from './contract.js';
export type { ContractCall, PluginContractOptions } from './contract.js';
