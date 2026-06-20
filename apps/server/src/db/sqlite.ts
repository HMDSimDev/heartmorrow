import { createRequire } from 'node:module';

/**
 * Thin, typed wrapper around Node's built-in `node:sqlite` module.
 *
 * Using `node:sqlite` means ZERO native dependencies — `pnpm install` never
 * has to compile a C addon, which keeps local setup painless across platforms.
 *
 * We import via `createRequire` and cast to our own minimal interface so the
 * build does not depend on whether the installed @types/node version ships
 * `node:sqlite` typings yet.
 */

export type SqlParam = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;

interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

interface StatementSync {
  run(...params: SqlParam[]): RunResult;
  get(...params: SqlParam[]): Row | undefined;
  all(...params: SqlParam[]): Row[];
}

interface DatabaseSyncInstance {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  close(): void;
}

interface DatabaseSyncCtor {
  new (path: string, options?: { open?: boolean; readOnly?: boolean }): DatabaseSyncInstance;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };

export interface Db {
  exec(sql: string): void;
  run(sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number };
  get<T = Row>(sql: string, ...params: SqlParam[]): T | undefined;
  all<T = Row>(sql: string, ...params: SqlParam[]): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
  readonly raw: DatabaseSyncInstance;
}

function toNumber(v: number | bigint): number {
  return typeof v === 'bigint' ? Number(v) : v;
}

/** Open a SQLite database and return the typed wrapper. */
export function openDatabase(filePath: string): Db {
  const raw = new DatabaseSync(filePath);
  // Pragmas: WAL for concurrency + durability, foreign keys enforced.
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec('PRAGMA busy_timeout = 5000;');

  let depth = 0;

  const db: Db = {
    raw,
    exec(sql) {
      raw.exec(sql);
    },
    run(sql, ...params) {
      const r = raw.prepare(sql).run(...params);
      return { changes: toNumber(r.changes), lastInsertRowid: toNumber(r.lastInsertRowid) };
    },
    get<T = Row>(sql: string, ...params: SqlParam[]) {
      return raw.prepare(sql).get(...params) as T | undefined;
    },
    all<T = Row>(sql: string, ...params: SqlParam[]) {
      return raw.prepare(sql).all(...params) as T[];
    },
    transaction<T>(fn: () => T): T {
      // Nested transactions use SAVEPOINTs so services can compose safely.
      if (depth === 0) {
        raw.exec('BEGIN');
      } else {
        raw.exec(`SAVEPOINT sp_${depth}`);
      }
      depth += 1;
      try {
        const result = fn();
        depth -= 1;
        if (depth === 0) {
          raw.exec('COMMIT');
        } else {
          raw.exec(`RELEASE sp_${depth}`);
        }
        return result;
      } catch (err) {
        depth -= 1;
        if (depth === 0) {
          raw.exec('ROLLBACK');
        } else {
          raw.exec(`ROLLBACK TO sp_${depth}`);
          raw.exec(`RELEASE sp_${depth}`);
        }
        throw err;
      }
    },
    close() {
      raw.close();
    },
  };

  return db;
}
