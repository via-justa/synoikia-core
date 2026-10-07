import { randomUUID } from 'node:crypto';
import { writeAudit } from '../audit.js';
import type { Db } from '../db/index.js';

/** Session grants (design §5.8): an approver lets one client credential run Ask operations on one endpoint
 * for a while, except locked and typed-confirmation ones. In memory only, so a restart ends them all. */

export interface SessionGrant {
  id: string;
  instanceId: string;
  /** `principalKey` of the caller the grant covers. */
  principal: string;
  /** The client's audit label, for display. */
  client?: string;
  createdBy: string;
  approvalId: string;
  createdAt: Date;
  expiresAt: Date;
}

export class SessionGrantService {
  private readonly grants = new Map<string, SessionGrant>();

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: Omit<SessionGrant, 'id' | 'createdAt'>): SessionGrant {
    // One grant per client and endpoint: a new one replaces the old.
    const old = this.active(input.instanceId, input.principal);
    if (old) this.end(old, 'replaced', input.createdBy, 'user');
    const grant: SessionGrant = { ...input, id: randomUUID(), createdAt: this.now() };
    this.grants.set(grant.id, grant);
    writeAudit(
      this.db,
      {
        kind: 'config',
        instanceId: grant.instanceId,
        decision: 'session_grant.created',
        actorKind: 'user',
        actorId: grant.createdBy,
        detail: {
          grantId: grant.id,
          client: grant.client,
          approvalId: grant.approvalId,
          expiresAt: grant.expiresAt.toISOString(),
        },
      },
      grant.createdAt,
    );
    return grant;
  }

  /** The live grant for this client on this endpoint, if any; expired ones end here. */
  active(instanceId: string, principal: string): SessionGrant | undefined {
    for (const g of this.list(instanceId)) if (g.principal === principal) return g;
    return undefined;
  }

  get(id: string): SessionGrant | undefined {
    this.sweep();
    return this.grants.get(id);
  }

  list(instanceId?: string): SessionGrant[] {
    this.sweep();
    return [...this.grants.values()].filter((g) => !instanceId || g.instanceId === instanceId);
  }

  /** Ends a grant early; false if it was not live. */
  revoke(id: string, by: { actorKind: 'user' | 'mcp_client'; actorId?: string }): boolean {
    const g = this.get(id);
    if (!g) return false;
    this.end(g, 'revoked', by.actorId, by.actorKind);
    return true;
  }

  endForInstance(instanceId: string, reason: string): void {
    for (const g of this.list(instanceId)) this.end(g, reason);
  }

  private sweep() {
    const now = this.now().getTime();
    for (const g of [...this.grants.values()]) if (g.expiresAt.getTime() <= now) this.end(g, 'expired');
  }

  private end(
    g: SessionGrant,
    reason: string,
    actorId?: string,
    actorKind: 'user' | 'mcp_client' | 'system' = 'system',
  ) {
    if (!this.grants.delete(g.id)) return;
    writeAudit(
      this.db,
      {
        kind: 'config',
        instanceId: g.instanceId,
        decision: 'session_grant.ended',
        actorKind: actorId ? actorKind : 'system',
        actorId,
        detail: { grantId: g.id, client: g.client, reason },
      },
      this.now(),
    );
  }
}
