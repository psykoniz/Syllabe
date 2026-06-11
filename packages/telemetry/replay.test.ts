import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { replayRun, listRunIds } from "./replay";

let dir: string;
let tracePath: string;
let toolCallsPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "replay-test-"));
  tracePath = join(dir, "traces.jsonl");
  toolCallsPath = join(dir, "tool-calls.jsonl");

  const traces = [
    { ts: "2026-06-11T10:00:00.000Z", runId: "run-a", phase: "INTAKE", role: "product-strategist", model: "claude-sonnet-4-6", inputTokens: 1000, outputTokens: 200, durationMs: 2000 },
    { ts: "2026-06-11T10:00:10.000Z", runId: "run-a", phase: "DESIGN", role: "architect", model: "claude-sonnet-4-6", inputTokens: 2000, outputTokens: 500, durationMs: 5000 },
    { ts: "2026-06-11T10:00:30.000Z", runId: "run-a", phase: "IMPLEMENT", role: "implementer", model: "claude-sonnet-4-6", inputTokens: 3000, outputTokens: 800, durationMs: 8000, meta: { escalationReason: "max review cycles (2) exceeded" } },
    { ts: "2026-06-11T11:00:00.000Z", runId: "run-b", phase: "INTAKE", role: "product-strategist", model: "claude-haiku-4-5", inputTokens: 500, outputTokens: 100, durationMs: 1000 },
  ];
  writeFileSync(tracePath, traces.map((t) => JSON.stringify(t)).join("\n") + "\n");

  const toolCalls = [
    { ts: "2026-06-11T10:00:15.000Z", tool: "bash", args: { command: "bun test" }, result: "ok", durationMs: 1200 },
    { ts: "2026-06-11T10:59:00.000Z", tool: "write_file", args: { path: "x.ts" }, result: "ok", durationMs: 5 },
  ];
  writeFileSync(toolCallsPath, toolCalls.map((t) => JSON.stringify(t)).join("\n") + "\n");
});

describe("listRunIds", () => {
  it("returns distinct run IDs, most recent first", () => {
    expect(listRunIds(tracePath)).toEqual(["run-b", "run-a"]);
  });

  it("returns empty array for missing file", () => {
    expect(listRunIds(join(dir, "nope.jsonl"))).toEqual([]);
  });
});

describe("replayRun", () => {
  it("returns null for unknown run", () => {
    expect(replayRun(tracePath, "run-zzz")).toBeNull();
  });

  it("reconstructs phases in order without duplicates", () => {
    const session = replayRun(tracePath, "run-a")!;
    expect(session.phases).toEqual(["INTAKE", "DESIGN", "IMPLEMENT"]);
  });

  it("computes cost from trace token usage", () => {
    const session = replayRun(tracePath, "run-a")!;
    // 6000 in + 1500 out at sonnet pricing ($3/$15 per 1M)
    expect(session.cost.totalUsd).toBeCloseTo(6000 / 1e6 * 3 + 1500 / 1e6 * 15, 6);
  });

  it("merges tool calls within the run time window, sorted by ts", () => {
    const session = replayRun(tracePath, "run-a", toolCallsPath)!;
    const toolSteps = session.steps.filter((s) => s.kind === "tool");
    expect(toolSteps).toHaveLength(1); // 10:59 tool call is outside run-a window
    expect(toolSteps[0].label).toBe("bash");
    const labels = session.steps.map((s) => s.label);
    expect(labels).toEqual(["INTAKE", "DESIGN", "bash", "IMPLEMENT"]);
  });

  it("surfaces escalation reasons in step detail", () => {
    const session = replayRun(tracePath, "run-a")!;
    const impl = session.steps.find((s) => s.label === "IMPLEMENT")!;
    expect(impl.detail).toContain("escalation: max review cycles (2) exceeded");
  });

  it("isolates runs — run-b only sees its own events", () => {
    const session = replayRun(tracePath, "run-b", toolCallsPath)!;
    expect(session.phases).toEqual(["INTAKE"]);
    // the 10:59 tool call falls before run-b's window (starts 11:00)
    expect(session.steps.filter((s) => s.kind === "tool")).toHaveLength(0);
  });
});
