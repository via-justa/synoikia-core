import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { DbLike } from '../db/index.js';
import { guides } from '../db/schema.js';

/** Best-practice attestation (design §5.1): `search` hands out a key MACed over instance, operation,
 * guide version and MCP session; `execute` must present it from the same session. */

export function issueAttestationKey(
  macKey: Buffer,
  instanceId: string,
  opKey: string,
  guideVersion: string,
  mcpSessionId = '',
): string {
  return createHmac('sha256', macKey)
    .update(`${instanceId}\n${opKey}\n${guideVersion}\n${mcpSessionId}`)
    .digest('base64url');
}

export function currentGuide(db: DbLike, instanceId: string, operationId: string) {
  return db
    .select()
    .from(guides)
    .where(and(eq(guides.instanceId, instanceId), eq(guides.operationId, operationId)))
    .orderBy(desc(guides.fetchedAt))
    .get();
}

export function verifyAttestationKey(
  db: DbLike,
  macKey: Buffer,
  input: { instanceId: string; operationId: string; opKey: string; mcpSessionId?: string; presented: unknown },
): boolean {
  if (typeof input.presented !== 'string' || input.presented === '') return false;
  const guide = currentGuide(db, input.instanceId, input.operationId);
  if (!guide) return false;
  const expected = Buffer.from(
    issueAttestationKey(macKey, input.instanceId, input.opKey, guide.version, input.mcpSessionId),
  );
  const presented = Buffer.from(input.presented);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
