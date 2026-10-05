import { and, desc, eq, gte, lt, lte, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { DbLike } from './db/index.js';
import { auditLog } from './db/schema.js';

/** Audit log reads for the portal (design §8.2): filterable, paginated, exportable. Never writes. */

const AuditQuerySchema = z.object({
  instance: z.string().optional(),
  kind: z.enum(['call', 'search', 'config', 'auth', 'plugin']).optional(),
  /** Prefix match, e.g. `auto-approved` or `rejected:`. */
  decision: z.string().optional(),
  operation: z.string().optional(),
  /** Substring of the resolved targets JSON, e.g. an entity id. */
  target: z.string().optional(),
  actor: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

const escapeLike = (s: string) => s.replace(/[%_\\]/g, (c) => `\\${c}`);

function where(q: AuditQuery): SQL | undefined {
  const c: SQL[] = [];
  if (q.instance) c.push(eq(auditLog.instanceId, q.instance));
  if (q.kind) c.push(eq(auditLog.kind, q.kind));
  if (q.decision) c.push(sql`${auditLog.decision} LIKE ${`${escapeLike(q.decision)}%`} ESCAPE '\\'`);
  if (q.operation) c.push(sql`${auditLog.operationKey} LIKE ${`${escapeLike(q.operation)}%`} ESCAPE '\\'`);
  if (q.target) c.push(sql`${auditLog.resolvedTargets} LIKE ${`%${escapeLike(q.target)}%`} ESCAPE '\\'`);
  if (q.actor) c.push(eq(auditLog.actorId, q.actor));
  if (q.from) c.push(gte(auditLog.at, q.from));
  if (q.to) c.push(lte(auditLog.at, q.to));
  return c.length ? and(...c) : undefined;
}

export function queryAudit(db: DbLike, raw: unknown) {
  const q = AuditQuerySchema.parse(raw);
  const rows = db
    .select()
    .from(auditLog)
    .where(where(q))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(q.limit)
    .offset(q.offset)
    .all();
  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(auditLog)
      .where(where(q))
      .get()?.n ?? 0;
  return { rows, total, limit: q.limit, offset: q.offset };
}

const CSV_COLUMNS = [
  'id',
  'at',
  'kind',
  'instanceId',
  'operationKey',
  'classification',
  'decision',
  'actorKind',
  'actorId',
  'decidedBy',
  'decidedVia',
  'resultStatus',
  'durationMs',
  'params',
  'resolvedTargets',
  'detail',
] as const;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Neutralize spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_PAGE = 1000;

/** The audit CSV, paged by keyset (last row seen), so large exports neither sit in memory nor shift. */
export function* auditCsvChunks(db: DbLike, raw: unknown): Generator<string> {
  const q = AuditQuerySchema.parse({ ...(raw as object), limit: CSV_PAGE });
  yield `${CSV_COLUMNS.join(',')}\n`;
  let last: { at: Date; id: number } | undefined;
  for (;;) {
    const after = last
      ? or(lt(auditLog.at, last.at), and(eq(auditLog.at, last.at), lt(auditLog.id, last.id)))
      : undefined;
    const rows = db
      .select()
      .from(auditLog)
      .where(and(where(q), after))
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(CSV_PAGE)
      .all();
    if (rows.length) yield rows.map((r) => `${CSV_COLUMNS.map((c) => csvCell(r[c])).join(',')}\n`).join('');
    if (rows.length < CSV_PAGE) return;
    const tail = rows.at(-1)!;
    last = { at: tail.at, id: tail.id };
  }
}

export function exportAuditCsv(db: DbLike, raw: unknown): string {
  return [...auditCsvChunks(db, raw)].join('');
}
