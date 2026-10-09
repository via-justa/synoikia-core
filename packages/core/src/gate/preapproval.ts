import type { ResolvedTarget } from '@synoikia/plugin-sdk';
import { and, asc, count, eq, gt, isNull, or } from 'drizzle-orm';
import type { Db, DbLike } from '../db/index.js';
import { preApprovalHits, preApprovalRules, roles, users } from '../db/schema.js';
import { conditionsHold, coversAllParams, MatchSchema } from './match.js';

export type PreApprovalOutcome =
  | { kind: 'auto_approved'; ruleId: string }
  /** Rules matched but all were at their rate limit: the call falls back to a human. */
  | { kind: 'rate_limited'; ruleIds: string[] }
  | { kind: 'no_match' };

function ownRulesOn(db: DbLike, userId: string | undefined): boolean {
  if (!userId) return false;
  const row = db
    .select({ on: roles.canManageOwnRules })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.id, userId))
    .get();
  return !!row?.on;
}

/** Finds a matching, unexpired rule with budget left and records the hit, in one transaction. Never
 * called for locked operations (design §5.2). */
export function evaluatePreApproval(
  db: Db,
  input: {
    instanceId: string;
    operationId: string;
    params: unknown;
    targets: readonly ResolvedTarget[];
    /** The params subtrees a `$targets` condition covers (the profile field's `covers`), for strict matching. */
    targetCovers?: readonly string[];
    /** The caller's user: their own rules apply too while their role allows own rules (design §6.4). */
    userId?: string;
  },
  now = new Date(),
): PreApprovalOutcome {
  return db.transaction((tx) => {
    const rules = tx
      .select()
      .from(preApprovalRules)
      .where(
        and(
          eq(preApprovalRules.instanceId, input.instanceId),
          eq(preApprovalRules.operationId, input.operationId),
          eq(preApprovalRules.enabled, true),
          ownRulesOn(tx, input.userId)
            ? or(isNull(preApprovalRules.ownerUserId), eq(preApprovalRules.ownerUserId, input.userId!))
            : isNull(preApprovalRules.ownerUserId),
        ),
      )
      .orderBy(asc(preApprovalRules.createdAt))
      .all();

    const limited: string[] = [];
    for (const rule of rules) {
      if (rule.expiresAt && rule.expiresAt.getTime() <= now.getTime()) continue;
      const match = MatchSchema.safeParse(rule.match);
      if (!match.success || !conditionsHold(match.data, { params: input.params, targets: input.targets })) continue;
      const alsoCovered = match.data.some((c) => c.field === '$targets') ? (input.targetCovers ?? []) : [];
      if (!coversAllParams(match.data, input.params, alsoCovered)) {
        // It would have matched before strict matching: remember it so the rule list can say why.
        tx.update(preApprovalRules).set({ strictMissAt: now }).where(eq(preApprovalRules.id, rule.id)).run();
        continue;
      }

      if (rule.rateLimit != null) {
        const windowMs = (rule.windowSeconds ?? 3600) * 1000;
        const used =
          tx
            .select({ n: count() })
            .from(preApprovalHits)
            .where(
              and(
                eq(preApprovalHits.ruleId, rule.id),
                gt(preApprovalHits.occurredAt, new Date(now.getTime() - windowMs)),
              ),
            )
            .get()?.n ?? 0;
        if (used >= rule.rateLimit) {
          limited.push(rule.id);
          continue;
        }
      }
      tx.insert(preApprovalHits).values({ ruleId: rule.id, occurredAt: now }).run();
      tx.update(preApprovalRules).set({ lastTriggeredAt: now }).where(eq(preApprovalRules.id, rule.id)).run();
      return { kind: 'auto_approved', ruleId: rule.id };
    }
    return limited.length > 0 ? { kind: 'rate_limited', ruleIds: limited } : { kind: 'no_match' };
  });
}
