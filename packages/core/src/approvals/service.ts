import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import type { Db } from '../db/index.js';
import { pendingApprovals } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import type { ApprovalLinkService } from './links.js';

/** Human approval (design §5.3): URL mode sends a human to our page to decide; form mode only for opted-in
 * plain writes; anything else, and any timeout, is denied. A client's answer never approves a risky call. */

export type DecisionOutcome = 'approved' | 'denied' | 'timed_out' | 'cancelled';
export type DecisionChannel = 'elicitation' | 'url';

export interface Decision {
  outcome: DecisionOutcome;
  via?: DecisionChannel;
  decidedBy?: string;
  reason?: string;
}

export interface UrlPromptRequest {
  approvalId: string;
  /** Path of the approval page on the MCP listener; the MCP layer makes it absolute. */
  path: string;
  message: string;
}

export interface UrlPromptResponse {
  action: 'accept' | 'decline' | 'cancel';
}

export interface FormPromptRequest {
  approvalId: string;
  message: string;
  requestedSchema: {
    type: 'object';
    properties: Record<string, { type: 'boolean'; title: string; description?: string }>;
    required: string[];
  };
}

export interface FormPromptResponse {
  action: 'accept' | 'decline' | 'cancel';
  content?: { approve?: unknown };
}

/** What the connected MCP client can show; present only for a live session that advertised it. */
export interface ClientPrompts {
  url?: (req: UrlPromptRequest) => Promise<UrlPromptResponse>;
  /** Tells the client a URL prompt was decided, so it can close it. */
  urlComplete?: (approvalId: string) => void;
  form?: (req: FormPromptRequest) => Promise<FormPromptResponse>;
}

export interface ApprovalRequestInput {
  instanceId: string;
  operationId: string;
  operationKey: string;
  classification: string;
  paramsDisplay: unknown;
  paramsHash: string;
  resolvedTargets: unknown;
  summary: string;
  confirmLiteral?: string;
  diff?: unknown;
  expectedHash?: string;
  client: { kind: string; id?: string };
  mcpSessionId?: string;
  timeoutMs: number;
  prompts?: ClientPrompts;
  /** The endpoint lets form prompts approve, and this is a plain write (not locked, no typed confirmation). */
  formApprovals: boolean;
}

interface Live {
  row: typeof pendingApprovals.$inferSelect;
  settle: (d: Decision) => void;
}

export class ApprovalService {
  private readonly live = new Map<string, Live>();

  constructor(
    private readonly db: Db,
    private readonly links: ApprovalLinkService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** At startup, deny and audit pending rows from a previous process: their params lived only in memory (§5.5). */
  static denyOrphans(db: Db, now = new Date()): number {
    return db.transaction((tx) => {
      const orphans = tx.select().from(pendingApprovals).where(eq(pendingApprovals.status, 'pending')).all();
      for (const o of orphans) {
        tx.update(pendingApprovals)
          .set({ status: 'denied', decidedAt: now })
          .where(eq(pendingApprovals.id, o.id))
          .run();
        writeAudit(
          tx,
          {
            kind: 'call',
            instanceId: o.instanceId,
            decision: 'denied',
            actorKind: 'system',
            detail: { approvalId: o.id, reason: 'server_restart' },
          },
          now,
        );
      }
      return orphans.length;
    });
  }

  request(input: ApprovalRequestInput): { id: string; decision: Promise<Decision> } {
    const now = this.now();
    const id = randomUUID();
    const row = {
      id,
      instanceId: input.instanceId,
      operationId: input.operationId,
      paramsDisplay: input.paramsDisplay ?? null,
      paramsHash: input.paramsHash,
      resolvedTargets: input.resolvedTargets ?? null,
      summary: input.summary,
      confirmLiteral: input.confirmLiteral ?? null,
      diff: input.diff ?? null,
      expectedHash: input.expectedHash ?? null,
      clientKind: input.client.kind,
      clientId: input.client.id ?? null,
      mcpSessionId: input.mcpSessionId ?? null,
      requestedAt: now,
      expiresAt: new Date(now.getTime() + input.timeoutMs),
      status: 'pending' as const,
      decidedBy: null,
      decidedVia: null,
      decidedAt: null,
    };

    const prompts = input.prompts ?? {};
    const channel = prompts.url ? 'url' : prompts.form && input.formApprovals ? 'form' : null;
    if (!channel) {
      // A form-only client can't carry a human's approval for this call; no prompts at all is worse.
      const reason = prompts.form ? 'client_cannot_approve' : 'no_approval_path';
      this.db
        .insert(pendingApprovals)
        .values({ ...row, status: 'denied', decidedAt: now })
        .run();
      return { id, decision: Promise.resolve({ outcome: 'denied', reason }) };
    }

    this.db.insert(pendingApprovals).values(row).run();
    const decision = new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => settle({ outcome: 'timed_out' }), input.timeoutMs);
      const settle = (d: Decision) => {
        if (!this.live.delete(id)) return; // first decision wins
        clearTimeout(timer);
        const status = d.outcome === 'timed_out' ? 'timed_out' : d.outcome;
        this.db
          .update(pendingApprovals)
          .set({ status, decidedBy: d.decidedBy ?? null, decidedVia: d.via ?? null, decidedAt: this.now() })
          .where(and(eq(pendingApprovals.id, id), eq(pendingApprovals.status, 'pending')))
          .run();
        this.links.consumeAll(id);
        if (channel === 'url') prompts.urlComplete?.(id);
        resolve(d);
      };
      this.live.set(id, { row, settle });
    });

    if (channel === 'url') this.offerUrl(id, row.expiresAt, input);
    else this.offerForm(id, input);
    return { id, decision };
  }

  private message(input: ApprovalRequestInput, trailer: string) {
    return [input.summary, '', `Operation: ${input.operationKey} (${input.classification})`, '', trailer].join('\n');
  }

  private offerUrl(id: string, expiresAt: Date, input: ApprovalRequestInput) {
    const token = this.links.create(id, expiresAt);
    const clientDenied = (reason: string): Decision => ({
      outcome: 'denied',
      via: 'elicitation',
      decidedBy: input.client.id,
      reason,
    });
    input.prompts!.url!({
      approvalId: id,
      path: `/a/${token}`,
      message: this.message(input, 'Open the approval page to review the details and approve or deny.'),
    }).then(
      (res) => {
        // `accept` only means the page was opened; the decision is made there.
        if (res.action !== 'accept') this.live.get(id)?.settle(clientDenied('declined'));
      },
      // The client could not show the prompt: nobody can reach the page, so don't wait for the timeout.
      () => this.live.get(id)?.settle(clientDenied('prompt_failed')),
    );
  }

  private offerForm(id: string, input: ApprovalRequestInput) {
    const message = this.message(
      input,
      `Parameters: ${JSON.stringify(input.paramsDisplay)}${input.diff ? `\nChanges: ${JSON.stringify(input.diff)}` : ''}`,
    );
    input.prompts!.form!({
      approvalId: id,
      message,
      requestedSchema: {
        type: 'object',
        properties: { approve: { type: 'boolean', title: 'Approve this call?' } },
        required: ['approve'],
      },
    }).then(
      (res) => {
        const live = this.live.get(id);
        if (!live) return;
        const approved = res.action === 'accept' && res.content?.approve === true;
        live.settle({ outcome: approved ? 'approved' : 'denied', via: 'elicitation', decidedBy: input.client.id });
      },
      () => this.live.get(id)?.settle({ outcome: 'denied', reason: 'prompt_failed' }),
    );
  }

  /** The approval page's decision. A wrong typed confirmation is rejected so the approver can retry. */
  decide(id: string, input: { approve: boolean; confirm?: string; decidedBy: string }): Decision {
    const live = this.live.get(id);
    if (!live) {
      const row = this.db.select().from(pendingApprovals).where(eq(pendingApprovals.id, id)).get();
      if (!row) throw new NotFoundError('approval_not_found', 'No such approval');
      throw new ConflictError('approval_closed', `This approval is already ${row.status}`);
    }
    if (input.approve && live.row.confirmLiteral && input.confirm !== live.row.confirmLiteral) {
      throw new ValidationError('confirmation_mismatch', `Type "${live.row.confirmLiteral}" exactly to approve`);
    }
    const decision: Decision = {
      outcome: input.approve ? 'approved' : 'denied',
      via: 'url',
      decidedBy: input.decidedBy,
    };
    live.settle(decision);
    return decision;
  }

  /** Cancels one open request (its execution ended). Returns false if it was already decided. */
  cancel(id: string, reason: string): boolean {
    const live = this.live.get(id);
    if (!live) return false;
    live.settle({ outcome: 'cancelled', reason });
    return true;
  }

  /** Cancels the open requests of one endpoint (it was stopped: disabled, deleted or reconfigured). */
  cancelForInstance(instanceId: string, reason: string): number {
    const mine = [...this.live.values()].filter((l) => l.row.instanceId === instanceId);
    for (const live of mine) live.settle({ outcome: 'cancelled', reason });
    return mine.length;
  }

  /** Cancels every open request (shutdown). Cancelled calls are denied to the sandbox. */
  cancelAll(reason = 'shutdown') {
    for (const live of [...this.live.values()]) live.settle({ outcome: 'cancelled', reason });
  }
}
