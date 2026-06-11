import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunReplay } from "./src/replay";

function makeTmpPath(): string {
  return join(tmpdir(), `replay-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

function writeTraces(path: string, lines: object[]): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

const RUN_A = "run-aaa";
const RUN_B = "run-bbb";

const TRACES = [
  {
    ts: "2024-01-01T00:00:00.000Z",
    runId: RUN_A,
    phase: "INTAKE",
    role: "implementer",
    model: "claude-sonnet-4-6",
    inputTokens: 1000,
    outputTokens: 500,
    durationMs: 1000,
  },
  {
    ts: "2024-01-01T00:00:01.000Z",
    runId: RUN_B,
    phase: "INTAKE",
    role: "implementer",
    model: "claude-haiku-4-5",
    inputTokens: 200,
    outputTokens: 100,
    durationMs: 200,
  },
  {
    ts: "2024-01-01T00:00:02.000Z",
    runId: RUN_A,
    phase: "IMPLEMENT",
    role: "implementer",
    model: "claude-sonnet-4-6",
    inputTokens: 2000,
    outputTokens: 1000,
    durationMs: 2000,
  },
  {
    ts: "2024-01-01T00:00:03.000Z",
    runId: RUN_A,
    phase: "REVIEW",
    role: "reviewer",
    model: "claude-opus-4-8",
    inputTokens: 500,
    outputTokens: 200,
    durationMs: 500,
  },
];

describe("RunReplay", () => {
  let tmpPath: string;
  let replay: RunReplay;

  beforeEach(() => {
    tmpPath = makeTmpPath();
    writeTraces(tmpPath, TRACES);
    replay = new RunReplay(tmpPath);
  });

  afterEach(() => {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  });

  it("filters events by runId", () => {
    const events = replay.events(RUN_A);
    expect(events.length).toBe(3);
    expect(events.every((e) => e.phase !== undefined)).toBe(true);
    // all from RUN_A
    expect(events[0].phase).toBe("INTAKE");
    expect(events[1].phase).toBe("IMPLEMENT");
    expect(events[2].phase).toBe("REVIEW");
  });

  it("does not include other run events", () => {
    const eventsA = replay.events(RUN_A);
    const eventsB = replay.events(RUN_B);
    expect(eventsA.length).toBe(3);
    expect(eventsB.length).toBe(1);
    expect(eventsB[0].model).toBe("claude-haiku-4-5");
  });

  it("computes cumulative tokens correctly", () => {
    const events = replay.events(RUN_A);
    // index 0: 1000 input, 500 output
    expect(events[0].cumulativeInputTokens).toBe(1000);
    expect(events[0].cumulativeOutputTokens).toBe(500);
    // index 1: +2000 input, +1000 output
    expect(events[1].cumulativeInputTokens).toBe(3000);
    expect(events[1].cumulativeOutputTokens).toBe(1500);
    // index 2: +500 input, +200 output
    expect(events[2].cumulativeInputTokens).toBe(3500);
    expect(events[2].cumulativeOutputTokens).toBe(1700);
  });

  it("computes cumulative cost correctly", () => {
    const events = replay.events(RUN_A);
    // sonnet-4-6: $3/M input, $15/M output
    const cost0 = (1000 / 1e6) * 3 + (500 / 1e6) * 15;
    expect(events[0].cumulativeCostUsd).toBeCloseTo(cost0, 8);
    // index 1: sonnet again
    const cost1 = cost0 + (2000 / 1e6) * 3 + (1000 / 1e6) * 15;
    expect(events[1].cumulativeCostUsd).toBeCloseTo(cost1, 8);
    // index 2: opus-4-8: $5/M input, $25/M output
    const cost2 = cost1 + (500 / 1e6) * 5 + (200 / 1e6) * 25;
    expect(events[2].cumulativeCostUsd).toBeCloseTo(cost2, 8);
  });

  it("assigns sequential index values", () => {
    const events = replay.events(RUN_A);
    events.forEach((e, i) => {
      expect(e.index).toBe(i);
    });
  });

  it("stepTo returns the correct event", () => {
    const ev = replay.stepTo(RUN_A, 1);
    expect(ev).not.toBeNull();
    expect(ev!.phase).toBe("IMPLEMENT");
    expect(ev!.index).toBe(1);
  });

  it("stepTo returns null for out-of-range index", () => {
    expect(replay.stepTo(RUN_A, 99)).toBeNull();
    expect(replay.stepTo(RUN_A, -1)).toBeNull();
  });

  it("summary totals match sum of individual events", () => {
    const summary = replay.load(RUN_A);
    const events = summary.events;

    const sumInput = events.reduce((s, e) => s + e.inputTokens, 0);
    const sumOutput = events.reduce((s, e) => s + e.outputTokens, 0);
    const sumDuration = events.reduce((s, e) => s + e.durationMs, 0);

    expect(summary.totalInputTokens).toBe(sumInput);
    expect(summary.totalOutputTokens).toBe(sumOutput);
    expect(summary.totalDurationMs).toBe(sumDuration);
    expect(summary.totalCostUsd).toBeCloseTo(events[events.length - 1].cumulativeCostUsd, 8);
  });

  it("summary has correct phases in order of first appearance", () => {
    const summary = replay.load(RUN_A);
    expect(summary.phases).toEqual(["INTAKE", "IMPLEMENT", "REVIEW"]);
  });

  it("summary has correct startedAt and endedAt", () => {
    const summary = replay.load(RUN_A);
    expect(summary.startedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(summary.endedAt).toBe("2024-01-01T00:00:03.000Z");
  });

  it("load returns empty summary for unknown runId", () => {
    const summary = replay.load("no-such-run");
    expect(summary.totalEvents).toBe(0);
    expect(summary.events).toEqual([]);
  });

  it("returns empty array when trace file does not exist", () => {
    const r = new RunReplay("/nonexistent/path/traces.jsonl");
    expect(r.events(RUN_A)).toEqual([]);
  });
});
