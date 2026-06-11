import { Command } from "commander";
import { readFileSync, existsSync } from "fs";
import { computeCost } from "@projectos/telemetry";
import type { TraceEvent, TokenUsage } from "@projectos/telemetry";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface StatsRow {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface StatsResult {
  rows: StatsRow[];
  total: Omit<StatsRow, "model">;
}

// ---------------------------------------------------------------------------
// Aggregation (pure, exported for tests)
// ---------------------------------------------------------------------------

export function buildStats(events: TraceEvent[]): StatsResult {
  // Count calls per model in insertion order
  const callsPerModel = new Map<string, number>();
  for (const e of events) {
    callsPerModel.set(e.model, (callsPerModel.get(e.model) ?? 0) + 1);
  }

  // Map events to TokenUsage, defaulting cache fields to 0
  const usage: TokenUsage[] = events.map((e) => ({
    model: e.model,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    cacheReadTokens: e.cacheReadTokens ?? 0,
    cacheWriteTokens: e.cacheWriteTokens ?? 0,
  }));

  // Delegate all cost computation to @projectos/telemetry
  const { totalUsd, byModel } = computeCost(usage);

  // Build rows in insertion order (first sighting of each model)
  const rows: StatsRow[] = [];
  for (const [model, calls] of callsPerModel) {
    const m = byModel[model];
    rows.push({
      model,
      calls,
      inputTokens: m?.inputTokens ?? 0,
      outputTokens: m?.outputTokens ?? 0,
      cacheReadTokens: m?.cacheReadTokens ?? 0,
      cacheWriteTokens: m?.cacheWriteTokens ?? 0,
      costUsd: m?.usd ?? 0,
    });
  }

  // Summing total row
  const total: Omit<StatsRow, "model"> = {
    calls: rows.reduce((s, r) => s + r.calls, 0),
    inputTokens: rows.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: rows.reduce((s, r) => s + r.outputTokens, 0),
    cacheReadTokens: rows.reduce((s, r) => s + r.cacheReadTokens, 0),
    cacheWriteTokens: rows.reduce((s, r) => s + r.cacheWriteTokens, 0),
    costUsd: totalUsd,
  };

  return { rows, total };
}

// ---------------------------------------------------------------------------
// Tolerant JSONL reader (same pattern as report.ts / replay.ts)
// ---------------------------------------------------------------------------

function readTraceEvents(filePath: string): TraceEvent[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  const events: TraceEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as TraceEvent);
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const COL = {
  model: 24,
  calls: 7,
  input: 8,
  output: 8,
  cacheR: 8,
  cacheW: 8,
  cost: 12,
};

const SEPARATOR = "─".repeat(
  COL.model + COL.calls + COL.input + COL.output + COL.cacheR + COL.cacheW + COL.cost + 6
);

function pad(s: string | number, width: number, right = true): string {
  const str = String(s);
  return right ? str.padStart(width) : str.padEnd(width);
}

function renderTable(result: StatsResult): string {
  const header =
    pad("Model", COL.model, false) +
    pad("Calls", COL.calls) +
    pad("Input", COL.input) +
    pad("Output", COL.output) +
    pad("CacheR", COL.cacheR) +
    pad("CacheW", COL.cacheW) +
    pad("Cost USD", COL.cost);

  const lines: string[] = [header, SEPARATOR];

  for (const row of result.rows) {
    lines.push(
      pad(row.model, COL.model, false) +
        pad(row.calls, COL.calls) +
        pad(row.inputTokens, COL.input) +
        pad(row.outputTokens, COL.output) +
        pad(row.cacheReadTokens, COL.cacheR) +
        pad(row.cacheWriteTokens, COL.cacheW) +
        pad(`$${row.costUsd.toFixed(4)}`, COL.cost)
    );
  }

  const t = result.total;
  lines.push(SEPARATOR);
  lines.push(
    pad("TOTAL", COL.model, false) +
      pad(t.calls, COL.calls) +
      pad(t.inputTokens, COL.input) +
      pad(t.outputTokens, COL.output) +
      pad(t.cacheReadTokens, COL.cacheR) +
      pad(t.cacheWriteTokens, COL.cacheW) +
      pad(`$${t.costUsd.toFixed(4)}`, COL.cost)
  );

  return lines.join("\n");
}

function renderJson(result: StatsResult): string {
  return JSON.stringify(
    {
      byModel: result.rows,
      total: result.total,
    },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// Commander command
// ---------------------------------------------------------------------------

export const statsCommand = new Command("stats")
  .description("Print a per-model cost table from a traces.jsonl file")
  .option("--traces <path>", "JSONL trace log path", ".projectos/traces.jsonl")
  .option("--json", "Output as JSON instead of a text table")
  .action((opts: { traces: string; json?: boolean }) => {
    const events = readTraceEvents(opts.traces);

    if (events.length === 0) {
      console.log(`No trace events found in ${opts.traces}`);
      return;
    }

    const result = buildStats(events);

    if (opts.json) {
      console.log(renderJson(result));
    } else {
      console.log(renderTable(result));
    }
  });
