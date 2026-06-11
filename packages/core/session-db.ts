import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

export function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.run(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id     TEXT PRIMARY KEY,
      model      TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'running',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return db;
}

/** Lightweight key-value metadata per run (task description, model used, etc.) */
export function ensureRunMetaTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS run_meta (
      run_id TEXT NOT NULL,
      key    TEXT NOT NULL,
      value  TEXT NOT NULL,
      PRIMARY KEY (run_id, key)
    )
  `);
}

export function setRunMeta(db: Database, runId: string, key: string, value: string): void {
  db.run(`INSERT OR REPLACE INTO run_meta (run_id, key, value) VALUES (?, ?, ?)`, [runId, key, value]);
}
