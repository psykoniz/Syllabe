import { Command } from "commander";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { computeCost } from "@projectos/telemetry";

export interface RunStatsSummary {
  totalRuns: number;
  completedRuns: number;
  escalatedRuns: number;
  averageDurationSeconds: number;
  totalCostUsd: number;
}

function loadStats(dbPath: string, tracesPath: string): RunStatsSummary {
  // synchronous — no await needed
  if (!existsSync(dbPath)) {
    return { totalRuns: 0, completedRuns: 0, escalatedRuns: 0, averageDurationSeconds: 0, totalCostUsd: 0 };
  }

  const db = new Database(dbPath, { readonly: true });

  // Final state per run from checkpoints
  const finalStates = db.query<{ run_id: string; state: string }, []>(
    `SELECT run_id, state FROM checkpoints
     WHERE seq = (SELECT MAX(seq) FROM checkpoints c2 WHERE c2.run_id = checkpoints.run_id)`
  ).all();

  // startedAt per run from run_meta
  const startedRows = db.query<{ run_id: string; value: string }, []>(
    `SELECT run_id, value FROM run_meta WHERE key = 'startedAt'`
  ).all();
  const startedAt = new Map(startedRows.map(r => [r.run_id, r.value]));

  // Last checkpoint ts per run (as end time)
  const endRows = db.query<{ run_id: string; ts: string }, []>(
    `SELECT run_id, ts FROM checkpoints
     WHERE seq = (SELECT MAX(seq) FROM checkpoints c2 WHERE c2.run_id = checkpoints.run_id)`
  ).all();
  const endedAt = new Map(endRows.map(r => [r.run_id, r.ts]));

  const totalRuns = finalStates.length;
  const completedRuns = finalStates.filter(r => r.state === "COMPLETE").length;
  const escalatedRuns = finalStates.filter(r => r.state === "ESCALATED").length;

  // Duration from start/end timestamps
  const durations: number[] = [];
  for (const { run_id } of finalStates) {
    const start = startedAt.get(run_id);
    const end = endedAt.get(run_id);
    if (start && end) {
      const ms = new Date(end).getTime() - new Date(start).getTime();
      if (ms > 0) durations.push(ms);
    }
  }
  const averageDurationSeconds = durations.length
    ? durations.reduce((a, b) => a + b, 0) / durations.length / 1000
    : 0;

  // Cost from traces.jsonl
  let totalCostUsd = 0;
  if (existsSync(tracesPath)) {
    const runIds = new Set(finalStates.map(r => r.run_id));
    for (const line of readFileSync(tracesPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line);
        if (!runIds.has(t.runId)) continue;
        const usage = { model: t.model ?? "", inputTokens: t.inputTokens ?? 0, outputTokens: t.outputTokens ?? 0 };
        totalCostUsd += computeCost([usage]).totalUsd;
      } catch { /* skip malformed */ }
    }
  }

  db.close();
  return { totalRuns, completedRuns, escalatedRuns, averageDurationSeconds, totalCostUsd };
}

function formatTable(summary: RunStatsSummary): string {
  const rows: [string, string][] = [
    ["Total runs",           String(summary.totalRuns)],
    ["Completed",            String(summary.completedRuns)],
    ["Escalated",            String(summary.escalatedRuns)],
    ["Avg duration (s)",     summary.averageDurationSeconds.toFixed(1)],
    ["Total cost (USD)",     `$${summary.totalCostUsd.toFixed(4)}`],
  ];
  const colW = Math.max(...rows.map(r => r[0].length));
  const valW = Math.max(...rows.map(r => r[1].length));
  const sep = `${"─".repeat(colW + 2)}┼${"─".repeat(valW + 2)}`;
  return [
    `${"Metric".padEnd(colW + 2)}│ Value`,
    sep,
    ...rows.map(([k, v]) => `${k.padEnd(colW + 2)}│ ${v}`),
  ].join("\n");
}

export const statsCommand = new Command("stats")
  .description("Print a summary table for ProjectOS runs")
  .option("--db <path>", "SQLite database path", ".projectos/runs.db")
  .option("--traces <path>", "Traces JSONL path", ".projectos/traces.jsonl")
  .action((opts) => {
    const summary = loadStats(opts.db, opts.traces);
    console.log(formatTable(summary));
  });
