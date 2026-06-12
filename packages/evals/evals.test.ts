import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BenchmarkRunner } from "./benchmark-runner";
import { aggregateScores, formatScoreTable } from "./scorers";
import { BaselineStore } from "./baseline";
import type { BenchmarkTask, TaskScore } from "./index";

const TMP = join(tmpdir(), "projectos-evals-test");

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTask(id: string, opts: {
  passed?: boolean;
  costUsd?: number;
  secretsLeaked?: boolean;
  pendingLabels?: string[];
  failAfterRuns?: number;
} = {}): BenchmarkTask {
  let callCount = 0;
  return {
    id,
    description: `task ${id}`,
    async run() {
      callCount++;
      const passed = opts.failAfterRuns !== undefined
        ? callCount <= opts.failAfterRuns
        : (opts.passed ?? true);
      return {
        passed,
        costUsd: opts.costUsd ?? 0.10,
        durationMs: 10,
        secretsLeaked: opts.secretsLeaked ?? false,
        notes: "",
        pendingLabels: opts.pendingLabels ?? [],
      };
    },
  };
}

// ─── BenchmarkRunner ─────────────────────────────────────────────────────────

describe("BenchmarkRunner", () => {
  it("writes scores.json to outputDir", async () => {
    const runner = new BenchmarkRunner(
      [makeTask("task-00-smoke")],
      { outputDir: TMP, runsPerTask: 1, storeBaseline: false }
    );
    await runner.run();
    expect(existsSync(join(TMP, "scores.json"))).toBe(true);
  });

  it("runs each task runsPerTask times", async () => {
    let callCount = 0;
    const task: BenchmarkTask = {
      id: "t1",
      description: "d",
      async run() {
        callCount++;
        return { passed: true, costUsd: 0.01, durationMs: 1, secretsLeaked: false, notes: "", pendingLabels: [] };
      },
    };
    const runner = new BenchmarkRunner([task], { outputDir: TMP, runsPerTask: 3, storeBaseline: false });
    await runner.run();
    expect(callCount).toBe(3);
  });

  it("aborts when cost cap is exceeded and writes partial scores", async () => {
    const tasks = [
      makeTask("t1", { costUsd: 8 }),
      makeTask("t2", { costUsd: 8 }),
    ];
    const runner = new BenchmarkRunner(tasks, {
      outputDir: TMP,
      runsPerTask: 3,
      costCapUsd: 15,
      storeBaseline: false,
    });
    const result = await runner.run();
    expect(result.abortedByCapAt).toBeDefined();
    // Partial scores still written
    const data = JSON.parse(readFileSync(join(TMP, "scores.json"), "utf8"));
    expect(data.scores.length).toBeGreaterThan(0);
    expect(data.abortedByCapAt).toBeDefined();
  });

  it("stores baseline after run when storeBaseline=true", async () => {
    const runner = new BenchmarkRunner(
      [makeTask("task-00-smoke", { costUsd: 0.01 })],
      { outputDir: join(TMP, "results/2026-01-01"), runsPerTask: 1, storeBaseline: true }
    );
    await runner.run();
    expect(existsSync(join(TMP, "results/baseline.json"))).toBe(true);
  });

  it("a run that leaks secrets is marked secretsLeaked=true in scores", async () => {
    const runner = new BenchmarkRunner(
      [makeTask("t1", { secretsLeaked: true })],
      { outputDir: TMP, runsPerTask: 1, storeBaseline: false }
    );
    const result = await runner.run();
    expect(result.scores.some((s) => s.secretsLeaked)).toBe(true);
  });

  it("task-00-smoke can run standalone", async () => {
    const runner = new BenchmarkRunner(
      [makeTask("task-00-smoke", { costUsd: 0.01 })],
      { outputDir: TMP, runsPerTask: 1, storeBaseline: false }
    );
    const result = await runner.run();
    const smoke = result.scores.find((s) => s.taskId === "task-00-smoke");
    expect(smoke).toBeDefined();
  });
});

// ─── aggregateScores ─────────────────────────────────────────────────────────

describe("aggregateScores", () => {
  it("computes mean and worst cost", () => {
    const scores: TaskScore[] = [
      { taskId: "t1", runIndex: 0, passed: true, costUsd: 1.0, durationMs: 10, secretsLeaked: false, notes: "", pendingLabels: [] },
      { taskId: "t1", runIndex: 1, passed: true, costUsd: 3.0, durationMs: 10, secretsLeaked: false, notes: "", pendingLabels: [] },
    ];
    const [agg] = aggregateScores(scores);
    expect(agg.meanCostUsd).toBe(2.0);
    expect(agg.worstCostUsd).toBe(3.0);
  });

  it("computes passRate correctly", () => {
    const scores: TaskScore[] = [
      { taskId: "t1", runIndex: 0, passed: true, costUsd: 0, durationMs: 0, secretsLeaked: false, notes: "", pendingLabels: [] },
      { taskId: "t1", runIndex: 1, passed: false, costUsd: 0, durationMs: 0, secretsLeaked: false, notes: "", pendingLabels: [] },
      { taskId: "t1", runIndex: 2, passed: true, costUsd: 0, durationMs: 0, secretsLeaked: false, notes: "", pendingLabels: [] },
    ];
    const [agg] = aggregateScores(scores);
    expect(agg.passRate).toBeCloseTo(2 / 3);
  });

  it("anySecretsLeaked is true if any run leaked", () => {
    const scores: TaskScore[] = [
      { taskId: "t1", runIndex: 0, passed: true, costUsd: 0, durationMs: 0, secretsLeaked: false, notes: "", pendingLabels: [] },
      { taskId: "t1", runIndex: 1, passed: true, costUsd: 0, durationMs: 0, secretsLeaked: true, notes: "", pendingLabels: [] },
    ];
    const [agg] = aggregateScores(scores);
    expect(agg.anySecretsLeaked).toBe(true);
  });

  it("hasPendingLabels is true when any run has pending-label fields", () => {
    const scores: TaskScore[] = [
      { taskId: "t1", runIndex: 0, passed: true, costUsd: 0, durationMs: 0, secretsLeaked: false, notes: "", pendingLabels: ["unnecessaryQuestions"] },
    ];
    const [agg] = aggregateScores(scores);
    expect(agg.hasPendingLabels).toBe(true);
  });

  it("groups scores by taskId", () => {
    const scores: TaskScore[] = [
      { taskId: "t1", runIndex: 0, passed: true, costUsd: 0, durationMs: 0, secretsLeaked: false, notes: "", pendingLabels: [] },
      { taskId: "t2", runIndex: 0, passed: false, costUsd: 0, durationMs: 0, secretsLeaked: false, notes: "", pendingLabels: [] },
    ];
    const aggs = aggregateScores(scores);
    expect(aggs).toHaveLength(2);
  });
});

// ─── BaselineStore ────────────────────────────────────────────────────────────

describe("BaselineStore", () => {
  const baselineFile = () => join(TMP, "baseline.json");

  it("store() saves a baseline and latest() returns it", () => {
    const store = new BaselineStore(baselineFile());
    store.store([{ taskId: "t1", runs: [], meanCostUsd: 1, worstCostUsd: 2, passRate: 1, anySecretsLeaked: false, hasPendingLabels: false }]);
    expect(store.latest()).not.toBeNull();
    expect(store.latest()?.version).toBe(1);
  });

  it("baseline stored after first run and compare produces diff", () => {
    const store = new BaselineStore(baselineFile());
    store.store([{ taskId: "t1", runs: [], meanCostUsd: 1, worstCostUsd: 1, passRate: 0.5, anySecretsLeaked: false, hasPendingLabels: false }]);
    store.store([{ taskId: "t1", runs: [], meanCostUsd: 1, worstCostUsd: 1, passRate: 0.8, anySecretsLeaked: false, hasPendingLabels: false }]);
    const diff = store.compare(1, 2);
    expect(diff).toHaveLength(1);
    expect(diff[0].delta).toBeCloseTo(0.3);
  });

  it("retains only last 3 baselines", () => {
    const store = new BaselineStore(baselineFile());
    for (let i = 0; i < 5; i++) {
      store.store([{ taskId: "t1", runs: [], meanCostUsd: 0, worstCostUsd: 0, passRate: 1, anySecretsLeaked: false, hasPendingLabels: false }]);
    }
    expect(store.all()).toHaveLength(3);
  });

  it("rollback restores a prior baseline", () => {
    const store = new BaselineStore(baselineFile());
    store.store([{ taskId: "t1", runs: [], meanCostUsd: 0, worstCostUsd: 0, passRate: 0.5, anySecretsLeaked: false, hasPendingLabels: false }]);
    store.store([{ taskId: "t1", runs: [], meanCostUsd: 0, worstCostUsd: 0, passRate: 0.9, anySecretsLeaked: false, hasPendingLabels: false }]);
    store.rollback(1);
    expect(store.latest()?.version).toBe(1);
    expect(store.all()).toHaveLength(1);
  });

  it("persists across instances", () => {
    const s1 = new BaselineStore(baselineFile());
    s1.store([{ taskId: "t1", runs: [], meanCostUsd: 0, worstCostUsd: 0, passRate: 1, anySecretsLeaked: false, hasPendingLabels: false }]);
    const s2 = new BaselineStore(baselineFile());
    expect(s2.latest()?.version).toBe(1);
  });

  it("compare promoted=false when candidate leaks secrets", () => {
    const store = new BaselineStore(baselineFile());
    store.store([{ taskId: "t1", runs: [], meanCostUsd: 0, worstCostUsd: 0, passRate: 0.5, anySecretsLeaked: false, hasPendingLabels: false }]);
    store.store([{ taskId: "t1", runs: [], meanCostUsd: 0, worstCostUsd: 0, passRate: 1.0, anySecretsLeaked: true, hasPendingLabels: false }]);
    const diff = store.compare(1, 2);
    expect(diff[0].promoted).toBe(false);
  });
});

// ─── formatScoreTable ─────────────────────────────────────────────────────────

describe("formatScoreTable", () => {
  it("includes task id and pass rate in output", () => {
    const aggs = aggregateScores([
      { taskId: "task-00-smoke", runIndex: 0, passed: true, costUsd: 0.01, durationMs: 5, secretsLeaked: false, notes: "", pendingLabels: [] },
    ]);
    const table = formatScoreTable(aggs);
    expect(table).toContain("task-00-smoke");
    expect(table).toContain("100%");
  });

  it("marks secrets-leaked runs as FAIL(secrets)", () => {
    const aggs = aggregateScores([
      { taskId: "t1", runIndex: 0, passed: true, costUsd: 0, durationMs: 0, secretsLeaked: true, notes: "", pendingLabels: [] },
    ]);
    const table = formatScoreTable(aggs);
    expect(table).toContain("FAIL(secrets)");
  });
});

describe("costGuardAllows", () => {
  const { costGuardAllows } = require("./frontier");
  const cmp = (delta: number, baseCost: number, candCost: number) => [{
    taskId: "t", basePassRate: 1, candidatePassRate: 1 + delta, delta,
    costDelta: candCost - baseCost, baseMeanCostUsd: baseCost,
    candidateMeanCostUsd: candCost, promoted: true,
  }];

  it("allows equal cost at equal pass rate", () => {
    expect(costGuardAllows(cmp(0, 1.0, 1.0), 0.2)).toBe(true);
  });

  it("allows up to +20% cost at equal pass rate", () => {
    expect(costGuardAllows(cmp(0, 1.0, 1.19), 0.2)).toBe(true);
  });

  it("rejects +50% cost at equal pass rate (silent cost drift)", () => {
    expect(costGuardAllows(cmp(0, 1.0, 1.5), 0.2)).toBe(false);
  });

  it("pass-rate gain widens the tolerance (2:1 exchange rate)", () => {
    // +0.10 mean pass rate → +20% extra allowance → 1.0 * 1.4 ceiling
    expect(costGuardAllows(cmp(0.10, 1.0, 1.39), 0.2)).toBe(true);
    expect(costGuardAllows(cmp(0.10, 1.0, 1.45), 0.2)).toBe(false);
  });

  it("pass-rate regression does not shrink below the base ratio", () => {
    expect(costGuardAllows(cmp(-0.5, 1.0, 1.19), 0.2)).toBe(true);
  });

  it("no cost data (zero baseline) passes the guard", () => {
    expect(costGuardAllows(cmp(0, 0, 0), 0.2)).toBe(true);
  });
});
