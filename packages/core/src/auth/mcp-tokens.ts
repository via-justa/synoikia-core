import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import type { Db } from '../db/index.js';
import { mcpTokens, pluginInstances } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { ACCESS_CEILINGS } from '../gate/access.js';
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

  list() {
    return this.db.select().from(mcpTokens).orderBy(asc(mcpTokens.createdAt)).all().map(publicToken);
  }

  create(raw: unknown, actor: { userId?: string } = {}) {
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
          createdBy: actor.userId ?? null,
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

  static inScope(row: Pick<TokenRow, 'scope'>, instanceId: string): boolean {
    return row.scope.includes('*') || row.scope.includes(instanceId);
  }
}
