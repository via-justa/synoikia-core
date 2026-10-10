import { randomUUID } from 'node:crypto';
import type { Manifest } from '@synoikia/plugin-sdk';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import type { Db } from '../db/index.js';
import { operations, preApprovalRules, roleInstances, roles, users } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { FULL_ACCESS } from '../gate/access.js';
import type { AccessPrincipal } from '../gate/access.js';
import { MatchSchema } from '../gate/match.js';
import { resolveAccess } from './groups.js';
import type { LevelView } from './role-levels.js';

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

/** Whether some role that has the endpoint can reach the operation at Ask, or lower it to Ask itself. */
function firesForSomeRole(db: Db, instanceId: string, key: string): boolean {
  return db
    .select({ role: roles })
    .from(roleInstances)
    .innerJoin(roles, eq(roleInstances.roleId, roles.id))
    .where(eq(roleInstances.instanceId, instanceId))
    .all()
    .some(({ role }) => {
      const access = resolveAccess(db, instanceId, key, { ceiling: 'write', roleId: role.id });
      return access.reachable && (access.level === 'ask' || (role.canSetOwnLevels && access.level === 'write'));
    });
}

function describe(db: Db, instanceId: string, rule: RuleRow, op: OperationRow, owner?: UserRow) {
  // An own rule fires only where its owner's levels put the operation at Ask (design §6.4).
  const principal: AccessPrincipal = owner ? { ceiling: 'write', roleId: owner.roleId, userId: owner.id } : FULL_ACCESS;
  const access = resolveAccess(db, instanceId, op.key, principal);
  const inert = !rule.enabled
    ? null
    : !access.reachable
      ? access.reason
      : access.level === 'write'
        ? 'level_write'
        : null;
  return {
    ...rule,
    owner: owner ? { id: owner.id, username: owner.username } : null,
    operation: { id: op.id, key: op.key, locked: op.locked, matchProfile: op.matchProfile },
    /** Rules only fire at level `ask`; on unreachable or `write` operations they never do (UI flags it).
     * An admin rule is inert only if it is for every role that has the endpoint. */
    inert: inert && !owner && firesForSomeRole(db, instanceId, op.key) ? null : inert,
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

// ── own rules (design §6.4) ──

/** A user writing their own rules, with the operations they can reach. */
export interface RuleOwner {
  userId: string;
  operations: LevelView['operations'];
}

/** The owner's rules, plus admin rules on operations they can reach (read-only to them). */
export function listOwnRules(db: Db, instanceId: string, owner: RuleOwner) {
  const reachable = new Set(owner.operations.map((o) => o.id));
  return listRules(db, instanceId)
    .filter((r) => r.ownerUserId === owner.userId || (r.ownerUserId === null && reachable.has(r.operationId)))
    .map((r) => ({ ...r, editable: r.ownerUserId === owner.userId }));
}

function checkReachable(owner: RuleOwner, raw: unknown) {
  const opId = (raw as { operationId?: unknown } | null)?.operationId;
  if (opId === undefined) return;
  if (!owner.operations.some((o) => o.id === opId))
    throw new ValidationError('operation_not_reachable', 'You can only write rules for operations you can call');
}

// `manifest` is read after the owner checks, so an unusable plugin doesn't hide their answer.
export function createOwnRule(db: Db, manifest: () => Manifest, instanceId: string, raw: unknown, owner: RuleOwner) {
  if ((raw as { operationId?: unknown } | null)?.operationId === undefined)
    throw new ValidationError('invalid_rule', 'operationId is required');
  checkReachable(owner, raw);
  const rule = createRule(db, manifest(), instanceId, raw, { userId: owner.userId }, { owner: owner.userId });
  return { ...rule, editable: true };
}

export function updateOwnRule(
  db: Db,
  manifest: () => Manifest,
  instanceId: string,
  ruleId: string,
  raw: unknown,
  owner: RuleOwner,
) {
  checkReachable(owner, raw);
  const rule = updateRule(db, manifest(), instanceId, ruleId, raw, { userId: owner.userId }, { owner: owner.userId });
  return { ...rule, editable: true };
}

export function deleteOwnRule(db: Db, instanceId: string, ruleId: string, userId: string) {
  deleteRule(db, instanceId, ruleId, { userId }, { owner: userId });
}

/** The match fields of operations the owner may write rules for: reachable, plain writes. */
function ownRuleFields(manifest: Manifest, owner: RuleOwner) {
  return owner.operations
    .filter((o) => o.classification === 'write' && o.matchProfile)
    .flatMap((o) => manifest.matchProfiles[o.matchProfile!] ?? []);
}

/** The rule editor's pickers offer only what a rule the owner may write can name. */
export function checkOwnOptionsSource(manifest: Manifest, owner: RuleOwner, source: string) {
  if (!ownRuleFields(manifest, owner).some((f) => f.optionsSource === source))
    throw new NotFoundError('options_not_found', 'No such options source');
}

export function checkOwnRegistryKind(manifest: Manifest, owner: RuleOwner, kind: string | undefined) {
  const kinds = new Set(
    [manifest.targets?.registryKind, ...(manifest.targets?.scopes ?? []).map((s) => s.registryKind)].filter(Boolean),
  );
  if (!ownRuleFields(manifest, owner).some((f) => f.field === '$targets') || !kind || !kinds.has(kind))
    throw new NotFoundError('registry_not_found', 'No such registry kind');
}
