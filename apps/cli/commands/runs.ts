import { Command } from "commander";
import { Database } from "bun:sqlite";
import { existsSync } from "fs";

export interface RunListRow {
  runId: string;
  state: string;
  durationSeconds: number | null;
  model: string;
  task: string;
}

interface RunMetaRow {
  runId: string;
  startedAt: string | null;
  model: string | null;
  task: string | null;
  latestState: string | null;
  latestTs: string | null;
}

const DEFAULT_DB_PATH = ".projectos/runs.db";
const RECENT_RUN_LIMIT = 10;
const TASK_PREVIEW_LENGTH = 50;

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .query<{ name: string }, string>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
  return row !== null;
}

function getTableColumns(db: Database, tableName: string): Set<string> {
  return new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${tableName})`)
      .all()
      .map((column) => column.name)
  );
}

function hasColumns(columns: Set<string>, requiredColumns: string[]): boolean {
  return requiredColumns.every((column) => columns.has(column));
}

function latestCheckpointJoin(hasCheckpoints: boolean): string {
  if (!hasCheckpoints) {
    return `LEFT JOIN (SELECT NULL AS run_id, NULL AS state, NULL AS ts WHERE 0) latest ON latest.run_id = rm.run_id`;
  }

  return `LEFT JOIN (
         SELECT c.run_id, c.state, c.ts
         FROM checkpoints c
         INNER JOIN (
           SELECT run_id, MAX(seq) AS seq
           FROM checkpoints
           GROUP BY run_id
         ) final ON final.run_id = c.run_id AND final.seq = c.seq
       ) latest ON latest.run_id = rm.run_id`;
}

function loadKeyValueRunRows(db: Database, hasCheckpoints: boolean): RunMetaRow[] {
  return db
    .query<RunMetaRow, [number]>(
      `SELECT
         rm.run_id AS runId,
         MAX(CASE WHEN rm.key = 'startedAt' THEN rm.value END) AS startedAt,
         MAX(CASE WHEN rm.key = 'model' THEN rm.value END) AS model,
         MAX(CASE WHEN rm.key = 'task' THEN rm.value END) AS task,
         latest.state AS latestState,
         latest.ts AS latestTs
       FROM run_meta rm
       ${latestCheckpointJoin(hasCheckpoints)}
       GROUP BY rm.run_id
       ORDER BY COALESCE(startedAt, latestTs, '') DESC, rm.run_id DESC
       LIMIT ?`
    )
    .all(RECENT_RUN_LIMIT);
}

function loadColumnRunRows(db: Database, hasCheckpoints: boolean): RunMetaRow[] {
  return db
    .query<RunMetaRow, [number]>(
      `SELECT
         rm.run_id AS runId,
         rm.startedAt AS startedAt,
         rm.model AS model,
         rm.task AS task,
         latest.state AS latestState,
         latest.ts AS latestTs
       FROM run_meta rm
       ${latestCheckpointJoin(hasCheckpoints)}
       ORDER BY COALESCE(rm.startedAt, latest.ts, '') DESC, rm.run_id DESC
       LIMIT ?`
    )
    .all(RECENT_RUN_LIMIT);
}

export function loadRecentRuns(db: Database): RunListRow[] {
  if (!tableExists(db, "run_meta")) return [];

  const runMetaColumns = getTableColumns(db, "run_meta");
  if (!runMetaColumns.has("run_id")) return [];

  const checkpointColumns = tableExists(db, "checkpoints") ? getTableColumns(db, "checkpoints") : new Set<string>();
  const hasCheckpoints = hasColumns(checkpointColumns, ["run_id", "seq", "state", "ts"]);
  const hasKeyValueRunMeta = hasColumns(runMetaColumns, ["key", "value"]);
  const hasColumnRunMeta = hasColumns(runMetaColumns, ["startedAt", "model", "task"]);

  if (!hasKeyValueRunMeta && !hasColumnRunMeta) return [];

  const rows = hasKeyValueRunMeta ? loadKeyValueRunRows(db, hasCheckpoints) : loadColumnRunRows(db, hasCheckpoints);

  return rows.map((row) => ({
    runId: row.runId,
    state: row.latestState ?? "unknown",
    durationSeconds: computeDurationSeconds(row.startedAt, row.latestTs),
    model: row.model ?? "",
    task: row.task ?? "",
  }));
}

export function computeDurationSeconds(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null;

  const startedMs = Date.parse(startedAt);
  const endedMs = Date.parse(endedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) return null;

  return Math.max(0, Math.floor((endedMs - startedMs) / 1000));
}

function previewTask(task: string): string {
  const compact = task.replace(/\s+/g, " ").trim();
  return compact.length > TASK_PREVIEW_LENGTH ? compact.slice(0, TASK_PREVIEW_LENGTH) : compact;
}

export function renderRunsTable(rows: RunListRow[]): string {
  const lines = ["ID | State | Duration(s) | Model | Task"];

  for (const row of rows) {
    lines.push(
      [
        row.runId.slice(0, 8),
        row.state,
        row.durationSeconds === null ? "" : String(row.durationSeconds),
        row.model,
        previewTask(row.task),
      ].join(" | ")
    );
  }

  return lines.join("\n");
}

export function listRuns(dbPath = DEFAULT_DB_PATH): string {
  if (!existsSync(dbPath)) return renderRunsTable([]);

  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    return renderRunsTable(loadRecentRuns(db));
  } finally {
    db.close();
  }
}

export const runsCommand = new Command("runs")
  .description("List the 10 most recent ProjectOS runs")
  .option("--db <path>", "SQLite database path", DEFAULT_DB_PATH)
  .action((opts: { db: string }) => {
    console.log(listRuns(opts.db));
  });
