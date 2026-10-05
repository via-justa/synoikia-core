import { randomUUID } from 'node:crypto';
import type { Manifest, ResolvedTarget } from '@synoikia/plugin-sdk';
import { and, eq } from 'drizzle-orm';
import type { ApprovalService, ClientPrompts, Decision } from '../approvals/service.js';
import { writeAudit } from '../audit.js';
import type { AuditEvent } from '../audit.js';
import { resolveAccess } from '../catalog/groups.js';
import type { Db } from '../db/index.js';
import type { AccessPrincipal } from './access.js';
import { operations } from '../db/schema.js';
import type { InstanceSettings } from '../instances/settings.js';
import { PluginProtocolError, PluginRpcError, PluginTimeoutError, PluginUnavailableError } from '../plugins/process.js';
import type { PluginProcess } from '../plugins/process.js';
import { BindingError } from '../sandbox/index.js';
import type { Binding, BudgetControl } from '../sandbox/index.js';
import { verifyAttestationKey } from './attestation.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import { evaluatePreApproval } from './preapproval.js';
import type { SlidingWindowLimiter } from './rate-limit.js';
import { redactDiff, redactPaths, redactResult } from './redact.js';
import type { Redactor } from './redact.js';

/** The permission gate (design §5.2), the only path from sandboxed code to `invoke`: resolve → attest →
 * access → targets → prepareWrite → [rule | human] → invoke → redact → audit (every branch audited). */

export interface GateDeps {
  db: Db;
  approvals: ApprovalService;
  limiter: SlidingWindowLimiter;
  attestationKey: Buffer;
  now?: () => Date;
}

export interface InstanceRuntime {
  instanceId: string;
  slug: string;
  manifest: Manifest;
  settings: InstanceSettings;
  redact: Redactor;
  /** The live plugin process; throws PluginUnavailableError while it is down. */
  plugin: () => PluginProcess;
  /** The catalog's plugin version while it matches the running child's, else undefined; checked when a
   * call is gated and again before `invoke`, since descriptors belong to one bundle. */
  catalogVersion: () => string | undefined;
}

export interface CallerContext {
  /** `id` is the audit label (`token:Claude`); `key` the stable principal per-principal limits use. */
  client: { kind: 'mcp_client'; id?: string; key?: string };
  mcpSessionId?: string;
  /** The authenticated principal's access ceiling (consent page / bearer token). */
  principal: AccessPrincipal;
  /** Present only for a live session whose client advertised elicitation. */
  prompts?: ClientPrompts;
}

type OperationRow = typeof operations.$inferSelect;

/** What per-principal limits are keyed on: the stable principal, never the display name. */
export const principalKey = (caller: CallerContext) => caller.client.key ?? caller.client.id ?? 'anonymous';

const MAX_ERROR_MESSAGE = 500;
const PASSTHROUGH_PLUGIN_CODES = new Set([
  'UNKNOWN_OPERATION',
  'INVALID_PARAMS',
  'TARGET_RESOLUTION_FAILED',
  'CONFIG_CONFLICT',
  'UPSTREAM_DENIED',
  'UPSTREAM_ERROR',
]);

function toBindingError(err: unknown): BindingError {
  if (err instanceof BindingError) return err;
  if (err instanceof PluginRpcError) {
    const code = PASSTHROUGH_PLUGIN_CODES.has(err.code) ? err.code : 'PLUGIN_ERROR';
    return new BindingError(code, err.message.slice(0, MAX_ERROR_MESSAGE));
  }
  if (err instanceof PluginUnavailableError)
    return new BindingError('PLUGIN_UNAVAILABLE', 'The plugin is not running; try again shortly');
  if (err instanceof PluginTimeoutError) return new BindingError('UPSTREAM_TIMEOUT', err.message);
  if (err instanceof PluginProtocolError)
    return new BindingError('PLUGIN_ERROR', 'The plugin returned an invalid response');
  return new BindingError('INTERNAL', 'Internal error');
}

const DISABLED_MESSAGES: Record<string, string> = {
  group_missing: 'is not available on this endpoint',
  level_none: 'is disabled on this endpoint (access level None)',
  token_read_only: 'is a write, and this connection was granted read-only access',
  locked_not_opted_in: 'is a protected operation that the administrator has not enabled',
  unknown_operation: 'is not in the current catalog',
};

/** Order-independent identity of a resolved target set. */
const targetKey = (targets: ResolvedTarget[]) => JSON.stringify(targets.map((t) => `${t.kind}:${t.id}`).sort());

const DENIAL_MESSAGES: Record<string, string> = {
  no_approval_path: 'needs approval, and this MCP client cannot show approval prompts',
  client_cannot_approve:
    'needs approval on a web page, and this MCP client only supports form prompts; use a client that supports URL elicitation',
  declined: 'was declined in the client',
  prompt_failed: 'needs approval, but the client could not show the approval prompt',
  confirmation_mismatch: 'was denied (confirmation mismatch)',
  endpoint_stopped: 'was cancelled: the endpoint was stopped or reconfigured while it waited for approval',
};

/** The gate bindings for one `execute` run; once `signal` aborts, leftover calls are refused and open
 * approvals cancelled, so nothing runs after the tool call returned. */
export function createGateBindings(
  deps: GateDeps,
  rt: InstanceRuntime,
  caller: CallerContext,
  signal: AbortSignal = new AbortController().signal,
): Record<string, Record<string, Binding>> {
  const now = deps.now ?? (() => new Date());
  const executionId = randomUUID();
  let queue: Promise<unknown> = Promise.resolve();
  const openApprovals = new Set<string>();
  signal.addEventListener('abort', () => {
    for (const id of openApprovals) deps.approvals.cancel(id, 'execution_ended');
  });

  const serialized =
    (fn: string): Binding =>
    (args, budget) => {
      const run = queue.then(() => gatedCall(fn, args, budget));
      queue = run.catch(() => undefined);
      return run;
    };

  async function gatedCall(fn: string, args: unknown[], budget: BudgetControl): Promise<unknown> {
    const started = Date.now();
    const audit: AuditEvent & { detail: Record<string, unknown> } = {
      kind: 'call',
      instanceId: rt.instanceId,
      actorKind: 'mcp_client',
      actorId: caller.client.id,
      detail: { executionId, fn },
    };
    let audited = false;
    const finish = (decision: string, extra: { resultStatus?: string; detail?: Record<string, unknown> } = {}) => {
      audited = true;
      writeAudit(
        deps.db,
        {
          ...audit,
          decision,
          resultStatus: extra.resultStatus ?? null,
          durationMs: Date.now() - started,
          detail: { ...audit.detail, ...extra.detail },
        },
        now(),
      );
    };
    const reject = (decision: string, err: BindingError): never => {
      finish(decision, { resultStatus: 'rejected', detail: { error: err.code } });
      throw err;
    };

    const ensureRunning = () => {
      if (signal.aborted)
        reject(
          'rejected:execution_ended',
          new BindingError('EXECUTION_ENDED', 'The execute call this belongs to has already ended'),
        );
    };

    try {
      ensureRunning();

      // 0. Map the raw binding call onto a catalog key (path templates, split keys…).
      const resolved = await rt.plugin().call('resolveOperation', { fn, args });
      audit.operationKey = resolved.key;
      const catalogAt = rt.catalogVersion();
      const op = deps.db
        .select()
        .from(operations)
        .where(and(eq(operations.instanceId, rt.instanceId), eq(operations.key, resolved.key)))
        .get() as OperationRow | undefined;
      // Redacted by key name, plus the paths the plugin declared for this operation (positional secrets).
      const redactParams = <T>(p: T): T => redactPaths(rt.redact(p), op?.sensitiveParams);
      audit.params = redactParams(resolved.params);

      // 1. Attestation, before anything else about the op is revealed.
      if (op && !op.stale && op.attestationRequired) {
        const presented = (resolved.params as { best_practice_key?: unknown } | null)?.best_practice_key;
        if (
          !verifyAttestationKey(deps.db, deps.attestationKey, {
            instanceId: rt.instanceId,
            operationId: op.id,
            opKey: op.key,
            mcpSessionId: caller.mcpSessionId,
            presented,
          })
        ) {
          reject(
            'rejected:attestation_required',
            new BindingError(
              'ATTESTATION_REQUIRED',
              `Call search() for the ${op.key} guide first and pass its best_practice_key`,
            ),
          );
        }
      }

      // 2. Access level (operation's own, else its group's) under the principal's ceiling. Unknown or
      //    stale ops fail here too.
      const access = resolveAccess(deps.db, rt.instanceId, resolved.key, caller.principal);
      if (!access.reachable || !op) {
        const reason = access.reachable ? 'unknown_operation' : access.reason;
        reject(
          `rejected:${reason}`,
          Object.assign(
            new BindingError(
              'OPERATION_DISABLED',
              `${resolved.key} ${DISABLED_MESSAGES[reason] ?? 'is not available'}`,
            ),
            { reason },
          ),
        );
      }
      const operation = op!;
      const mode = access.reachable ? access.mode : 'run';
      // A read at its own Ask needs a decision too, but only writes use the write budget or prepareWrite.
      const needsDecision = mode !== 'run';
      const isWrite = operation.locked || operation.classification === 'write';
      audit.classification = operation.locked ? 'locked' : operation.classification;

      // 3. Concrete targets, so rules and approvers see exactly what will be touched. Fails closed.
      let targets: ResolvedTarget[] = [];
      if (rt.manifest.capabilities.targets) {
        targets = await rt.plugin().call('resolveTargets', { key: operation.key, params: resolved.params });
        audit.resolvedTargets = targets;
      }

      // 4. Config transforms: compute the real diff against the live object.
      let params = resolved.params;
      let diff: unknown;
      let expectedHash: string | undefined;
      if (isWrite && rt.manifest.capabilities.configTransform && operation.kind === 'config') {
        const prepared = await rt.plugin().call('prepareWrite', { key: operation.key, params });
        params = prepared.params;
        diff = prepared.diff;
        expectedHash = prepared.expectedHash;
      }

      // 5. Reads run straight away, unless the read has its own Ask.
      let decision = 'auto-executed';
      let approval: Decision | undefined;
      // Each principal has its own write budget, charged only for writes that actually run (step 9):
      // a noisy, denied or timed-out client doesn't use up anyone else's.
      const writeBucket = `write:${rt.instanceId}:${principalKey(caller)}`;
      const overWriteBudget = () =>
        reject('rejected:rate_limited', new BindingError('RATE_LIMITED', 'Too many write calls; slow down'));
      if (needsDecision) {
        // Checked before asking anyone, so nobody approves a call that would be refused anyway.
        if (isWrite && !deps.limiter.allows(writeBucket, rt.settings.writesPerMinute, 60_000)) overWriteBudget();

        // 6. Level `write`: acknowledged writes are auto-approved. Level `ask` (a write, or a read given
        //    its own Ask): pre-approval rules, which never cover locked ops nor unacknowledged writes.
        let preapproved = false;
        if (mode === 'auto') {
          preapproved = true;
          decision = 'auto-approved:level';
        } else if (!operation.locked && access.reachable && access.level === 'ask') {
          const targetCovers = operation.matchProfile
            ? rt.manifest.matchProfiles[operation.matchProfile]?.find((f) => f.field === '$targets')?.covers
            : undefined;
          const outcome = evaluatePreApproval(
            deps.db,
            { instanceId: rt.instanceId, operationId: operation.id, params, targets, targetCovers },
            now(),
          );
          if (outcome.kind === 'auto_approved') {
            preapproved = true;
            decision = `auto-approved:rule:${outcome.ruleId}`;
          } else if (outcome.kind === 'rate_limited') {
            audit.detail.rateLimitedRules = outcome.ruleIds;
          }
        }

        // 7. Human approval, scoped to exactly these params and targets.
        if (!preapproved) {
          // The plugin only sees redacted params here: summaries and confirmation literals end up in
          // prompts, the DB and notifications, and never need a secret.
          const summary = await rt
            .plugin()
            .call('summarize', { key: operation.key, params: redactParams(params), targets });
          if (operation.typedConfirmation && !summary.confirmLiteral) {
            reject(
              'rejected:missing_confirmation_literal',
              new BindingError('PLUGIN_ERROR', `The plugin did not provide a confirmation value for ${operation.key}`),
            );
          }
          ensureRunning();
          const paramsHash = sha256Hex(
            canonicalJson({ key: operation.key, params, targets, expectedHash: expectedHash ?? null }),
          );
          const request = deps.approvals.request({
            instanceId: rt.instanceId,
            operationId: operation.id,
            operationKey: operation.key,
            classification: audit.classification,
            paramsDisplay: redactParams(params),
            paramsHash,
            resolvedTargets: targets,
            summary: summary.text,
            confirmLiteral: operation.typedConfirmation ? summary.confirmLiteral : undefined,
            // The diff names changed fields in its paths, which key-based redaction can't see.
            diff: redactDiff(diff as Parameters<typeof redactDiff>[0], rt.redact, operation.sensitiveParams),
            expectedHash,
            client: caller.client,
            mcpSessionId: caller.mcpSessionId,
            timeoutMs: rt.settings.approvalTimeoutMs,
            prompts: caller.prompts,
            // Only plain writes, as the setting's name says: a read the admin put at Ask always needs a human.
            formApprovals:
              rt.settings.formElicitationApprovals === 'writes' &&
              isWrite &&
              !operation.locked &&
              !operation.typedConfirmation,
          });
          audit.detail.approvalId = request.id;
          openApprovals.add(request.id);
          budget.pause();
          try {
            approval = await request.decision;
          } finally {
            openApprovals.delete(request.id);
            budget.resume();
          }
          audit.decidedBy = approval.decidedBy;
          audit.decidedVia = approval.via;
          if (approval.outcome === 'cancelled' && signal.aborted) ensureRunning();
          if (approval.outcome !== 'approved') {
            const label = approval.outcome === 'timed_out' ? 'timed-out' : 'denied';
            reject(
              label,
              new BindingError(
                'PERMISSION_DENIED',
                approval.outcome === 'timed_out'
                  ? `Approval for ${operation.key} timed out and was denied`
                  : `${operation.key} ${(approval.reason && DENIAL_MESSAGES[approval.reason]) ?? `was denied${approval.reason ? ` (${approval.reason})` : ''}`}`,
              ),
            );
          }
          // The admin may have lowered the level while the approval was open: the call must still be allowed.
          const after = resolveAccess(deps.db, rt.instanceId, operation.key, caller.principal);
          if (!after.reachable || after.mode === 'run') {
            reject(
              'rejected:access_changed',
              new BindingError('OPERATION_DISABLED', `${operation.key} was disabled while waiting for approval`),
            );
          }
          decision = 'human-approved';
        }
      }

      // 8. The approver saw these targets; after a wait they may have moved (an entity joined the area).
      //    Resolve again and refuse unless the set is unchanged, then hand the plugin the approved set.
      ensureRunning();
      if (decision === 'human-approved' && rt.manifest.capabilities.targets) {
        const now = await rt.plugin().call('resolveTargets', { key: operation.key, params });
        if (targetKey(now) !== targetKey(targets)) {
          audit.detail.targetsNow = now;
          reject(
            'rejected:targets_changed',
            new BindingError(
              'TARGETS_CHANGED',
              `What ${operation.key} would act on changed while it waited for approval; call it again to get a fresh approval`,
            ),
          );
        }
      }

      // The catalog that gated and masks this call must still describe the running code (an update or
      // restart during an approval wait would otherwise run it under another bundle's rules).
      const catalogNow = rt.catalogVersion();
      if (catalogAt === undefined || catalogNow !== catalogAt) {
        throw new BindingError(
          'PLUGIN_UNAVAILABLE',
          'The plugin changed while this call was pending (an update or restart); call it again',
        );
      }

      // 9. The real upstream call, within what's left of the sandbox budget.
      if (isWrite && !deps.limiter.take(writeBucket, rt.settings.writesPerMinute, 60_000)) overWriteBudget();
      const remaining = Math.max(1, budget.remainingMs());
      const result = await rt.plugin().call(
        'invoke',
        {
          key: operation.key,
          params,
          context: {
            callId: randomUUID(),
            expectedHash,
            deadlineMs: remaining,
            ...(rt.manifest.capabilities.targets ? { targets } : {}),
          },
        },
        remaining,
      );

      // 10–11. Redact (the operation's declared result secrets first, then by key name and secret
      // value), audit, hand back. Nothing past this point sees the plugin's raw result.
      finish(decision, { resultStatus: 'ok' });
      return rt.redact(redactResult(result, operation.sensitiveResult));
    } catch (err) {
      const raw = toBindingError(err);
      // Plugin and upstream messages are free text: scrub the instance's secret values out of them.
      const mapped = new BindingError(raw.code, rt.redact(raw.message));
      Object.assign(mapped, { reason: (raw as { reason?: string }).reason });
      // Gate rejections were audited where they were raised; plugin/upstream failures are audited here.
      if (!audited) {
        const decision = audit.classification ? `error:${mapped.code}` : `rejected:${mapped.code.toLowerCase()}`;
        finish(decision, { resultStatus: 'error', detail: { error: mapped.code } });
      }
      throw mapped;
    }
  }

  return {
    [rt.manifest.binding.namespace]: Object.fromEntries(
      rt.manifest.binding.functions.map((fn) => [fn, serialized(fn)]),
    ),
  };
}
