import { describe, expect, it } from "bun:test";
import { buildStatsOutput, renderStatsTable, summarizeRuns } from "./stats";
import type { TraceEvent } from "@projectos/telemetry";

describe("stats command summary", () => {
  it("renders a simple table from stubbed runs DB data", () => {
    const output = buildStatsOutput(".projectos/runs.db", {
      readRuns: (dbPath) => {
        expect(dbPath).toBe(".projectos/runs.db");
        return [
          {
            runId: "run-1",
            status: "complete",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:10.000Z",
          },
          {
            runId: "run-2",
            status: "failed",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:20.000Z",
          },
        ];
      },
      readTraceEvents: (tracePath) => {
        expect(tracePath).toBe(".projectos/traces.jsonl");
        return [
          traceEvent({ runId: "run-1", inputTokens: 1000, outputTokens: 500 }),
          traceEvent({ runId: "run-2", inputTokens: 500, outputTokens: 100 }),
          traceEvent({ runId: "ignored-run", inputTokens: 999999, outputTokens: 999999 }),
        ];
      },
    });

    expect(output).toBe([
      "Metric                Value  ",
      "--------------------  -------",
      "Total runs            2      ",
      "Completed             1      ",
      "Escalated             1      ",
      "Average duration (s)  15.00  ",
      "Total cost (USD)      $0.0135",
    ].join("\n"));
  });

  it("summarizes empty input as zero values", () => {
    expect(renderStatsTable(summarizeRuns([], []))).toContain("Total runs            0");
    expect(renderStatsTable(summarizeRuns([], []))).toContain("Total cost (USD)      $0.0000");
  });
});

function traceEvent(overrides: Partial<TraceEvent>): TraceEvent {
  return {
    ts: "2024-01-01T00:00:00.000Z",
    runId: "run-1",
    phase: "SESSION",
    role: "core",
    model: "claude-sonnet-4-6",
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 100,
    ...overrides,
  };
}
