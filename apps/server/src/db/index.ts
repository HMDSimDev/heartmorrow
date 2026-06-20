import { config, ensureDirectories } from '../config';
import { openDatabase, type Db, type Row } from './sqlite';
import { SCHEMA_SQL, COLUMN_MIGRATIONS } from './schema';

/** Apply additive column migrations only when the column is missing. */
function applyColumnMigrations(db: Db): void {
  for (const m of COLUMN_MIGRATIONS) {
    const cols = db.all<Row>(`PRAGMA table_info(${m.table})`);
    const exists = cols.some((c) => String(c.name) === m.column);
    if (!exists) db.exec(m.ddl);
  }
}

/**
 * Database singleton management. The app uses a single shared connection.
 * Tests can call `initDatabase({ memory: true })` to get an isolated
 * in-memory database with the full schema applied.
 */

let current: Db | null = null;

export interface InitDatabaseOptions {
  /** Use an in-memory database (for tests). */
  memory?: boolean;
  /** Override the file path. */
  path?: string;
}

export function initDatabase(options: InitDatabaseOptions = {}): Db {
  if (current) {
    current.close();
    current = null;
  }
  if (!options.memory) {
    ensureDirectories();
  }
  const path = options.memory ? ':memory:' : options.path ?? config.dbPath;
  const db = openDatabase(path);
  db.exec(SCHEMA_SQL);
  applyColumnMigrations(db);
  current = db;
  return db;
}

export function getDb(): Db {
  if (!current) {
    return initDatabase();
  }
  return current;
}

export function closeDatabase(): void {
  if (current) {
    current.close();
    current = null;
  }
}

export type { Db } from './sqlite';
