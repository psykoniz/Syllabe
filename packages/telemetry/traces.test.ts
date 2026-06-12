import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { appendTrace } from "./traces";
import type { TraceEvent } from "./traces";

const TMP = join(tmpdir(), "projectos-test-traces.jsonl");

function cleanup() {
  if (existsSync(TMP)) rmSync(TMP);
}

beforeEach(cleanup);
afterEach(cleanup);

const event: TraceEvent = {
  ts: "2026-06-10T00:00:00.000Z",
  runId: "run-001",
  phase: "IMPLEMENT",
  role: "implementer",
  model: "claude-sonnet-4-6",
  inputTokens: 1000,
  outputTokens: 500,
  durationMs: 1234,
};

describe("appendTrace", () => {
  it("creates file with one JSONL line", () => {
    appendTrace(TMP, event);
    const lines = readFileSync(TMP, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ runId: "run-001", phase: "IMPLEMENT" });
  });

  it("appends multiple events", () => {
    appendTrace(TMP, event);
    appendTrace(TMP, { ...event, runId: "run-002" });
    const lines = readFileSync(TMP, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).runId).toBe("run-002");
  });

  it("creates parent directory if missing", () => {
    const nested = join(tmpdir(), "projectos-test-nested", "deep", "traces.jsonl");
    try {
      appendTrace(nested, event);
      expect(existsSync(nested)).toBe(true);
    } finally {
      rmSync(join(tmpdir(), "projectos-test-nested"), { recursive: true, force: true });
    }
  });
});
