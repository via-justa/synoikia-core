import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { roleInstanceIds } from '../catalog/role-levels.js';
import type { Db } from '../db/index.js';
import { mcpTokens, pluginInstances } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { ACCESS_CEILINGS, ADMIN_ROLE_ID } from '../gate/access.js';
import { randomToken, sha256 } from './tokens.js';

/** Static MCP bearer tokens (design §6.2): `syn_…`, shown once, stored as SHA-256, scoped to instances
 * or `*`; outside its scope a token gets 403. */

export const TOKEN_PREFIX = 'syn_';

const CreateTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scope: z.array(z.string().min(1)).min(1),
  /** `read` (default) hides and blocks every write, whatever the endpoint's levels allow. */
  access: z.enum(ACCESS_CEILINGS).default('read'),
  expiresAt: z.coerce.date().nullable().optional(),
});

type TokenRow = typeof mcpTokens.$inferSelect;

const publicToken = (t: TokenRow) => ({
  id: t.id,
  createdBy: t.createdBy,
  name: t.name,
  scope: t.scope,
  access: t.access,
  createdAt: t.createdAt,
  expiresAt: t.expiresAt,
  lastUsedAt: t.lastUsedAt,
  revokedAt: t.revokedAt,
});

export class McpTokenService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(owner?: string) {
    return this.db
      .select()
      .from(mcpTokens)
      .where(owner ? eq(mcpTokens.createdBy, owner) : undefined)
      .orderBy(asc(mcpTokens.createdAt))
      .all()
      .map(publicToken);
  }

  /** Every token has an owner: their role decides what it reaches (design §6.4). */
  create(raw: unknown, actor: { userId: string }) {
    const input = CreateTokenSchema.parse(raw);
    if (input.expiresAt && input.expiresAt.getTime() <= this.now().getTime()) {
      throw new ValidationError('invalid_expiry', 'Expiry must be in the future');
    }
    if (!input.scope.includes('*')) {
      const known = new Set(
        this.db
          .select({ id: pluginInstances.id })
          .from(pluginInstances)
          .all()
          .map((r) => r.id),
      );
      const unknown = input.scope.filter((s) => !known.has(s));
      if (unknown.length)
        throw new ValidationError('unknown_instance', `Unknown endpoint(s) in scope: ${unknown.join(', ')}`);
    }
    const token = `${TOKEN_PREFIX}${randomToken(32)}`;
    const id = randomUUID();
    this.db.transaction((tx) => {
      tx.insert(mcpTokens)
        .values({
          id,
          name: input.name,
          tokenHash: sha256(token),
          scope: input.scope,
          access: input.access,
          createdBy: actor.userId,
          createdAt: this.now(),
          expiresAt: input.expiresAt ?? null,
        })
        .run();
      writeAudit(tx, {
        kind: 'config',
        decision: 'mcp_token_created',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { id, name: input.name, scope: input.scope, access: input.access, expiresAt: input.expiresAt ?? null },
      });
    });
    return { ...publicToken(this.db.select().from(mcpTokens).where(eq(mcpTokens.id, id)).get()!), token };
  }

  /** A user's own token: a non-admin names only their role's endpoints, and `*` follows the role's
   * endpoints as they change. */
  createOwn(raw: { scope: string[] }, user: { id: string; roleId: string }) {
    if (user.roleId !== ADMIN_ROLE_ID) {
      const mine = new Set(roleInstanceIds(this.db, user.roleId));
      const outside = raw.scope.filter((s) => s !== '*' && !mine.has(s));
      if (outside.length)
        throw new ValidationError('unknown_instance', `Unknown endpoint(s) in scope: ${outside.join(', ')}`);
    }
    return this.create(raw, { userId: user.id });
  }

  revoke(id: string, actor: { userId?: string } = {}) {
    const row = this.db.select().from(mcpTokens).where(eq(mcpTokens.id, id)).get();
    if (!row) throw new NotFoundError('token_not_found', 'No such token');
    this.db.transaction((tx) => {
      tx.update(mcpTokens).set({ revokedAt: this.now() }).where(eq(mcpTokens.id, id)).run();
      writeAudit(tx, {
        kind: 'config',
        decision: 'mcp_token_revoked',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { id, name: row.name },
      });
    });
  }

  /** Revokes a token the user created; any other answers 404, as if it didn't exist. */
  revokeOwn(id: string, userId: string) {
    const by = this.db.select({ by: mcpTokens.createdBy }).from(mcpTokens).where(eq(mcpTokens.id, id)).get()?.by;
    if (by !== userId) throw new NotFoundError('token_not_found', 'No such token');
    this.revoke(id, { userId });
  }

  /** Their creator was disabled: bearer tokens they made are revoked (re-enabling revives none). */
  revokeCreatedBy(userId: string, actor: { userId?: string } = {}) {
    return this.db.transaction((tx) => {
      const live = tx
        .select({ id: mcpTokens.id, name: mcpTokens.name })
        .from(mcpTokens)
        .where(and(eq(mcpTokens.createdBy, userId), isNull(mcpTokens.revokedAt)))
        .all();
      if (!live.length) return 0;
      tx.update(mcpTokens)
        .set({ revokedAt: this.now() })
        .where(
          inArray(
            mcpTokens.id,
            live.map((t) => t.id),
          ),
        )
        .run();
      writeAudit(tx, {
        kind: 'config',
        decision: 'mcp_tokens_revoked',
        actorKind: actor.userId ? 'user' : 'system',
        actorId: actor.userId,
        detail: { createdBy: userId, reason: 'user_disabled', tokens: live.map((t) => t.name) },
      });
      return live.length;
    });
  }

  /** Returns the token row if the value is live (not revoked/expired), regardless of scope. */
  verify(value: string): TokenRow | null {
    if (!value.startsWith(TOKEN_PREFIX) || value.length > 200) return null;
    const row = this.db
      .select()
      .from(mcpTokens)
      .where(eq(mcpTokens.tokenHash, sha256(value)))
      .get();
    if (!row || row.revokedAt) return null;
    const now = this.now();
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 60_000) {
      this.db.update(mcpTokens).set({ lastUsedAt: now }).where(eq(mcpTokens.id, row.id)).run();
    }
    return row;
  }

  /** The token is still live and scoped to the instance (a parked execution re-checks this, design §5.6). */
  liveFor(id: string, instanceId: string): boolean {
    const row = this.db.select().from(mcpTokens).where(eq(mcpTokens.id, id)).get();
    if (!row || row.revokedAt) return false;
    if (row.expiresAt && row.expiresAt.getTime() <= this.now().getTime()) return false;
    return McpTokenService.inScope(row, instanceId);
  }

  static inScope(row: Pick<TokenRow, 'scope'>, instanceId: string): boolean {
    return row.scope.includes('*') || row.scope.includes(instanceId);
  }
}
