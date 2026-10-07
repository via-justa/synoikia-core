import type { ParkedApproval } from '../approvals/service.js';
import type { SandboxResult } from '../sandbox/index.js';

/** Parked executions (design §5.6): an `execute` whose approval waits on a human outlives its tool call.
 * Only its owner (credential and endpoint) can follow it with `resume`; it keeps running at the decision. */

export const PARKED_LIMIT = { perPrincipalInstance: 2, perInstance: 8, total: 32 };
/** How long `resume` waits for a change before it answers "still waiting". */
export const RESUME_WAIT_MS = 45_000;
/** How long a finished result waits for `resume` to collect it. */
export const RESULT_TTL_MS = 10 * 60_000;

/** `execute` and `resume` answer this while a parked execution has no result yet. */
export interface PendingResult {
  ok: false;
  status: 'awaiting_approval' | 'running';
  executionId: string;
  approval?: ParkedApproval;
  error: { code: 'AWAITING_APPROVAL' | 'STILL_RUNNING'; message: string };
  logs: string[];
}

export type ExecuteResult = SandboxResult | PendingResult;

export interface ExecutionStatus {
  state: 'pending' | 'approved' | 'denied' | 'timed_out' | 'cancelled' | 'running' | 'done';
  expiresAt?: string;
  /** The last human decision on this run's approvals. */
  decision?: string;
  decidedBy?: string;
}

interface Entry {
  id: string;
  owner: string;
  instanceId: string;
  /** The approval the run waits on now, if any. */
  approval?: ParkedApproval;
  lastDecision?: { outcome: string; decidedBy?: string };
  result?: SandboxResult;
  finishedAt?: number;
  attached: boolean;
  abort: () => void;
  waiters: Set<() => void>;
}

export class ExecutionRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Unfinished parked runs (shutdown waits for them like for any running script). */
  get running(): number {
    return [...this.entries.values()].filter((e) => !e.result).length;
  }

  hasRoom(owner: string, instanceId: string): boolean {
    this.sweep();
    const live = [...this.entries.values()].filter((e) => !e.result);
    const here = live.filter((e) => e.instanceId === instanceId);
    return (
      live.length < PARKED_LIMIT.total &&
      here.length < PARKED_LIMIT.perInstance &&
      here.filter((e) => e.owner === owner).length < PARKED_LIMIT.perPrincipalInstance
    );
  }

  adopt(input: { id: string; owner: string; instanceId: string; approval: ParkedApproval; abort: () => void }) {
    this.entries.set(input.id, { ...input, attached: false, waiters: new Set() });
  }

  /** The parked run reached another approval. */
  awaiting(id: string, approval: ParkedApproval) {
    const e = this.entries.get(id);
    if (!e) return;
    e.approval = approval;
    this.changed(e);
  }

  settled(id: string, approvalId: string, decision: { outcome: string; decidedBy?: string }) {
    const e = this.entries.get(id);
    if (!e || e.approval?.approvalId !== approvalId) return;
    e.approval = undefined;
    e.lastDecision = decision;
    this.changed(e);
  }

  finish(id: string, result: SandboxResult) {
    const e = this.entries.get(id);
    if (!e) return;
    e.result = result;
    e.approval = undefined;
    e.finishedAt = this.now();
    this.changed(e);
  }

  /** The owner's entry, or undefined (unknown, expired, or someone else's: all look the same). */
  private find(id: string, owner: string, instanceId: string): Entry | undefined {
    this.sweep();
    const e = this.entries.get(id);
    return e && e.owner === owner && e.instanceId === instanceId ? e : undefined;
  }

  status(id: string, owner: string, instanceId: string): ExecutionStatus | undefined {
    const e = this.find(id, owner, instanceId);
    if (!e) return undefined;
    if (e.result) return { state: 'done', decision: e.lastDecision?.outcome, decidedBy: e.lastDecision?.decidedBy };
    if (e.approval) return { state: 'pending', expiresAt: e.approval.expiresAt.toISOString() };
    if (e.lastDecision && e.lastDecision.outcome !== 'approved')
      return { state: e.lastDecision.outcome as ExecutionStatus['state'], decidedBy: e.lastDecision.decidedBy };
    return { state: e.lastDecision ? 'approved' : 'running', decidedBy: e.lastDecision?.decidedBy };
  }

  /** Waits for the result or a new approval, up to `waitMs`. A collected result removes the entry. */
  async wait(
    id: string,
    owner: string,
    instanceId: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<ExecuteResult | 'not_found' | 'busy'> {
    const e = this.find(id, owner, instanceId);
    if (!e) return 'not_found';
    if (e.attached) return 'busy';
    e.attached = true;
    try {
      const startedOn = e.approval?.approvalId;
      const settledNow = () => !!e.result || (!!e.approval && e.approval.approvalId !== startedOn);
      if (!settledNow()) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            e.waiters.delete(wake);
            signal?.removeEventListener('abort', done);
            resolve();
          };
          const wake = () => {
            if (settledNow()) done();
          };
          const timer = setTimeout(done, waitMs);
          e.waiters.add(wake);
          signal?.addEventListener('abort', done);
        });
      }
      if (e.result) {
        this.entries.delete(id);
        return e.result;
      }
      return pending(e);
    } finally {
      e.attached = false;
    }
  }

  /** Ends the parked runs of one endpoint, or all of them. Their approvals are cancelled by the gate. */
  abort(instanceId?: string) {
    for (const e of this.entries.values()) if (!e.result && (!instanceId || e.instanceId === instanceId)) e.abort();
  }

  private changed(e: Entry) {
    for (const w of [...e.waiters]) w();
  }

  private sweep() {
    const cutoff = this.now() - RESULT_TTL_MS;
    for (const [id, e] of this.entries)
      if (e.finishedAt !== undefined && e.finishedAt < cutoff) this.entries.delete(id);
  }
}

export function pendingResult(executionId: string, approval?: ParkedApproval): PendingResult {
  return approval
    ? {
        ok: false,
        status: 'awaiting_approval',
        executionId,
        approval,
        error: {
          code: 'AWAITING_APPROVAL',
          message: `${approval.operationKey} waits for a human to approve it on the approval page. Show the link to the user; after they decide, call resume with this executionId.`,
        },
        logs: [],
      }
    : {
        ok: false,
        status: 'running',
        executionId,
        error: { code: 'STILL_RUNNING', message: 'The execution is still running; call resume again.' },
        logs: [],
      };
}

const pending = (e: Entry) => pendingResult(e.id, e.approval);
