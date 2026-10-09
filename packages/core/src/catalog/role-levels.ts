import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import type { Db, DbLike } from '../db/index.js';
import { operationGroups, operations, roleInstances, roleLevels, roles, userLevels, users } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import {
  ACCESS_LEVELS,
  ADMIN_ROLE_ID,
  allowedLevels,
  capLevel,
  effectiveAccess,
  isAccessLevel,
  levelInForce,
  normalizeLevel,
  tighterLevel,
} from '../gate/access.js';
import type { AccessCaps, AccessLevel, AccessPrincipal, LevelLayer } from '../gate/access.js';
import { accessInput } from './groups.js';
import type { Actor } from './groups.js';

/** Role maximum levels and users' own levels (design §5.2.1, §6.4), on top of the endpoint's levels. */

type GroupRow = typeof operationGroups.$inferSelect;
type OperationRow = typeof operations.$inferSelect;
type LevelRow = { groupId: string | null; operationId: string | null; level: AccessLevel };

export type LevelTarget = { group: string } | { operationId: string };

interface Layers {
  byGroup: Map<string, AccessLevel>;
  byOp: Map<string, AccessLevel>;
}

const toLayers = (rows: LevelRow[]): Layers => ({
  byGroup: new Map(rows.filter((r) => r.groupId).map((r) => [r.groupId!, r.level])),
  byOp: new Map(rows.filter((r) => r.operationId).map((r) => [r.operationId!, r.level])),
});

const layerFor = (layers: Layers, op: Pick<OperationRow, 'id' | 'groupId'>): LevelLayer => ({
  group: layers.byGroup.get(op.groupId) ?? null,
  op: layers.byOp.get(op.id) ?? null,
});

export function roleInstanceIds(db: DbLike, roleId: string): string[] {
  return db
    .select({ id: roleInstances.instanceId })
    .from(roleInstances)
    .where(eq(roleInstances.roleId, roleId))
    .all()
    .map((r) => r.id);
}

export function roleHasInstance(db: DbLike, roleId: string, instanceId: string): boolean {
  if (roleId === ADMIN_ROLE_ID) return true;
  return !!db
    .select({ id: roleInstances.instanceId })
    .from(roleInstances)
    .where(and(eq(roleInstances.roleId, roleId), eq(roleInstances.instanceId, instanceId)))
    .get();
}

/** The caps a principal's role and own levels put on one endpoint's operations; undefined for admins. */
export function loadCaps(
  db: DbLike,
  instanceId: string,
  principal: AccessPrincipal,
): ((op: Pick<OperationRow, 'id' | 'groupId'>) => AccessCaps) | undefined {
  if (principal.roleId === ADMIN_ROLE_ID) return undefined;
  const role = db.select().from(roles).where(eq(roles.id, principal.roleId)).get();
  if (!role || !roleHasInstance(db, role.id, instanceId)) return () => ({ role: null });
  const roleRows = toLayers(
    db
      .select()
      .from(roleLevels)
      .where(and(eq(roleLevels.roleId, role.id), eq(roleLevels.instanceId, instanceId)))
      .all(),
  );
  const ownRows =
    role.canSetOwnLevels && principal.userId
      ? toLayers(
          db
            .select()
            .from(userLevels)
            .where(and(eq(userLevels.userId, principal.userId), eq(userLevels.instanceId, instanceId)))
            .all(),
        )
      : undefined;
  return (op) => ({ role: layerFor(roleRows, op), own: ownRows && layerFor(ownRows, op) });
}

// ── views ────────────────────────────────────────────────────────────────────────────────────────

export interface LevelView {
  groups: {
    key: string;
    label: string;
    /** The endpoint's level for the group (the Admin role's). */
    endpointLevel: AccessLevel;
    roleLevel: AccessLevel | null;
    ownLevel: AccessLevel | null;
  }[];
  operations: {
    id: string;
    key: string;
    displayName: string | null;
    description: string | null;
    group: string | null;
    classification: 'read' | 'write' | 'locked';
    allowedLevels: AccessLevel[];
    endpointLevel: AccessLevel;
    /** The role's entry for this operation; null follows the role's group level. */
    roleLevel: AccessLevel | null;
    /** What the role allows here at most: the endpoint's level capped by the role's. */
    roleMax: AccessLevel;
    ownLevel: AccessLevel | null;
    level: AccessLevel;
    reachable: boolean;
    mode: 'run' | 'approve' | 'auto' | null;
    reason: string | null;
  }[];
}

const describeOf = (op: OperationRow) => {
  const docs = op.docs as { summary?: unknown; description?: unknown } | null;
  if (typeof docs?.summary === 'string') return docs.summary;
  return typeof docs?.description === 'string' ? docs.description : null;
};

/** The levels one role (and, with `userId`, one user) has on an endpoint. `reachableOnly` leaves out
 * what the user can't call: a non-admin sees only that. */
export function levelView(
  db: DbLike,
  instanceId: string,
  who: { roleId: string; userId?: string },
  opts: { reachableOnly?: boolean } = {},
): LevelView {
  const groups = db
    .select()
    .from(operationGroups)
    .where(and(eq(operationGroups.instanceId, instanceId), eq(operationGroups.stale, false)))
    .orderBy(asc(operationGroups.key))
    .all();
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const ops = db
    .select()
    .from(operations)
    .where(and(eq(operations.instanceId, instanceId), eq(operations.stale, false)))
    .orderBy(asc(operations.key))
    .all();
  const principal: AccessPrincipal = { ceiling: 'write', roleId: who.roleId, userId: who.userId };
  const caps = loadCaps(db, instanceId, principal);
  const opRows = ops.map((op) => {
    const group = groupById.get(op.groupId);
    const input = accessInput(op);
    const endpointLevel = levelInForce(input, group);
    const cap = caps?.(op);
    const roleMax = cap?.role ? capLevel(input, endpointLevel, cap.role) : cap ? 'none' : endpointLevel;
    const access = effectiveAccess(input, group, principal, cap);
    return {
      id: op.id,
      key: op.key,
      displayName: op.displayName,
      description: describeOf(op),
      group: group?.key ?? null,
      classification: op.locked ? ('locked' as const) : op.classification,
      allowedLevels: allowedLevels(op),
      endpointLevel,
      roleLevel: cap?.role?.op ?? null,
      roleMax,
      ownLevel: cap?.own?.op ?? null,
      level: access.reachable ? access.level : 'none',
      reachable: access.reachable,
      mode: access.reachable ? access.mode : null,
      reason: access.reachable ? null : access.reason,
    };
  });
  const visible = opts.reachableOnly ? opRows.filter((o) => o.reachable) : opRows;
  const shownGroups = new Set(visible.map((o) => o.group));
  const groupLayer = (g: GroupRow, pick: 'role' | 'own') => {
    const cap = caps?.({ id: '', groupId: g.id });
    return (pick === 'role' ? cap?.role?.group : cap?.own?.group) ?? null;
  };
  return {
    groups: groups
      .filter((g) => !opts.reachableOnly || shownGroups.has(g.key))
      .map((g) => ({
        key: g.key,
        label: g.label,
        endpointLevel: g.level,
        roleLevel: groupLayer(g, 'role'),
        ownLevel: groupLayer(g, 'own'),
      })),
    operations: visible,
  };
}

// ── changes ──────────────────────────────────────────────────────────────────────────────────────

function assertLevel(level: unknown): asserts level is AccessLevel {
  if (!isAccessLevel(level)) {
    throw new ValidationError('invalid_level', `Level must be one of ${ACCESS_LEVELS.join(', ')}`);
  }
}

function resolveTarget(db: DbLike, instanceId: string, target: LevelTarget): { group?: GroupRow; op?: OperationRow } {
  if ('group' in target) {
    const group = db
      .select()
      .from(operationGroups)
      .where(and(eq(operationGroups.instanceId, instanceId), eq(operationGroups.key, target.group)))
      .get();
    if (!group) throw new NotFoundError('group_not_found', `No group "${target.group}" on this endpoint`);
    return { group };
  }
  const op = db
    .select()
    .from(operations)
    .where(and(eq(operations.instanceId, instanceId), eq(operations.id, target.operationId)))
    .get();
  if (!op) throw new NotFoundError('operation_not_found', 'No such operation on this endpoint');
  return { op };
}

function checkOpLevel(op: OperationRow, level: AccessLevel) {
  if (!allowedLevels(op).includes(level)) {
    throw new ValidationError('level_not_allowed', `${op.key} can be ${allowedLevels(op).join(', ')}`);
  }
}

/** Sets (or, with null, clears) a role's maximum for a group or an operation. A group level resets the
 * role's entries for that group's operations, as the endpoint's group level does. */
export function setRoleLevel(
  db: Db,
  roleId: string,
  instanceId: string,
  target: LevelTarget,
  level: string | null,
  opts: { actor?: Actor; now?: Date } = {},
) {
  if (roleId === ADMIN_ROLE_ID)
    throw new ConflictError('built_in_role', "The Admin role uses the endpoint's own levels");
  if (!db.select().from(roles).where(eq(roles.id, roleId)).get())
    throw new NotFoundError('role_not_found', 'No such role');
  if (!roleHasInstance(db, roleId, instanceId))
    throw new ConflictError('not_in_role', 'Add the endpoint to the role first');
  if (level !== null) assertLevel(level);
  const now = opts.now ?? new Date();
  db.transaction((tx) => {
    const { group, op } = resolveTarget(tx, instanceId, target);
    if (op && level !== null) checkOpLevel(op, level);
    const scope = and(eq(roleLevels.roleId, roleId), eq(roleLevels.instanceId, instanceId));
    if (group) {
      const opIds = tx
        .select({ id: operations.id })
        .from(operations)
        .where(eq(operations.groupId, group.id))
        .all()
        .map((o) => o.id);
      if (opIds.length)
        tx.delete(roleLevels)
          .where(and(scope, inArray(roleLevels.operationId, opIds)))
          .run();
      tx.delete(roleLevels)
        .where(and(scope, eq(roleLevels.groupId, group.id)))
        .run();
    } else {
      tx.delete(roleLevels)
        .where(and(scope, eq(roleLevels.operationId, op!.id)))
        .run();
    }
    if (level !== null) {
      tx.insert(roleLevels)
        .values({
          id: randomUUID(),
          roleId,
          instanceId,
          groupId: group?.id ?? null,
          operationId: op?.id ?? null,
          level,
          changedAt: now,
          changedBy: opts.actor?.userId ?? null,
        })
        .run();
    }
    writeAudit(
      tx,
      {
        kind: 'config',
        instanceId,
        decision: 'role_level_changed',
        actorKind: 'user',
        actorId: opts.actor?.userId,
        detail: { roleId, group: group?.key, operation: op?.key, level },
      },
      now,
    );
  });
}

/** Sets every group of the endpoint to one maximum for the role and clears its operation entries. */
export function setRoleBulkLevel(
  db: Db,
  roleId: string,
  instanceId: string,
  level: string,
  opts: { actor?: Actor; now?: Date } = {},
) {
  assertLevel(level);
  const groups = db.select().from(operationGroups).where(eq(operationGroups.instanceId, instanceId)).all();
  for (const g of groups) setRoleLevel(db, roleId, instanceId, { group: g.key }, level, opts);
}

/** A user's own level (design §6.4): only with the role's switch, on the role's endpoints, and never
 * above the role's maximum. */
export function setOwnLevel(
  db: Db,
  userId: string,
  instanceId: string,
  target: LevelTarget,
  level: string | null,
  now = new Date(),
) {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new NotFoundError('user_not_found', 'No such user');
  const role = db.select().from(roles).where(eq(roles.id, user.roleId)).get();
  if (!role?.canSetOwnLevels || role.id === ADMIN_ROLE_ID)
    throw new ConflictError('own_levels_off', 'Your role does not let you set your own levels');
  if (!roleHasInstance(db, role.id, instanceId)) throw new NotFoundError('instance_not_found', 'No such endpoint');
  if (level !== null) assertLevel(level);
  db.transaction((tx) => {
    const { group, op } = resolveTarget(tx, instanceId, target);
    const caps = loadCaps(tx, instanceId, { ceiling: 'write', roleId: role.id })!;
    if (level !== null) {
      if (op) {
        checkOpLevel(op, level);
        const endpoint = levelInForce(
          accessInput(op),
          tx.select().from(operationGroups).where(eq(operationGroups.id, op.groupId)).get(),
        );
        const max = capLevel(accessInput(op), endpoint, caps(op).role ?? {});
        const own = normalizeLevel(op, level);
        if (tighterLevel(own, max) !== own)
          throw new ValidationError('above_role_max', `Your role allows at most ${max} for ${op.key}`);
      } else {
        const max = caps({ id: '', groupId: group!.id }).role?.group ?? 'none';
        if (ACCESS_LEVELS.indexOf(level) > ACCESS_LEVELS.indexOf(max))
          throw new ValidationError('above_role_max', `Your role allows at most ${max} for ${group!.key}`);
      }
    }
    const scope = and(eq(userLevels.userId, userId), eq(userLevels.instanceId, instanceId));
    if (group) {
      const opIds = tx
        .select({ id: operations.id })
        .from(operations)
        .where(eq(operations.groupId, group.id))
        .all()
        .map((o) => o.id);
      if (opIds.length)
        tx.delete(userLevels)
          .where(and(scope, inArray(userLevels.operationId, opIds)))
          .run();
      tx.delete(userLevels)
        .where(and(scope, eq(userLevels.groupId, group.id)))
        .run();
    } else {
      tx.delete(userLevels)
        .where(and(scope, eq(userLevels.operationId, op!.id)))
        .run();
    }
    if (level !== null) {
      tx.insert(userLevels)
        .values({
          id: randomUUID(),
          userId,
          instanceId,
          groupId: group?.id ?? null,
          operationId: op?.id ?? null,
          level,
          changedAt: now,
        })
        .run();
    }
    writeAudit(
      tx,
      {
        kind: 'config',
        instanceId,
        decision: 'own_level_changed',
        actorKind: 'user',
        actorId: userId,
        detail: { group: group?.key, operation: op?.key, level },
      },
      now,
    );
  });
}
