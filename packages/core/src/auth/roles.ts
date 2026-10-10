import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { levelView, setRoleBulkLevel, setRoleLevel } from '../catalog/role-levels.js';
import type { LevelTarget, LevelView } from '../catalog/role-levels.js';
import type { Db, DbLike } from '../db/index.js';
import { pluginInstances, roleInstances, roleLevels, roles, users } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { ADMIN_ROLE_ID } from '../gate/access.js';
import type { AccessLevel } from '../gate/access.js';
import { getSettings } from '../settings.js';

/** Roles (design §6.4): the built-in Admin role plus admin-defined ones, each with its endpoints, its
 * maximum levels (`catalog/role-levels.ts`) and three switches. */

export type RoleRow = typeof roles.$inferSelect;

export interface PublicRole {
  id: string;
  name: string;
  isAdmin: boolean;
  canSetOwnLevels: boolean;
  canManageOwnRules: boolean;
  canSeeStatus: boolean;
}

export const toPublicRole = (r: RoleRow): PublicRole => ({
  id: r.id,
  name: r.name,
  isAdmin: r.id === ADMIN_ROLE_ID,
  canSetOwnLevels: r.canSetOwnLevels,
  canManageOwnRules: r.canManageOwnRules,
  canSeeStatus: r.canSeeStatus,
});

const RoleInput = z.object({
  name: z.string().trim().min(1).max(64),
  canSetOwnLevels: z.boolean().default(false),
  canManageOwnRules: z.boolean().default(false),
  canSeeStatus: z.boolean().default(false),
});

export class RoleService {
  constructor(private readonly db: Db) {}

  get(id: string, db: DbLike = this.db): RoleRow {
    const role = db.select().from(roles).where(eq(roles.id, id)).get();
    if (!role) throw new NotFoundError('role_not_found', 'No such role');
    return role;
  }

  list() {
    const members = new Map(
      this.db
        .select({ roleId: users.roleId, n: count() })
        .from(users)
        .groupBy(users.roleId)
        .all()
        .map((r) => [r.roleId, r.n]),
    );
    const endpoints = this.db.select().from(roleInstances).all();
    const defaultRoleId = getSettings(this.db, 'security').defaultRoleId;
    return this.db
      .select()
      .from(roles)
      .orderBy(asc(roles.createdAt), asc(roles.name))
      .all()
      .map((r) => ({
        ...toPublicRole(r),
        users: members.get(r.id) ?? 0,
        instanceIds: endpoints.filter((e) => e.roleId === r.id).map((e) => e.instanceId),
        isDefault: r.id === defaultRoleId,
      }));
  }

  create(raw: unknown, actor: { userId?: string } = {}): PublicRole {
    const input = RoleInput.parse(raw);
    const id = randomUUID();
    this.db.transaction((tx) => {
      if (tx.select({ id: roles.id }).from(roles).where(eq(roles.name, input.name)).get())
        throw new ConflictError('role_name_taken', 'A role with that name exists');
      tx.insert(roles)
        .values({ id, ...input, createdAt: new Date() })
        .run();
      writeAudit(tx, {
        kind: 'config',
        decision: 'role_created',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { id, ...input },
      });
    });
    return toPublicRole(this.get(id));
  }

  update(id: string, raw: unknown, actor: { userId?: string } = {}): PublicRole {
    const before = this.get(id);
    if (before.builtIn) throw new ConflictError('built_in_role', 'The Admin role cannot be changed');
    const input = RoleInput.partial().parse(raw);
    this.db.transaction((tx) => {
      if (input.name && input.name !== before.name) {
        if (tx.select({ id: roles.id }).from(roles).where(eq(roles.name, input.name)).get())
          throw new ConflictError('role_name_taken', 'A role with that name exists');
      }
      tx.update(roles)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(roles.id, id))
        .run();
      writeAudit(tx, {
        kind: 'config',
        decision: 'role_updated',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { id, before: toPublicRole(before), changes: input },
      });
    });
    return toPublicRole(this.get(id));
  }

  remove(id: string, actor: { userId?: string } = {}) {
    const role = this.get(id);
    if (role.builtIn) throw new ConflictError('built_in_role', 'The Admin role cannot be deleted');
    if (getSettings(this.db, 'security').defaultRoleId === id)
      throw new ConflictError('default_role', 'This is the default role for new users; choose another first');
    this.db.transaction((tx) => {
      const n = tx.select({ n: count() }).from(users).where(eq(users.roleId, id)).get()?.n ?? 0;
      if (n > 0) throw new ConflictError('role_in_use', `${n} user(s) have this role; move them first`);
      tx.delete(roles).where(eq(roles.id, id)).run();
      writeAudit(tx, {
        kind: 'config',
        decision: 'role_deleted',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { id, name: role.name },
      });
    });
  }

  /** Sets the endpoints a role has; levels on a removed endpoint go with it. */
  setInstances(id: string, instanceIds: string[], actor: { userId?: string } = {}) {
    const role = this.get(id);
    if (role.builtIn) throw new ConflictError('built_in_role', 'The Admin role has every endpoint');
    const wanted = [...new Set(instanceIds)];
    const known = new Set(
      wanted.length
        ? this.db
            .select({ id: pluginInstances.id })
            .from(pluginInstances)
            .where(inArray(pluginInstances.id, wanted))
            .all()
            .map((r) => r.id)
        : [],
    );
    const unknown = wanted.filter((w) => !known.has(w));
    if (unknown.length) throw new ValidationError('unknown_instance', `Unknown endpoint(s): ${unknown.join(', ')}`);
    this.db.transaction((tx) => {
      const before = tx
        .select()
        .from(roleInstances)
        .where(eq(roleInstances.roleId, id))
        .all()
        .map((r) => r.instanceId);
      const removed = before.filter((b) => !wanted.includes(b));
      if (removed.length) {
        tx.delete(roleInstances)
          .where(and(eq(roleInstances.roleId, id), inArray(roleInstances.instanceId, removed)))
          .run();
        tx.delete(roleLevels)
          .where(and(eq(roleLevels.roleId, id), inArray(roleLevels.instanceId, removed)))
          .run();
      }
      for (const instanceId of wanted.filter((w) => !before.includes(w)))
        tx.insert(roleInstances).values({ roleId: id, instanceId }).run();
      writeAudit(tx, {
        kind: 'config',
        decision: 'role_endpoints_changed',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { id, before, after: wanted },
      });
    });
    return wanted;
  }

  /** The role's maximum levels on an endpoint. */
  levels(id: string, instanceId: string): LevelView {
    return levelView(this.db, instanceId, { roleId: id });
  }

  setLevel(
    id: string,
    instanceId: string,
    target: LevelTarget,
    level: AccessLevel | null,
    actor: { userId?: string } = {},
  ): LevelView {
    setRoleLevel(this.db, id, instanceId, target, level, { actor });
    return this.levels(id, instanceId);
  }

  setBulkLevel(id: string, instanceId: string, level: AccessLevel, actor: { userId?: string } = {}): LevelView {
    setRoleBulkLevel(this.db, id, instanceId, level, { actor });
    return this.levels(id, instanceId);
  }
}
