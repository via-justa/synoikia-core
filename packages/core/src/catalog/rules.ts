import { randomUUID } from 'node:crypto';
import type { Manifest } from '@synoikia/plugin-sdk';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import type { Db } from '../db/index.js';
import { operations, preApprovalRules, users } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { FULL_ACCESS } from '../gate/access.js';
import type { AccessPrincipal } from '../gate/access.js';
import { MatchSchema } from '../gate/match.js';
import { resolveAccess } from './groups.js';

/** Pre-approval rules (design §5.2): from the catalog, with a required reason, structured match and
 * optional rate limit and expiry. Locked operations are refused here (409), whatever the UI offers. */

const RuleInputSchema = z.object({
  operationId: z.string().min(1),
  match: MatchSchema.default([]),
  rateLimit: z.number().int().min(1).max(100_000).nullable().optional(),
  windowSeconds: z
    .number()
    .int()
    .min(60)
    .max(31 * 24 * 3600)
    .nullable()
    .optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  reason: z.string().trim().min(3, 'A reason is required').max(500),
  enabled: z.boolean().default(true),
});
export type RuleInput = z.infer<typeof RuleInputSchema>;

type OperationRow = typeof operations.$inferSelect;
type RuleRow = typeof preApprovalRules.$inferSelect;
type UserRow = typeof users.$inferSelect;

function loadOperation(db: Db, instanceId: string, operationId: string): OperationRow {
  const op = db
    .select()
    .from(operations)
    .where(and(eq(operations.id, operationId), eq(operations.instanceId, instanceId)))
    .get();
  if (!op) throw new NotFoundError('operation_not_found', 'No such operation on this endpoint');
  return op;
}

/** Why a rule's match doesn't fit the operation's declared fields (design §8.3), or null if it does. */
export function matchMisfit(
  manifest: Pick<Manifest, 'matchProfiles' | 'targets'>,
  op: Pick<OperationRow, 'key' | 'matchProfile'>,
  match: RuleInput['match'],
): ValidationError | null {
  if (match.every((c) => c.field !== '$targets' && 'op' in c && c.op === 'any')) return null;
  const profile = op.matchProfile ? manifest.matchProfiles[op.matchProfile] : undefined;
  if (!profile) return new ValidationError('no_match_profile', `${op.key} has no matchable fields; use an empty match`);
  for (const c of match) {
    // "Any value" can name any parameter: it only widens strict matching, never narrows a condition.
    if (c.field !== '$targets' && 'op' in c && c.op === 'any') continue;
    const field = profile.find((f) => f.field === c.field);
    if (!field) return new ValidationError('unknown_match_field', `${c.field} is not a matchable field of ${op.key}`);
    if (c.field !== '$targets' && 'op' in c && field.op !== c.op) {
      return new ValidationError('wrong_match_op', `${c.field} must use the "${field.op}" operator`);
    }
    if (c.field === '$targets' && 'scopes' in c && c.scopes) {
      const offered =
        (field.options?.scopes as string[] | undefined) ?? manifest.targets?.scopes.map((s) => s.key) ?? [];
      const unknown = Object.keys(c.scopes).find((key) => !offered.includes(key));
      if (unknown !== undefined) {
        return new ValidationError('unknown_target_scope', `${op.key} can't select targets by "${unknown}"`);
      }
    }
  }
  return null;
}

function checkMatchAgainstProfile(manifest: Manifest, op: OperationRow, match: RuleInput['match']) {
  const misfit = matchMisfit(manifest, op, match);
  if (misfit) throw misfit;
}

function describe(db: Db, instanceId: string, rule: RuleRow, op: OperationRow, owner?: UserRow) {
  // An own rule fires only where its owner's levels put the operation at Ask (design §6.4).
  const principal: AccessPrincipal = owner ? { ceiling: 'write', roleId: owner.roleId, userId: owner.id } : FULL_ACCESS;
  const access = resolveAccess(db, instanceId, op.key, principal);
  return {
    ...rule,
    owner: owner ? { id: owner.id, username: owner.username } : null,
    operation: { id: op.id, key: op.key, locked: op.locked, matchProfile: op.matchProfile },
    /** Rules only fire at level `ask`; on unreachable or `write` operations they never do (UI flags it). */
    inert: !rule.enabled ? null : !access.reachable ? access.reason : access.level === 'write' ? 'level_write' : null,
  };
}

export function listRules(db: Db, instanceId: string) {
  return db
    .select({ rule: preApprovalRules, op: operations, owner: users })
    .from(preApprovalRules)
    .innerJoin(operations, eq(preApprovalRules.operationId, operations.id))
    .leftJoin(users, eq(preApprovalRules.ownerUserId, users.id))
    .where(eq(preApprovalRules.instanceId, instanceId))
    .orderBy(asc(operations.key), asc(preApprovalRules.createdAt))
    .all()
    .map(({ rule, op, owner }) => describe(db, instanceId, rule, op, owner ?? undefined));
}

/** A rule as the given owner may touch it: admins (no owner) any rule, a user only their own. */
function ownedRule(db: Db, instanceId: string, ruleId: string, owner?: string): RuleRow {
  const rule = db
    .select()
    .from(preApprovalRules)
    .where(and(eq(preApprovalRules.id, ruleId), eq(preApprovalRules.instanceId, instanceId)))
    .get();
  if (!rule || (owner !== undefined && rule.ownerUserId !== owner))
    throw new NotFoundError('rule_not_found', 'No such rule');
  return rule;
}

export function createRule(
  db: Db,
  manifest: Manifest,
  instanceId: string,
  raw: unknown,
  actor: { userId?: string } = {},
  opts: { owner?: string } = {},
) {
  const input = RuleInputSchema.parse(raw);
  const op = loadOperation(db, instanceId, input.operationId);
  if (op.locked) throw new ConflictError('operation_locked', `${op.key} is locked and can never be pre-approved`);
  checkMatchAgainstProfile(manifest, op, input.match);
  const id = randomUUID();
  db.transaction((tx) => {
    tx.insert(preApprovalRules)
      .values({
        id,
        instanceId,
        operationId: op.id,
        match: input.match,
        rateLimit: input.rateLimit ?? null,
        windowSeconds: input.rateLimit ? (input.windowSeconds ?? 3600) : null,
        expiresAt: input.expiresAt ?? null,
        reason: input.reason,
        enabled: input.enabled,
        createdBy: actor.userId ?? null,
        ownerUserId: opts.owner ?? null,
        createdAt: new Date(),
      })
      .run();
    writeAudit(tx, {
      kind: 'config',
      instanceId,
      operationKey: op.key,
      decision: 'rule_created',
      actorKind: 'user',
      actorId: actor.userId,
      detail: { ruleId: id, ...input, ...(opts.owner ? { owner: opts.owner } : {}) },
    });
  });
  return listRules(db, instanceId).find((r) => r.id === id)!;
}

export function updateRule(
  db: Db,
  manifest: Manifest,
  instanceId: string,
  ruleId: string,
  raw: unknown,
  actor: { userId?: string } = {},
  opts: { owner?: string } = {},
) {
  const before = ownedRule(db, instanceId, ruleId, opts.owner);
  const input = RuleInputSchema.parse({ ...before, ...(raw as object) });
  const op = loadOperation(db, instanceId, input.operationId);
  if (op.locked) throw new ConflictError('operation_locked', `${op.key} is locked and can never be pre-approved`);
  checkMatchAgainstProfile(manifest, op, input.match);
  const set = {
    operationId: op.id,
    match: input.match,
    rateLimit: input.rateLimit ?? null,
    windowSeconds: input.rateLimit ? (input.windowSeconds ?? 3600) : null,
    expiresAt: input.expiresAt ?? null,
    reason: input.reason,
    enabled: input.enabled,
    updatedAt: new Date(),
  };
  db.transaction((tx) => {
    tx.update(preApprovalRules).set(set).where(eq(preApprovalRules.id, ruleId)).run();
    writeAudit(tx, {
      kind: 'config',
      instanceId,
      operationKey: op.key,
      decision: 'rule_updated',
      actorKind: 'user',
      actorId: actor.userId,
      detail: { ruleId, before, after: set },
    });
  });
  return listRules(db, instanceId).find((r) => r.id === ruleId)!;
}

export function deleteRule(
  db: Db,
  instanceId: string,
  ruleId: string,
  actor: { userId?: string } = {},
  opts: { owner?: string } = {},
) {
  const before = ownedRule(db, instanceId, ruleId, opts.owner);
  db.transaction((tx) => {
    tx.delete(preApprovalRules).where(eq(preApprovalRules.id, ruleId)).run();
    writeAudit(tx, {
      kind: 'config',
      instanceId,
      decision: 'rule_deleted',
      actorKind: 'user',
      actorId: actor.userId,
      detail: { rule: before },
    });
  });
}
