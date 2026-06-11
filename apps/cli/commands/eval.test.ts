import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { BenchmarkRunner, BaselineStore } from "@projectos/evals";
import type { BenchmarkTask } from "@projectos/evals";

const TMP = "/tmp/projectos-eval-cli-test";

function makeTask(id: string, opts: { passed?: boolean; costUsd?: number; secretsLeaked?: boolean } = {}): BenchmarkTask {
  return {
    id,
    description: `task ${id}`,
    async run() {
      return {
        passed: opts.passed ?? true,
        costUsd: opts.costUsd ?? 0.01,
        durationMs: 1,
        secretsLeaked: opts.secretsLeaked ?? false,
        notes: "",
        pendingLabels: [],
      };
    },
  };
}

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("eval run — output files", () => {
  it("writes scores.json and scores-table.txt", async () => {
    const outputDir = join(TMP, "results", "2026-01-01");
    const runner = new BenchmarkRunner(
      [makeTask("task-00-smoke")],
      { outputDir, runsPerTask: 1, costCapUsd: 15, storeBaseline: false }
    );
    const result = await runner.run();

    expect(existsSync(result.scoresFile)).toBe(true);
    expect(existsSync(join(outputDir, "scores-table.txt"))).toBe(true);

    const data = JSON.parse(readFileSync(result.scoresFile, "utf8"));
    expect(data.scores).toHaveLength(1);
    expect(data.scores[0].taskId).toBe("task-00-smoke");
  });

  it("runs each task runsPerTask times", async () => {
    const outputDir = join(TMP, "runs3");
    const runner = new BenchmarkRunner(
      [makeTask("task-00-smoke")],
      { outputDir, runsPerTask: 3, costCapUsd: 15, storeBaseline: false }
    );
    const result = await runner.run();
    expect(result.scores).toHaveLength(3);
  });

  it("aborts when cost cap exceeded and still writes partial scores", async () => {
    const outputDir = join(TMP, "cap");
    // t1=$8, t2=$8 → total=$16 before t3 starts; $16 >= $15 triggers abort
    const runner = new BenchmarkRunner(
      [makeTask("t1", { costUsd: 8 }), makeTask("t2", { costUsd: 8 }), makeTask("t3", { costUsd: 8 })],
      { outputDir, runsPerTask: 1, costCapUsd: 15, storeBaseline: false }
    );
    const result = await runner.run();
    expect(result.abortedByCapAt).toBeDefined();
    // partial scores still written
    expect(existsSync(result.scoresFile)).toBe(true);
    const data = JSON.parse(readFileSync(result.scoresFile, "utf8"));
    expect(data.abortedByCapAt).toBeDefined();
  });

  it("records secretsLeaked=true in scores", async () => {
    const outputDir = join(TMP, "secrets");
    const runner = new BenchmarkRunner(
      [makeTask("t1", { secretsLeaked: true })],
      { outputDir, runsPerTask: 1, costCapUsd: 15, storeBaseline: false }
    );
    const result = await runner.run();
    expect(result.scores.some((s) => s.secretsLeaked)).toBe(true);
  });

  it("stores baseline when storeBaseline=true", async () => {
    const outputDir = join(TMP, "baseline");
    const runner = new BenchmarkRunner(
      [makeTask("task-00-smoke")],
      { outputDir, runsPerTask: 1, costCapUsd: 15, storeBaseline: true }
    );
    await runner.run();
    const baselineFile = join(outputDir, "..", "baseline.json");
    expect(existsSync(baselineFile)).toBe(true);
  });
});

describe("task-00-smoke standalone canary", () => {
  it("runs without error and passes", async () => {
    const outputDir = join(TMP, "canary");
    const { task00Smoke } = await import("../../../evals/tasks/task-00-smoke");
    const runner = new BenchmarkRunner(
      [task00Smoke],
      { outputDir, runsPerTask: 1, costCapUsd: 1, storeBaseline: false }
    );
    const result = await runner.run();
    expect(result.abortedByCapAt).toBeUndefined();
    const smoke = result.scores.find((s) => s.taskId === "task-00-smoke");
    expect(smoke).toBeDefined();
    expect(smoke!.passed).toBe(true);
    expect(smoke!.secretsLeaked).toBe(false);
  });
});

describe("eval compare — baseline store", () => {
  it("latest() returns null before any store", () => {
    const store = new BaselineStore(join(TMP, "baseline.json"));
    expect(store.latest()).toBeNull();
  });

  it("stores and retrieves a baseline entry", async () => {
    const { aggregateScores } = await import("@projectos/evals");
    const scores = aggregateScores([
      { taskId: "t1", runIndex: 0, passed: true, costUsd: 1, durationMs: 1, secretsLeaked: false, notes: "", pendingLabels: [] },
    ]);
    const store = new BaselineStore(join(TMP, "b.json"));
    store.store(scores);
    expect(store.latest()?.scores[0].taskId).toBe("t1");
  });

  it("detects regression when candidate pass rate drops", async () => {
    const { aggregateScores } = await import("@projectos/evals");
    const baseline = aggregateScores([
      { taskId: "t1", runIndex: 0, passed: true, costUsd: 0, durationMs: 0, secretsLeaked: false, notes: "", pendingLabels: [] },
    ]);
    const candidate = aggregateScores([
      { taskId: "t1", runIndex: 0, passed: false, costUsd: 0, durationMs: 0, secretsLeaked: false, notes: "", pendingLabels: [] },
    ]);

    const regressions = candidate.filter((c) => {
      const b = baseline.find((x) => x.taskId === c.taskId);
      return b && c.passRate < b.passRate;
    });
    expect(regressions).toHaveLength(1);
    expect(regressions[0].taskId).toBe("t1");
  });

  it("rollback restores a prior baseline", async () => {
    const { aggregateScores } = await import("@projectos/evals");
    const store = new BaselineStore(join(TMP, "rollback.json"));

    const v1 = store.store(aggregateScores([
      { taskId: "t1", runIndex: 0, passed: true, costUsd: 0, durationMs: 0, secretsLeaked: false, notes: "", pendingLabels: [] },
    ]));
    store.store(aggregateScores([
      { taskId: "t1", runIndex: 0, passed: false, costUsd: 0, durationMs: 0, secretsLeaked: false, notes: "", pendingLabels: [] },
    ]));

    expect(store.latest()?.scores[0].passRate).toBe(0);
    store.rollback(v1.version);
    expect(store.latest()?.scores[0].passRate).toBe(1);
  });
});
