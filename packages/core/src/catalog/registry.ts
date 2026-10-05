import { randomUUID } from 'node:crypto';
import { RegistryEntrySchema } from '@synoikia/plugin-sdk';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbLike } from '../db/index.js';
import { registryEntries } from '../db/schema.js';
import { ValidationError } from '../errors.js';

/** Registry mirror: the plugin's pickable upstream objects, kept locally for pickers and `search`. */

export function applyRegistrySync(
  db: Db,
  instanceId: string,
  raw: unknown,
  now = new Date(),
): { upserted: number; staled: number } {
  const entries = z.array(RegistryEntrySchema).parse(raw);
  return db.transaction((tx) => {
    const existing = new Map(
      tx
        .select()
        .from(registryEntries)
        .where(eq(registryEntries.instanceId, instanceId))
        .all()
        .map((e) => [`${e.kind}\u0000${e.extId}`, e]),
    );
    const seen = new Set<string>();
    for (const e of entries) {
      const k = `${e.kind}\u0000${e.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const fields = {
        name: e.name,
        parentExtId: e.parentId ?? null,
        scopes: e.scopes ?? null,
        attrs: e.attrs ?? null,
        stale: false,
        lastSyncedAt: now,
      };
      const prev = existing.get(k);
      if (prev) tx.update(registryEntries).set(fields).where(eq(registryEntries.id, prev.id)).run();
      else
        tx.insert(registryEntries)
          .values({ id: randomUUID(), instanceId, kind: e.kind, extId: e.id, ...fields })
          .run();
    }
    let staled = 0;
    for (const [k, prev] of existing) {
      if (!seen.has(k) && !prev.stale) {
        tx.update(registryEntries).set({ stale: true }).where(eq(registryEntries.id, prev.id)).run();
        staled++;
      }
    }
    return { upserted: seen.size, staled };
  });
}

const SCOPE_KEY = /^[a-z][a-z0-9_-]*$/;

/** Reads `scope.<key>=value` query-string pairs (the admin API's form of `RegistryQuery.scopes`). */
export function scopesFromQuery(query: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query)
      .filter(([k]) => k.startsWith('scope.'))
      .map(([k, v]) => [k.slice('scope.'.length), v]),
  );
}

export interface RegistryQuery {
  kind?: string;
  text?: string;
  parent?: string;
  /** Entries whose scope values equal these (see the manifest's `targets.scopes`). */
  scopes?: Record<string, string>;
  limit?: number;
  offset?: number;
}

export function findRegistryEntries(db: DbLike, instanceId: string, q: RegistryQuery = {}) {
  const limit = Math.min(Math.max(1, Number(q.limit) || 50), 500);
  const conditions = [eq(registryEntries.instanceId, instanceId), eq(registryEntries.stale, false)];
  if (q.kind) conditions.push(eq(registryEntries.kind, q.kind));
  if (q.parent) conditions.push(eq(registryEntries.parentExtId, q.parent));
  for (const [key, value] of Object.entries(q.scopes ?? {})) {
    if (!SCOPE_KEY.test(key)) throw new ValidationError('invalid_scope', `"${key}" is not a scope key`);
    conditions.push(sql`json_extract(${registryEntries.scopes}, ${`$."${key}"`}) = ${String(value)}`);
  }
  if (q.text) {
    const pattern = `%${q.text.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conditions.push(
      or(
        sql`${registryEntries.name} LIKE ${pattern} ESCAPE '\\'`,
        sql`${registryEntries.extId} LIKE ${pattern} ESCAPE '\\'`,
      )!,
    );
  }
  return db
    .select({
      kind: registryEntries.kind,
      id: registryEntries.extId,
      name: registryEntries.name,
      parentId: registryEntries.parentExtId,
      scopes: registryEntries.scopes,
      attrs: registryEntries.attrs,
    })
    .from(registryEntries)
    .where(and(...conditions))
    .orderBy(asc(registryEntries.kind), asc(registryEntries.name))
    .limit(limit)
    .offset(Math.max(0, Number(q.offset) || 0))
    .all();
}
