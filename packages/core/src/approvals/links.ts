import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { approvalLinks } from '../db/schema.js';
import { randomToken, sha256 } from '../auth/tokens.js';

/** Approval page tokens (design §5.3): single-use, hashed, expiring with their approval. A token only
 * opens the page; deciding needs a signed-in human with TOTP. */
export class ApprovalLinkService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(approvalId: string, expiresAt: Date): string {
    const token = randomToken(32);
    this.db
      .insert(approvalLinks)
      .values({ tokenHash: sha256(token), approvalId, action: 'view', expiresAt })
      .run();
    return token;
  }

  /** The live link row for a token, or null if unknown, used, or expired. */
  resolve(token: string) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    return (
      this.db
        .select()
        .from(approvalLinks)
        .where(
          and(
            eq(approvalLinks.tokenHash, sha256(token)),
            isNull(approvalLinks.usedAt),
            gt(approvalLinks.expiresAt, this.now()),
          ),
        )
        .get() ?? null
    );
  }

  /** Burns every link of an approval once it has been decided. */
  consumeAll(approvalId: string) {
    this.db
      .update(approvalLinks)
      .set({ usedAt: this.now() })
      .where(and(eq(approvalLinks.approvalId, approvalId), isNull(approvalLinks.usedAt)))
      .run();
  }

  purgeExpired(): number {
    return this.db
      .delete(approvalLinks)
      .where(lt(approvalLinks.expiresAt, new Date(this.now().getTime() - 24 * 3600_000)))
      .run().changes;
  }
}
