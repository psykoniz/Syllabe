import { Command } from "commander";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { computeCost } from "@projectos/telemetry";
import type { TokenUsage, TraceEvent } from "@projectos/telemetry";

export interface RunStatsRecord {
  runId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  durationMs?: number | null;
  costUsd?: number | null;
}

export interface RunStatsSummary {
  totalRuns: number;
  completedRuns: number;
  escalatedRuns: number;
  averageDurationSeconds: number;
  totalCostUsd: number;
}

export interface StatsReaders {
  readRuns: (dbPath: string) => RunStatsRecord[];
  readTraceEvents?: (tracePath: string) => TraceEvent[];
}

type StatsTableRow = [metric: string, value: string];

function tableExists(db: Database, tableName: string): boolean {
  const row = db.query<{ name: string }, [string]>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName);
  return row !== null;
}

function tableColumns(db: Database, tableName: string): Set<string> {
  return new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${tableName})`).all().map((column) => column.name));
}

function numericMetaExpression(columns: Set<string>, key: string): string {
  if (!columns.has(key)) return "NULL";
  return `CAST(${key}.value AS REAL)`;
}

export function readRuns(dbPath: string): RunStatsRecord[] {
  if (!existsSync(dbPath)) return [];

  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    const runColumns = tableColumns(db, "runs");
    const durationSelect = runColumns.has("duration_ms") ? "duration_ms as durationMs" : "NULL as durationMs";
    const costSelect = runColumns.has("cost_usd") ? "cost_usd as costUsd" : "NULL as costUsd";

    if (!tableExists(db, "run_meta")) {
      return db
        .query<RunStatsRecord, []>(
          `SELECT run_id as runId, status, created_at as createdAt, updated_at as updatedAt,
                  ${durationSelect}, ${costSelect}
           FROM runs ORDER BY created_at ASC`
        )
        .all();
    }

    const metaColumns = new Set(
      db.query<{ key: string }, []>(`SELECT DISTINCT key FROM run_meta WHERE key IN ('durationMs', 'duration_ms', 'costUsd', 'cost_usd')`)
        .all()
        .map((row) => row.key)
    );
    const durationMetaSelect = runColumns.has("duration_ms")
      ? "duration_ms as durationMs"
      : `COALESCE(${numericMetaExpression(metaColumns, "durationMs")}, ${numericMetaExpression(metaColumns, "duration_ms")}) as durationMs`;
    const costMetaSelect = runColumns.has("cost_usd")
      ? "cost_usd as costUsd"
      : `COALESCE(${numericMetaExpression(metaColumns, "costUsd")}, ${numericMetaExpression(metaColumns, "cost_usd")}) as costUsd`;

    return db
      .query<RunStatsRecord, []>(
        `SELECT runs.run_id as runId, runs.status, runs.created_at as createdAt, runs.updated_at as updatedAt,
                ${durationMetaSelect}, ${costMetaSelect}
         FROM runs
         LEFT JOIN run_meta durationMs ON durationMs.run_id = runs.run_id AND durationMs.key = 'durationMs'
         LEFT JOIN run_meta duration_ms ON duration_ms.run_id = runs.run_id AND duration_ms.key = 'duration_ms'
         LEFT JOIN run_meta costUsd ON costUsd.run_id = runs.run_id AND costUsd.key = 'costUsd'
         LEFT JOIN run_meta cost_usd ON cost_usd.run_id = runs.run_id AND cost_usd.key = 'cost_usd'
         ORDER BY runs.created_at ASC`
      )
      .all();
  } finally {
    db.close();
  }
}

export function readTraceEvents(tracePath: string): TraceEvent[] {
  if (!existsSync(tracePath)) return [];

  const events: TraceEvent[] = [];
  for (const line of readFileSync(tracePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      events.push(JSON.parse(trimmed) as TraceEvent);
    } catch {
      // Ignore malformed trace lines so one bad write does not break stats.
    }
  }
  return events;
}

function traceCostForRuns(runs: RunStatsRecord[], traceEvents: TraceEvent[]): number {
  const runIds = new Set(runs.map((run) => run.runId));
  const usage: TokenUsage[] = traceEvents
    .filter((event) => runIds.has(event.runId))
    .map((event) => ({
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens ?? 0,
      cacheWriteTokens: event.cacheWriteTokens ?? 0,
    }));

  return computeCost(usage).totalUsd;
}

function durationMsForRun(run: RunStatsRecord): number | null {
  if (typeof run.durationMs === "number" && Number.isFinite(run.durationMs) && run.durationMs >= 0) return run.durationMs;

  const createdAt = Date.parse(run.createdAt);
  const updatedAt = Date.parse(run.updatedAt);
  if (Number.isNaN(createdAt) || Number.isNaN(updatedAt) || updatedAt < createdAt) return null;
  return updatedAt - createdAt;
}

function isCompletedStatus(status: string): boolean {
  return status === "complete" || status === "completed";
}

function isEscalatedStatus(status: string): boolean {
  return status === "escalated" || status === "failed";
}

export function summarizeRuns(runs: RunStatsRecord[], traceEvents: TraceEvent[] = []): RunStatsSummary {
  const durations = runs.map(durationMsForRun).filter((duration): duration is number => duration !== null);
  const totalDurationMs = durations.reduce((sum, duration) => sum + duration, 0);
  const dbCostUsd = runs.reduce((sum, run) => {
    if (typeof run.costUsd !== "number" || !Number.isFinite(run.costUsd)) return sum;
    return sum + run.costUsd;
  }, 0);
  const hasDbCost = runs.some((run) => typeof run.costUsd === "number" && Number.isFinite(run.costUsd));

  return {
    totalRuns: runs.length,
    completedRuns: runs.filter((run) => isCompletedStatus(run.status)).length,
    escalatedRuns: runs.filter((run) => isEscalatedStatus(run.status)).length,
    averageDurationSeconds: durations.length === 0 ? 0 : totalDurationMs / durations.length / 1000,
    totalCostUsd: hasDbCost ? dbCostUsd : traceCostForRuns(runs, traceEvents),
  };
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function formatStatsTableRows(rows: StatsTableRow[]): string {
  const metricWidth = Math.max(...rows.map(([metric]) => metric.length));
  const valueWidth = Math.max(...rows.map(([, value]) => value.length));
  const separator = `${"-".repeat(metricWidth)}  ${"-".repeat(valueWidth)}`;

  return rows
    .map(([metric, value], index) => {
      const line = `${pad(metric, metricWidth)}  ${pad(value, valueWidth)}`;
      return index === 0 ? `${line}\n${separator}` : line;
    })
    .join("\n");
}

export function renderStatsTable(summary: RunStatsSummary): string {
  const rows: StatsTableRow[] = [
    ["Metric", "Value"],
    ["Total runs", String(summary.totalRuns)],
    ["Completed", String(summary.completedRuns)],
    ["Escalated", String(summary.escalatedRuns)],
    ["Average duration (s)", summary.averageDurationSeconds.toFixed(2)],
    ["Total cost (USD)", `$${summary.totalCostUsd.toFixed(4)}`],
  ];

  return formatStatsTableRows(rows);
}

export function buildStatsOutput(dbPath: string, readers: StatsReaders = { readRuns, readTraceEvents }): string {
  const runs = readers.readRuns(dbPath);
  const traceEvents = readers.readTraceEvents?.(join(dirname(dbPath), "traces.jsonl")) ?? [];
  return renderStatsTable(summarizeRuns(runs, traceEvents));
}

export const statsCommand = new Command("stats")
  .description("Print a summary table for ProjectOS runs")
  .option("--db <path>", "SQLite database path", ".projectos/runs.db")
  .action((opts: { db: string }) => {
    console.log(buildStatsOutput(opts.db));
  });
