import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { buildStats } from "./stats";
import type { TraceEvent } from "@projectos/telemetry";

const TMP = "/tmp/projectos-stats-test";

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    ts: "2024-01-01T00:00:00.000Z",
    runId: "run-1",
    phase: "architect",
    role: "assistant",
    model: "claude-sonnet-4-6",
    inputTokens: 1000,
    outputTokens: 500,
    durationMs: 100,
    ...overrides,
  };
}

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// buildStats — pure unit tests
// ---------------------------------------------------------------------------

describe("buildStats", () => {
  it("returns empty rows and zero totals for empty input", () => {
    const result = buildStats([]);
    expect(result.rows).toHaveLength(0);
    expect(result.total.calls).toBe(0);
    expect(result.total.inputTokens).toBe(0);
    expect(result.total.outputTokens).toBe(0);
    expect(result.total.cacheReadTokens).toBe(0);
    expect(result.total.cacheWriteTokens).toBe(0);
    expect(result.total.costUsd).toBe(0);
  });

  it("counts a single event correctly", () => {
    const events = [makeEvent({ model: "claude-sonnet-4-6", inputTokens: 1000, outputTokens: 500 })];
    const result = buildStats(events);

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.model).toBe("claude-sonnet-4-6");
    expect(row.calls).toBe(1);
    expect(row.inputTokens).toBe(1000);
    expect(row.outputTokens).toBe(500);
    expect(row.cacheReadTokens).toBe(0);
    expect(row.cacheWriteTokens).toBe(0);
    // $3/M input + $15/M output → (1000/1e6)*3 + (500/1e6)*15 = 0.003 + 0.0075 = 0.0105
    expect(row.costUsd).toBeCloseTo(0.0105, 6);
  });

  it("defaults missing cache tokens to 0", () => {
    const events = [makeEvent({ cacheReadTokens: undefined, cacheWriteTokens: undefined })];
    const result = buildStats(events);
    expect(result.rows[0].cacheReadTokens).toBe(0);
    expect(result.rows[0].cacheWriteTokens).toBe(0);
  });

  it("accumulates cache tokens when present", () => {
    const events = [
      makeEvent({ model: "claude-sonnet-4-6", inputTokens: 0, outputTokens: 0, cacheReadTokens: 2000, cacheWriteTokens: 1000 }),
    ];
    const result = buildStats(events);
    const row = result.rows[0];
    expect(row.cacheReadTokens).toBe(2000);
    expect(row.cacheWriteTokens).toBe(1000);
    // cache read: (2000/1e6)*3*0.1 = 0.0006
    // cache write: (1000/1e6)*3*1.25 = 0.00375
    expect(row.costUsd).toBeCloseTo(0.00435, 6);
  });

  it("aggregates multiple events for the same model", () => {
    const events = [
      makeEvent({ model: "claude-haiku-4-5", inputTokens: 500, outputTokens: 200 }),
      makeEvent({ model: "claude-haiku-4-5", inputTokens: 300, outputTokens: 100 }),
    ];
    const result = buildStats(events);

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.model).toBe("claude-haiku-4-5");
    expect(row.calls).toBe(2);
    expect(row.inputTokens).toBe(800);
    expect(row.outputTokens).toBe(300);
    // haiku: $1/M input, $5/M output → (800/1e6)*1 + (300/1e6)*5 = 0.0008 + 0.0015 = 0.0023
    expect(row.costUsd).toBeCloseTo(0.0023, 6);
  });

  it("builds rows for multiple models in insertion order", () => {
    const events = [
      makeEvent({ model: "claude-sonnet-4-6", inputTokens: 100, outputTokens: 50 }),
      makeEvent({ model: "claude-haiku-4-5", inputTokens: 200, outputTokens: 100 }),
      makeEvent({ model: "claude-sonnet-4-6", inputTokens: 300, outputTokens: 150 }),
    ];
    const result = buildStats(events);

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].model).toBe("claude-sonnet-4-6");
    expect(result.rows[1].model).toBe("claude-haiku-4-5");

    expect(result.rows[0].calls).toBe(2);
    expect(result.rows[1].calls).toBe(1);
  });

  it("total row sums all row values", () => {
    const events = [
      makeEvent({ model: "claude-sonnet-4-6", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 50 }),
      makeEvent({ model: "claude-haiku-4-5", inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 200, cacheWriteTokens: 100 }),
    ];
    const result = buildStats(events);

    expect(result.total.calls).toBe(2);
    expect(result.total.inputTokens).toBe(3000);
    expect(result.total.outputTokens).toBe(1500);
    expect(result.total.cacheReadTokens).toBe(300);
    expect(result.total.cacheWriteTokens).toBe(150);
    // total cost should equal sum of row costs
    const sumRowCosts = result.rows.reduce((s, r) => s + r.costUsd, 0);
    expect(result.total.costUsd).toBeCloseTo(sumRowCosts, 6);
  });

  it("uses computeCost for cost — unknown model yields $0 cost", () => {
    const events = [makeEvent({ model: "unknown-model-xyz", inputTokens: 999999, outputTokens: 999999 })];
    const result = buildStats(events);
    // computeCost uses { input: 0, output: 0 } for unknown models
    expect(result.rows[0].costUsd).toBe(0);
    expect(result.total.costUsd).toBe(0);
  });

  it("total.costUsd matches sum of all per-model costs (multi-model)", () => {
    const events = [
      makeEvent({ model: "claude-opus-4-8", inputTokens: 500, outputTokens: 250 }),
      makeEvent({ model: "claude-fable-5", inputTokens: 1000, outputTokens: 200 }),
      makeEvent({ model: "claude-haiku-4-5", inputTokens: 800, outputTokens: 400 }),
    ];
    const result = buildStats(events);
    const rowSum = result.rows.reduce((s, r) => s + r.costUsd, 0);
    expect(result.total.costUsd).toBeCloseTo(rowSum, 8);
    expect(result.total.calls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// JSONL fixture — test the tolerant reader via statsCommand action indirectly
// by calling buildStats with events parsed from a fixture file
// ---------------------------------------------------------------------------

describe("buildStats with fixture traces.jsonl", () => {
  it("reads and aggregates a multi-line JSONL fixture", () => {
    const fixture = [
      makeEvent({ model: "claude-sonnet-4-6", inputTokens: 1000, outputTokens: 400 }),
      makeEvent({ model: "claude-haiku-4-5", inputTokens: 500, outputTokens: 200 }),
      makeEvent({ model: "claude-sonnet-4-6", inputTokens: 800, outputTokens: 300, cacheReadTokens: 100 }),
      // malformed line (should be ignored)
    ];

    const tracesPath = join(TMP, "traces.jsonl");
    const lines = fixture.map((e) => JSON.stringify(e)).join("\n") + "\n{bad json\n";
    writeFileSync(tracesPath, lines, "utf8");

    // parse manually to mirror the tolerant reader
    const { readFileSync } = require("fs");
    const raw = readFileSync(tracesPath, "utf8") as string;
    const events: TraceEvent[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { events.push(JSON.parse(t) as TraceEvent); } catch { /* skip */ }
    }

    const result = buildStats(events);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].model).toBe("claude-sonnet-4-6");
    expect(result.rows[0].calls).toBe(2);
    expect(result.rows[0].inputTokens).toBe(1800);
    expect(result.rows[0].cacheReadTokens).toBe(100);
    expect(result.rows[1].model).toBe("claude-haiku-4-5");
    expect(result.rows[1].calls).toBe(1);
    expect(result.total.calls).toBe(3);
    expect(result.total.inputTokens).toBe(2300);
  });
});

// ---------------------------------------------------------------------------
// StatsResult shape
// ---------------------------------------------------------------------------

describe("StatsResult shape", () => {
  it("rows contain all required fields", () => {
    const events = [makeEvent({ model: "claude-haiku-4-5", inputTokens: 100, outputTokens: 50 })];
    const result = buildStats(events);
    const row = result.rows[0];
    expect(typeof row.model).toBe("string");
    expect(typeof row.calls).toBe("number");
    expect(typeof row.inputTokens).toBe("number");
    expect(typeof row.outputTokens).toBe("number");
    expect(typeof row.cacheReadTokens).toBe("number");
    expect(typeof row.cacheWriteTokens).toBe("number");
    expect(typeof row.costUsd).toBe("number");
  });

  it("total does not have a model field", () => {
    const result = buildStats([makeEvent()]);
    expect("model" in result.total).toBe(false);
  });
});
