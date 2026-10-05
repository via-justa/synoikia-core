import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import type { Db, DbLike } from '../db/index.js';
import { operationGroupAliases, operationGroups, operations, pluginInstances } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { ACCESS_LEVELS, FULL_ACCESS, allowedLevels, effectiveAccess, isAccessLevel, minLevel } from '../gate/access.js';
import type { AccessDecision, AccessLevel, AccessPrincipal } from '../gate/access.js';

/** Group access management (design §5.2.1): audited `config` events, unreachable from sandboxed code. */

type GroupRow = typeof operationGroups.$inferSelect;
type OperationRow = typeof operations.$inferSelect;

export interface Actor {
  userId?: string;
}

function assertLevel(level: unknown): asserts level is AccessLevel {
  if (!isAccessLevel(level)) {
    throw new ValidationError('invalid_level', `Level must be one of ${ACCESS_LEVELS.join(', ')}`);
  }
}

export const accessInput = (op: OperationRow) => ({
  classification: op.classification,
  locked: op.locked,
  levelOverride: op.levelOverride,
  writeAcknowledged: op.writeAcknowledged,
});

const isPlainWrite = (op: OperationRow) => !op.stale && !op.locked && op.classification === 'write';

/** The plain writes in a group that run without asking at `write` (raising to `write` acknowledges them). */
const runsAtGroupWrite = isPlainWrite;

/** Resets every operation in these groups to follow its group; returns the keys that had their own level. */
function resetOwnLevels(db: DbLike, groupIds: string[]): string[] {
  const own = opsInGroups(db, groupIds).filter((o) => o.levelOverride !== null);
  if (own.length > 0) {
    db.update(operations)
      .set({ levelOverride: null })
      .where(
        inArray(
          operations.id,
          own.map((o) => o.id),
        ),
      )
      .run();
  }
  return own.map((o) => o.key);
}

/** Writes whose effective level is `write` but that nobody acknowledged yet: they ask until someone does. */
function isPendingWrite(op: OperationRow, group: GroupRow | undefined): boolean {
  return isPlainWrite(op) && !op.writeAcknowledged && (op.levelOverride ?? group?.level) === 'write';
}

function getGroup(db: DbLike, instanceId: string, key: string): GroupRow {
  const group = db
    .select()
    .from(operationGroups)
    .where(and(eq(operationGroups.instanceId, instanceId), eq(operationGroups.key, key)))
    .get();
  if (!group) throw new NotFoundError('group_not_found', `No group "${key}" on this instance`);
  return group;
}

function opsInGroups(db: DbLike, groupIds: string[]): OperationRow[] {
  if (groupIds.length === 0) return [];
  return db.select().from(operations).where(inArray(operations.groupId, groupIds)).orderBy(asc(operations.key)).all();
}

function acknowledge(db: DbLike, opIds: string[], actor: Actor, now: Date) {
  if (opIds.length === 0) return;
  db.update(operations)
    .set({ writeAcknowledged: true, acknowledgedAt: now, acknowledgedBy: actor.userId ?? null })
    .where(inArray(operations.id, opIds))
    .run();
}

// ── reads ────────────────────────────────────────────────────────────────────────────────────────

export interface GroupSummary {
  key: string;
  label: string;
  level: AccessLevel;
  stale: boolean;
  counts: { read: number; write: number; locked: number; pendingReview: number; overridden: number };
}

export function listGroups(db: DbLike, instanceId: string): GroupSummary[] {
  const groups = db
    .select()
    .from(operationGroups)
    .where(eq(operationGroups.instanceId, instanceId))
    .orderBy(asc(operationGroups.key))
    .all();
  const ops = opsInGroups(
    db,
    groups.map((g) => g.id),
  ).filter((o) => !o.stale);
  return groups.map((g) => {
    const mine = ops.filter((o) => o.groupId === g.id);
    return {
      key: g.key,
      label: g.label,
      level: g.level,
      stale: g.stale,
      counts: {
        read: mine.filter((o) => !o.locked && o.classification === 'read').length,
        write: mine.filter((o) => !o.locked && o.classification === 'write').length,
        locked: mine.filter((o) => o.locked).length,
        pendingReview: mine.filter((o) => isPendingWrite(o, g)).length,
        overridden: mine.filter((o) => o.levelOverride !== null).length,
      },
    };
  });
}

/** Access decision for one operation key; unknown or stale operations are unreachable. */
export function resolveAccess(
  db: DbLike,
  instanceId: string,
  key: string,
  principal: AccessPrincipal = FULL_ACCESS,
): AccessDecision | { reachable: false; reason: 'unknown_operation' } {
  const op = db
    .select()
    .from(operations)
    .where(and(eq(operations.instanceId, instanceId), eq(operations.key, key)))
    .get();
  if (!op || op.stale) return { reachable: false, reason: 'unknown_operation' };
  const group = db.select().from(operationGroups).where(eq(operationGroups.id, op.groupId)).get();
  return effectiveAccess(accessInput(op), group, principal);
}

// ── group level ──────────────────────────────────────────────────────────────────────────────────

/** Sets a group's level and resets its operations to follow it; raising to `write` acknowledges the
 * plain writes it opens, listed in the audit event. */
export function setGroupLevel(
  db: Db,
  instanceId: string,
  key: string,
  level: string,
  opts: { actor?: Actor; now?: Date } = {},
): GroupSummary {
  assertLevel(level);
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? {};
  db.transaction((tx) => {
    const group = getGroup(tx, instanceId, key);
    const acknowledged = level === 'write' ? acknowledgeWrites(tx, [group.id], actor, now) : [];
    const reset = resetOwnLevels(tx, [group.id]);
    if (group.level === level && acknowledged.length === 0 && reset.length === 0) return;
    tx.update(operationGroups)
      .set({ level, levelChangedAt: now, levelChangedBy: actor.userId ?? null })
      .where(eq(operationGroups.id, group.id))
      .run();
    writeAudit(
      tx,
      {
        kind: 'config',
        instanceId,
        decision: 'group_level_changed',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { group: key, from: group.level, to: level, acknowledged, reset },
      },
      now,
    );
  });
  return listGroups(db, instanceId).find((g) => g.key === key)!;
}

/** Acknowledges the not-yet-acknowledged plain writes in these groups; returns their keys. */
function acknowledgeWrites(db: DbLike, groupIds: string[], actor: Actor, now: Date): string[] {
  const fresh = opsInGroups(db, groupIds).filter((o) => runsAtGroupWrite(o) && !o.writeAcknowledged);
  acknowledge(
    db,
    fresh.map((o) => o.id),
    actor,
    now,
  );
  return fresh.map((o) => o.key);
}

/** Sets every group to one level and resets operations to follow; `write` acknowledges plain writes. */
export function applyBulkLevel(
  db: Db,
  instanceId: string,
  level: string,
  opts: { actor?: Actor; now?: Date } = {},
): { key: string; label: string; from: AccessLevel }[] {
  assertLevel(level);
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? {};
  return db.transaction((tx) => {
    const instance = tx.select().from(pluginInstances).where(eq(pluginInstances.id, instanceId)).get();
    if (!instance) throw new NotFoundError('instance_not_found', 'No such instance');
    const groups = tx
      .select()
      .from(operationGroups)
      .where(eq(operationGroups.instanceId, instanceId))
      .orderBy(asc(operationGroups.key))
      .all();
    const ids = groups.map((g) => g.id);
    const acknowledged = level === 'write' ? acknowledgeWrites(tx, ids, actor, now) : [];
    const reset = resetOwnLevels(tx, ids);
    tx.update(operationGroups)
      .set({ level, levelChangedAt: now, levelChangedBy: actor.userId ?? null })
      .where(eq(operationGroups.instanceId, instanceId))
      .run();
    writeAudit(
      tx,
      {
        kind: 'config',
        instanceId,
        decision: 'group_level_bulk_changed',
        actorKind: 'user',
        actorId: actor.userId,
        detail: {
          to: level,
          groups: groups.map((g) => ({ key: g.key, from: g.level, to: level })),
          acknowledged,
          reset,
        },
      },
      now,
    );
    return groups.map((g) => ({ key: g.key, label: g.label, from: g.level }));
  });
}

// ── regrouping ───────────────────────────────────────────────────────────────────────────────────

export function renameGroup(db: Db, instanceId: string, key: string, label: string, opts: { actor?: Actor } = {}) {
  const trimmed = label.trim();
  if (!trimmed) throw new ValidationError('invalid_label', 'Label must not be empty');
  db.transaction((tx) => {
    const group = getGroup(tx, instanceId, key);
    tx.update(operationGroups).set({ label: trimmed }).where(eq(operationGroups.id, group.id)).run();
    writeAudit(tx, {
      kind: 'config',
      instanceId,
      decision: 'group_renamed',
      actorKind: 'user',
      actorId: opts.actor?.userId,
      detail: { group: key, from: group.label, to: trimmed },
    });
  });
}

/** Merges groups into `into`, stored as aliases for future syncs; takes the lowest level involved. */
export function mergeGroups(
  db: Db,
  instanceId: string,
  input: { from: string[]; into: string; label?: string },
  opts: { actor?: Actor; now?: Date } = {},
): GroupSummary {
  const now = opts.now ?? new Date();
  const into = input.into.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(into)) throw new ValidationError('invalid_group_key', 'Invalid group key');
  const fromKeys = [...new Set(input.from)].filter((k) => k !== into);
  if (fromKeys.length === 0) throw new ValidationError('nothing_to_merge', 'Pick at least one other group to merge');

  db.transaction((tx) => {
    const sources = fromKeys.map((k) => getGroup(tx, instanceId, k));
    let target = tx
      .select()
      .from(operationGroups)
      .where(and(eq(operationGroups.instanceId, instanceId), eq(operationGroups.key, into)))
      .get();
    const level = [...sources, ...(target ? [target] : [])].map((g) => g.level).reduce(minLevel);
    if (!target) {
      target = {
        id: randomUUID(),
        instanceId,
        key: into,
        label: input.label?.trim() || into,
        level,
        levelChangedAt: now,
        levelChangedBy: opts.actor?.userId ?? null,
        firstSeenAt: now,
        stale: false,
      };
      tx.insert(operationGroups).values(target).run();
    } else {
      tx.update(operationGroups)
        .set({
          level,
          stale: false,
          ...(input.label?.trim() ? { label: input.label.trim() } : {}),
          ...(level !== target.level ? { levelChangedAt: now, levelChangedBy: opts.actor?.userId ?? null } : {}),
        })
        .where(eq(operationGroups.id, target.id))
        .run();
    }

    const sourceIds = sources.map((g) => g.id);
    const pluginGroups = new Set(opsInGroups(tx, sourceIds).map((o) => o.pluginGroup));
    // Aliases that pointed at a merged group now point at the target.
    for (const a of tx
      .select()
      .from(operationGroupAliases)
      .where(and(eq(operationGroupAliases.instanceId, instanceId), inArray(operationGroupAliases.groupKey, fromKeys)))
      .all()) {
      pluginGroups.add(a.pluginGroup);
    }
    for (const k of fromKeys) pluginGroups.add(k);
    for (const pluginGroup of pluginGroups) {
      tx.insert(operationGroupAliases)
        .values({ instanceId, pluginGroup, groupKey: into })
        .onConflictDoUpdate({
          target: [operationGroupAliases.instanceId, operationGroupAliases.pluginGroup],
          set: { groupKey: into },
        })
        .run();
    }
    tx.update(operations).set({ groupId: target.id }).where(inArray(operations.groupId, sourceIds)).run();
    tx.delete(operationGroups).where(inArray(operationGroups.id, sourceIds)).run();
    writeAudit(
      tx,
      {
        kind: 'config',
        instanceId,
        decision: 'groups_merged',
        actorKind: 'user',
        actorId: opts.actor?.userId,
        detail: { from: sources.map((g) => ({ key: g.key, level: g.level })), into, level },
      },
      now,
    );
  });
  return listGroups(db, instanceId).find((g) => g.key === into)!;
}

// ── per-operation state ──────────────────────────────────────────────────────────────────────────

export interface OperationPatch {
  /** The operation's own level (one its kind allows); `null` makes it follow its group again. */
  level?: AccessLevel | null;
  acknowledged?: boolean;
  /** Require a best-practice key (guides) for this operation; turning it off is remembered across syncs. */
  attestationRequired?: boolean;
}

/** Per-operation level and acknowledgement. The level must fit the operation's kind; locked refuses
 * `write` (409). Setting a write to `write` acknowledges it. */
export function updateOperation(
  db: Db,
  instanceId: string,
  opId: string,
  patch: OperationPatch,
  opts: { actor?: Actor; now?: Date } = {},
): void {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? {};
  db.transaction((tx) => {
    const op = tx
      .select()
      .from(operations)
      .where(and(eq(operations.id, opId), eq(operations.instanceId, instanceId)))
      .get();
    if (!op) throw new NotFoundError('operation_not_found', 'No such operation on this instance');

    const set: Partial<typeof operations.$inferInsert> = {};
    if (patch.level !== undefined && patch.level !== op.levelOverride) {
      if (patch.level !== null) {
        assertLevel(patch.level);
        if (patch.level === 'write' && op.locked) {
          throw new ConflictError('operation_locked', `${op.key} is locked; it always asks for approval`);
        }
        const allowed = allowedLevels(op);
        if (!allowed.includes(patch.level)) {
          throw new ValidationError(
            'invalid_level_for_operation',
            `${op.key} is a ${op.locked ? 'locked operation' : op.classification}; its level must be one of ${allowed.join(', ')}`,
          );
        }
      }
      set.levelOverride = patch.level;
    }
    const isWrite = op.locked || op.classification === 'write';
    const acknowledges = patch.acknowledged === true || (patch.level === 'write' && isWrite);
    if (acknowledges && !op.writeAcknowledged) {
      Object.assign(set, { writeAcknowledged: true, acknowledgedAt: now, acknowledgedBy: actor.userId ?? null });
    }
    if (patch.attestationRequired !== undefined && patch.attestationRequired !== op.attestationRequired) {
      set.attestationRequired = patch.attestationRequired;
      set.attestationWaived = !patch.attestationRequired;
    }
    if (patch.acknowledged === false) {
      Object.assign(set, { writeAcknowledged: false, acknowledgedAt: null, acknowledgedBy: null });
    }
    if (Object.keys(set).length === 0) return;

    tx.update(operations).set(set).where(eq(operations.id, op.id)).run();
    writeAudit(
      tx,
      {
        kind: 'config',
        instanceId,
        operationKey: op.key,
        decision: 'operation_updated',
        actorKind: 'user',
        actorId: actor.userId,
        detail: {
          before: {
            level: op.levelOverride,
            writeAcknowledged: op.writeAcknowledged,
            attestationRequired: op.attestationRequired,
          },
          after: set,
        },
      },
      now,
    );
  });
}
