/** Access levels (design §5.2.1): an operation follows its group's level unless given its own, limited to
 * what its kind allows; locked ops open only with their own Ask, and a `read` ceiling never reaches a write. */

export const ACCESS_LEVELS = ['none', 'read', 'ask', 'write'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const ACCESS_CEILINGS = ['read', 'write'] as const;
export type AccessCeiling = (typeof ACCESS_CEILINGS)[number];

const RANK: Record<AccessLevel, number> = { none: 0, read: 1, ask: 2, write: 3 };

export const isAccessLevel = (v: unknown): v is AccessLevel => (ACCESS_LEVELS as readonly unknown[]).includes(v);

export const minLevel = (a: AccessLevel, b: AccessLevel): AccessLevel => (RANK[a] <= RANK[b] ? a : b);

export type AccessReason = 'group_missing' | 'level_none' | 'token_read_only' | 'locked_not_opted_in';

/** `run`: read, no approval · `approve`: needs a human (or a pre-approval rule) · `auto`: write, auto-approved. */
export type AccessMode = 'run' | 'approve' | 'auto';

export interface AccessOperation {
  classification: 'read' | 'write';
  locked: boolean;
  levelOverride: AccessLevel | null;
  writeAcknowledged: boolean;
}

export interface AccessGroup {
  level: AccessLevel;
}

export interface AccessPrincipal {
  ceiling: AccessCeiling;
}

export type AccessDecision =
  | {
      reachable: true;
      mode: AccessMode;
      level: AccessLevel;
      /** A write at level `write` that nobody acknowledged yet: it asks until an admin does. */
      pendingReview?: true;
    }
  | { reachable: false; reason: AccessReason };

export const FULL_ACCESS: AccessPrincipal = { ceiling: 'write' };

const isWriteOp = (op: Pick<AccessOperation, 'classification' | 'locked'>) =>
  op.locked || op.classification === 'write';

/** The levels an operation can be given on its own. */
export function allowedLevels(op: Pick<AccessOperation, 'classification' | 'locked'>): AccessLevel[] {
  if (op.locked) return ['none', 'ask'];
  return isWriteOp(op) ? ['none', 'ask', 'write'] : ['none', 'read', 'ask'];
}

/** Maps a stored level onto one the operation's kind allows, never widening; unknown values are None. */
export function normalizeLevel(op: Pick<AccessOperation, 'classification' | 'locked'>, level: unknown): AccessLevel {
  if (!isAccessLevel(level)) return 'none';
  if (allowedLevels(op).includes(level)) return level;
  if (op.locked) return level === 'write' ? 'ask' : 'none';
  return isWriteOp(op) ? 'none' : 'read';
}

/** What a group's level means for one operation that follows it (the table above). */
function fromGroup(op: Pick<AccessOperation, 'classification' | 'locked'>, level: AccessLevel): AccessLevel {
  if (level === 'none' || op.locked) return 'none';
  if (!isWriteOp(op)) return 'read';
  return level === 'read' ? 'none' : level;
}

/** The level in force for an operation: its own (normalized), else what its group's level means for it. */
export function levelInForce(op: AccessOperation, group: AccessGroup | undefined): AccessLevel {
  if (op.levelOverride !== null) return normalizeLevel(op, op.levelOverride);
  if (!group || !isAccessLevel(group.level)) return 'none';
  return fromGroup(op, group.level);
}

export function effectiveAccess(
  op: AccessOperation,
  group: AccessGroup | undefined,
  principal: AccessPrincipal = FULL_ACCESS,
): AccessDecision {
  // Fail closed on a missing or unrecognized group row.
  if (!group || !isAccessLevel(group.level)) return { reachable: false, reason: 'group_missing' };
  const level = levelInForce(op, group);

  if (level === 'none') {
    // A locked op its group would otherwise open says why it is still off.
    const lockedClosed = op.locked && op.levelOverride === null && group.level !== 'none';
    return { reachable: false, reason: lockedClosed ? 'locked_not_opted_in' : 'level_none' };
  }
  if (!isWriteOp(op)) return { reachable: true, mode: level === 'ask' ? 'approve' : 'run', level };

  if (principal.ceiling !== 'write') return { reachable: false, reason: 'token_read_only' };
  // Locked ops only reach here with their own Ask, and never auto-approve.
  if (level === 'ask' || op.locked) return { reachable: true, mode: 'approve', level: 'ask' };
  if (!op.writeAcknowledged) return { reachable: true, mode: 'approve', level, pendingReview: true };
  return { reachable: true, mode: 'auto', level };
}
