import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };
/** A transaction handle; services accept either so callers can compose them in one transaction. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbLike = Db | Tx;

// src/db or dist/db → packages/core/drizzle
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

const DB_FILENAME = 'synoikia.sqlite';

/** Opens the SQLite database and applies pending migrations (design §7); `':memory:'` for tests. */
export function openDatabase(location: { dataDir: string } | ':memory:'): Db {
  let file = ':memory:';
  if (location !== ':memory:') {
    mkdirSync(location.dataDir, { recursive: true });
    file = path.join(location.dataDir, DB_FILENAME);
  }
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}
