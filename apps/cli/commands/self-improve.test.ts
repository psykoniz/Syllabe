import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import {
  HarnessOptimizer,
  validateCandidateConfig,
} from "@projectos/agents";
import type { FailurePattern } from "@projectos/agents";
import {
  CandidateRunner,
  BaselineStore,
  Frontier,
  aggregateScores,
} from "@projectos/evals";
import type { BenchmarkTask, AggregateScore } from "@projectos/evals";

const TMP = "/tmp/projectos-self-improve-test";

function makeTask(id: string, passed = true): BenchmarkTask {
  return {
    id,
    description: `task ${id}`,
    async run() {
      return { passed, costUsd: 0.01, durationMs: 1, secretsLeaked: false, notes: "", pendingLabels: [] };
    },
  };
}

function seedBaseline(baselineFile: string, passRate = 0.5): AggregateScore[] {
  const scores: AggregateScore[] = [
    { taskId: "t1", runs: [], meanCostUsd: 0, worstCostUsd: 0, passRate, anySecretsLeaked: false, hasPendingLabels: false },
  ];
  const store = new BaselineStore(baselineFile);
  store.store(scores);
  return scores;
}

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

// ─── Full workflow simulation ─────────────────────────────────────────────────

describe("self-improve workflow — end-to-end simulation", () => {
  it("analyze → propose → benchmark → promote on improvement", async () => {
    const baselineFile = join(TMP, "baseline.json");
    const harnessDir = join(TMP, "harness");
    const outputDir = join(TMP, "candidates");

    seedBaseline(baselineFile, 0.5);

    const patterns: FailurePattern[] = [
      { runId: "r1", state: "REPAIR", reason: "repair exceeded", count: 5 },
    ];
    const optimizer = new HarnessOptimizer();
    const proposal = optimizer.propose(optimizer.analyzeFailures(patterns));

    expect(validateCandidateConfig(proposal.change)).toBe(true);
    expect(proposal.change).not.toEqual({});

    const runner = new CandidateRunner([makeTask("t1", true)], { outputDir, runsPerTask: 1 });
    const candidateRun = await runner.run("auto-001", proposal.change);
    const candidateScores = aggregateScores(candidateRun.result.scores);

    const store = new BaselineStore(baselineFile);
    const latest = store.latest()!;
    const comparison = latest.scores.map((b) => {
      const c = candidateScores.find((s) => s.taskId === b.taskId)!;
      return {
        taskId: b.taskId,
        basePassRate: b.passRate,
        candidatePassRate: c.passRate,
        delta: c.passRate - b.passRate,
        costDelta: 0,
        baseMeanCostUsd: 1,
        candidateMeanCostUsd: 1,
        promoted: c.passRate >= b.passRate,
      };
    });

    const frontier = new Frontier(store, harnessDir);
    expect(frontier.shouldPromote(comparison)).toBe(true);

    const record = frontier.promote("auto-001", proposal.change, candidateScores, comparison);
    expect(store.all()).toHaveLength(2);
    expect(record.adrPath).not.toBeNull();
    expect(existsSync(record.adrPath!)).toBe(true);
  });

  it("analyze → propose → benchmark → reject on regression", async () => {
    const baselineFile = join(TMP, "baseline.json");
    const harnessDir = join(TMP, "harness");
    const outputDir = join(TMP, "candidates");

    seedBaseline(baselineFile, 1.0);  // baseline is perfect

    const runner = new CandidateRunner([makeTask("t1", false)], { outputDir, runsPerTask: 1 });
    const candidateRun = await runner.run("auto-002", { loopBounds: { maxRepair: 5 } });
    const candidateScores = aggregateScores(candidateRun.result.scores);

    const store = new BaselineStore(baselineFile);
    const latest = store.latest()!;
    const comparison = latest.scores.map((b) => {
      const c = candidateScores.find((s) => s.taskId === b.taskId)!;
      return {
        taskId: b.taskId,
        basePassRate: b.passRate,
        candidatePassRate: c.passRate,
        delta: c.passRate - b.passRate,
        costDelta: 0,
        baseMeanCostUsd: 1,
        candidateMeanCostUsd: 1,
        promoted: c.passRate >= b.passRate,
      };
    });

    const frontier = new Frontier(store, harnessDir);
    expect(frontier.shouldPromote(comparison)).toBe(false);
    // baseline unchanged — no promotion
    expect(store.all()).toHaveLength(1);
  });

  it("rollback available after promotion", async () => {
    const baselineFile = join(TMP, "baseline.json");
    const harnessDir = join(TMP, "harness");
    const outputDir = join(TMP, "candidates");

    seedBaseline(baselineFile, 0.5);

    const runner = new CandidateRunner([makeTask("t1", true)], { outputDir, runsPerTask: 1 });
    const candidateRun = await runner.run("auto-003", { loopBounds: { maxRepair: 5 } });
    const candidateScores = aggregateScores(candidateRun.result.scores);

    const store = new BaselineStore(baselineFile);
    const v1 = store.latest()!.version;
    const latest = store.latest()!;
    const comparison = latest.scores.map((b) => {
      const c = candidateScores.find((s) => s.taskId === b.taskId)!;
      return { taskId: b.taskId, basePassRate: b.passRate, candidatePassRate: c.passRate, delta: c.passRate - b.passRate, costDelta: 0,
        baseMeanCostUsd: 1,
        candidateMeanCostUsd: 1, promoted: true };
    });

    const frontier = new Frontier(store, harnessDir);
    frontier.promote("auto-003", { loopBounds: { maxRepair: 5 } }, candidateScores, comparison);

    expect(store.all()).toHaveLength(2);
    store.rollback(v1);
    expect(store.latest()?.version).toBe(v1);
    expect(store.all()).toHaveLength(1);
  });

  it("promotions are logged and loadable across Frontier instances", async () => {
    const baselineFile = join(TMP, "baseline.json");
    const harnessDir = join(TMP, "harness");
    const outputDir = join(TMP, "candidates");

    seedBaseline(baselineFile, 0.4);

    const runner = new CandidateRunner([makeTask("t1", true)], { outputDir, runsPerTask: 1 });
    const candidateRun = await runner.run("auto-004", { loopBounds: { maxRepair: 5 } });
    const candidateScores = aggregateScores(candidateRun.result.scores);

    const store = new BaselineStore(baselineFile);
    const latest = store.latest()!;
    const comparison = latest.scores.map((b) => {
      const c = candidateScores.find((s) => s.taskId === b.taskId)!;
      return { taskId: b.taskId, basePassRate: b.passRate, candidatePassRate: c.passRate, delta: c.passRate - b.passRate, costDelta: 0,
        baseMeanCostUsd: 1,
        candidateMeanCostUsd: 1, promoted: true };
    });

    new Frontier(store, harnessDir).promote("auto-004", {}, candidateScores, comparison);

    const f2 = new Frontier(store, harnessDir);
    const promotions = f2.loadPromotions();
    expect(promotions).toHaveLength(1);
    expect(promotions[0].candidateId).toBe("auto-004");
  });
});

// ─── collectFailurePatterns (unit) ───────────────────────────────────────────

describe("failure pattern collection from traces.jsonl", () => {
  it("returns empty array when traces file absent", () => {
    // No traces file — simulate by using a non-existent dir
    const patterns = collectFailurePatternsForTest(join(TMP, "nonexistent"));
    expect(patterns).toHaveLength(0);
  });

  it("aggregates escalation events by state+reason", () => {
    const runsDir = join(TMP, "traces-test");
    mkdirSync(runsDir, { recursive: true });
    const lines = [
      JSON.stringify({ runId: "r1", phase: "REPAIR", escalationReason: "max repair exceeded" }),
      JSON.stringify({ runId: "r2", phase: "REPAIR", escalationReason: "max repair exceeded" }),
      JSON.stringify({ runId: "r3", phase: "REVIEW", escalationReason: "no verdict" }),
      JSON.stringify({ runId: "r4", phase: "IMPLEMENT", inputTokens: 100 }), // no escalation
    ];
    writeFileSync(join(runsDir, "traces.jsonl"), lines.join("\n"), "utf8");

    const patterns = collectFailurePatternsForTest(runsDir);
    expect(patterns.length).toBe(2);
    const repair = patterns.find((p) => p.state === "REPAIR")!;
    expect(repair.count).toBe(2);
    const review = patterns.find((p) => p.state === "REVIEW")!;
    expect(review.count).toBe(1);
  });
});

// ─── collectFailurePatternsFromBaseline (unit) ────────────────────────────────

describe("failure pattern collection from baseline.json", () => {
  it("returns empty array when baseline absent", () => {
    expect(collectFailurePatternsFromBaseline(join(TMP, "missing.json"))).toHaveLength(0);
  });

  it("extracts escalation reason from failing task notes", () => {
    const baselinePath = join(TMP, "bl.json");
    mkdirSync(TMP, { recursive: true });
    writeFileSync(baselinePath, JSON.stringify([{
      version: 1,
      date: "2026-06-11",
      scores: [
        { taskId: "task-03", passRate: 0, runs: [{ notes: "state=ESCALATED steps=16 escalation=max review cycles (2) exceeded" }], meanCostUsd: 0, worstCostUsd: 0, anySecretsLeaked: false, hasPendingLabels: false },
        { taskId: "task-00", passRate: 1, runs: [{ notes: "state=COMPLETE" }], meanCostUsd: 0, worstCostUsd: 0, anySecretsLeaked: false, hasPendingLabels: false },
      ],
    }]), "utf8");

    const patterns = collectFailurePatternsFromBaseline(baselinePath);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].reason).toBe("max review cycles (2) exceeded");
    expect(patterns[0].runId).toBe("baseline-v1");
  });

  it("only reads the latest baseline version", () => {
    const baselinePath = join(TMP, "bl2.json");
    mkdirSync(TMP, { recursive: true });
    writeFileSync(baselinePath, JSON.stringify([
      { version: 1, date: "d", scores: [{ taskId: "t1", passRate: 0, runs: [{ notes: "old failure" }] }] },
      { version: 2, date: "d", scores: [{ taskId: "t1", passRate: 1, runs: [{ notes: "fixed" }] }] },
    ]), "utf8");

    expect(collectFailurePatternsFromBaseline(baselinePath)).toHaveLength(0);
  });
});

// ── import the real implementations from the command module ────────────────────
import { readFileSync } from "fs";
import { collectFailurePatterns as collectFailurePatternsForTest, collectFailurePatternsFromBaseline } from "./self-improve";
