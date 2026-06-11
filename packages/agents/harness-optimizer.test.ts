import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { HarnessOptimizer, validateCandidateConfig } from "./harness-optimizer";
import type { FailurePattern, CandidateConfig } from "./harness-optimizer";
import { CandidateRunner } from "@projectos/evals";
import { Frontier, DEFAULT_PROMOTION_RULES } from "@projectos/evals";
import { BaselineStore } from "@projectos/evals";
import type { BenchmarkTask } from "@projectos/evals";

const TMP = "/tmp/projectos-optimizer-test";

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function makeTask(id: string, passed = true): BenchmarkTask {
  return {
    id,
    description: `task ${id}`,
    async run() {
      return { passed, costUsd: 0.01, durationMs: 5, secretsLeaked: false, notes: "", pendingLabels: [] };
    },
  };
}

// ─── validateCandidateConfig ──────────────────────────────────────────────────

describe("validateCandidateConfig", () => {
  it("accepts empty config", () => {
    expect(validateCandidateConfig({})).toBe(true);
  });

  it("accepts systemPrompts", () => {
    expect(validateCandidateConfig({ systemPrompts: { architect: "You are..." } })).toBe(true);
  });

  it("accepts modelRouting", () => {
    expect(validateCandidateConfig({ modelRouting: { implementer: "claude-sonnet-4-6" } })).toBe(true);
  });

  it("accepts stateBudgets", () => {
    expect(validateCandidateConfig({ stateBudgets: { IMPLEMENT: 100000 } })).toBe(true);
  });

  it("accepts loopBounds", () => {
    expect(validateCandidateConfig({ loopBounds: { maxRepair: 5, maxReview: 3 } })).toBe(true);
  });

  it("rejects structural changes (new fields outside v1 scope)", () => {
    expect(validateCandidateConfig({ newStates: ["VALIDATE"] })).toBe(false);
  });

  it("rejects non-object", () => {
    expect(validateCandidateConfig("invalid")).toBe(false);
    expect(validateCandidateConfig(null)).toBe(false);
    expect(validateCandidateConfig(42)).toBe(false);
  });

  it("rejects systemPrompts with non-string values", () => {
    expect(validateCandidateConfig({ systemPrompts: { architect: 123 } })).toBe(false);
  });

  it("rejects stateBudgets with non-number values", () => {
    expect(validateCandidateConfig({ stateBudgets: { IMPLEMENT: "lots" } })).toBe(false);
  });
});

// ─── HarnessOptimizer ─────────────────────────────────────────────────────────

describe("HarnessOptimizer", () => {
  it("propose() returns empty change for no failures", () => {
    const opt = new HarnessOptimizer();
    const proposal = opt.propose([]);
    expect(proposal.change).toEqual({});
    expect(proposal.targetPatterns).toHaveLength(0);
  });

  it("propose() targets most frequent failure pattern", () => {
    const opt = new HarnessOptimizer();
    const patterns: FailurePattern[] = [
      { runId: "r1", state: "REPAIR", reason: "repair exceeded", count: 5 },
      { runId: "r2", state: "REVIEW", reason: "review exceeded", count: 2 },
    ];
    const proposal = opt.propose(patterns);
    expect(proposal.targetPatterns).toContain("repair exceeded");
    expect(proposal.change.loopBounds?.maxRepair).toBeDefined();
  });

  it("proposal validates against CandidateConfig schema", () => {
    const opt = new HarnessOptimizer();
    const patterns: FailurePattern[] = [
      { runId: "r1", state: "REPAIR", reason: "repair exceeded", count: 3 },
    ];
    const proposal = opt.propose(patterns);
    expect(validateCandidateConfig(proposal.change)).toBe(true);
  });

  it("proposal for budget overflow sets stateBudgets", () => {
    const opt = new HarnessOptimizer();
    const patterns: FailurePattern[] = [
      { runId: "r1", state: "IMPLEMENT", reason: "budget overflow", count: 4 },
    ];
    const proposal = opt.propose(patterns);
    expect(proposal.change.stateBudgets).toBeDefined();
  });

  it("saveProposal writes JSON file", () => {
    const opt = new HarnessOptimizer();
    const proposal = opt.propose([{ runId: "r1", state: "REPAIR", reason: "repair exceeded", count: 3 }]);
    const path = join(TMP, "proposal.json");
    opt.saveProposal(path, proposal);
    expect(existsSync(path)).toBe(true);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.rationale).toBeTruthy();
  });
});

// ─── CandidateRunner ──────────────────────────────────────────────────────────

describe("CandidateRunner", () => {
  it("runs tasks with candidate config and writes scores", async () => {
    const runner = new CandidateRunner([makeTask("t1")], { outputDir: TMP, runsPerTask: 1 });
    const config: CandidateConfig = { loopBounds: { maxRepair: 5 } };
    const run = await runner.run("cand-001", config);
    expect(run.id).toBe("cand-001");
    expect(run.result.scores.length).toBeGreaterThan(0);
  });

  it("persists candidate config alongside results", async () => {
    const runner = new CandidateRunner([makeTask("t1")], { outputDir: TMP, runsPerTask: 1 });
    const config: CandidateConfig = { modelRouting: { implementer: "claude-sonnet-4-6" } };
    await runner.run("cand-002", config);
    const loaded = runner.loadConfig("cand-002");
    expect(loaded).toEqual(config);
  });

  it("candidate runner executes a config distinct from baseline", async () => {
    const baseConfig: CandidateConfig = { loopBounds: { maxRepair: 3 } };
    const candidateConfig: CandidateConfig = { loopBounds: { maxRepair: 5 } };
    const runner = new CandidateRunner([makeTask("t1")], { outputDir: TMP, runsPerTask: 1 });
    const run = await runner.run("cand-003", candidateConfig);
    expect(run.config).toEqual(candidateConfig);
    expect(run.config).not.toEqual(baseConfig);
  });

  it("loadConfig returns null for unknown candidate", () => {
    const runner = new CandidateRunner([], { outputDir: TMP });
    expect(runner.loadConfig("nonexistent")).toBeNull();
  });
});

// ─── Frontier ─────────────────────────────────────────────────────────────────

describe("Frontier", () => {
  const baselineFile = () => join(TMP, "baseline.json");
  const harnessDir = () => join(TMP, "harness");

  it("shouldPromote returns true when no regressions and no secrets", () => {
    const store = new BaselineStore(baselineFile());
    const f = new Frontier(store, harnessDir());
    expect(f.shouldPromote([
      { taskId: "t1", basePassRate: 0.5, candidatePassRate: 0.8, delta: 0.3, costDelta: 0, baseMeanCostUsd: 1, candidateMeanCostUsd: 1, promoted: true },
    ])).toBe(true);
  });

  it("shouldPromote returns false when any regression", () => {
    const store = new BaselineStore(baselineFile());
    const f = new Frontier(store, harnessDir());
    expect(f.shouldPromote([
      { taskId: "t1", basePassRate: 0.8, candidatePassRate: 0.6, delta: -0.2, costDelta: 0, baseMeanCostUsd: 1, candidateMeanCostUsd: 1, promoted: false },
    ])).toBe(false);
  });

  it("shouldPromote returns false when secrets leaked", () => {
    const store = new BaselineStore(baselineFile());
    const f = new Frontier(store, harnessDir());
    // promoted=false but delta>=0 means secrets leaked (per baseline compare logic)
    expect(f.shouldPromote([
      { taskId: "t1", basePassRate: 0.5, candidatePassRate: 1.0, delta: 0.5, costDelta: 0, baseMeanCostUsd: 1, candidateMeanCostUsd: 1, promoted: false },
    ])).toBe(false);
  });

  it("promote stores new baseline and writes ADR", () => {
    const store = new BaselineStore(baselineFile());
    // Seed baseline version 1
    store.store([{ taskId: "t1", runs: [], meanCostUsd: 0, worstCostUsd: 0, passRate: 0.5, anySecretsLeaked: false, hasPendingLabels: false }]);
    const f = new Frontier(store, harnessDir());
    const comparison = [
      { taskId: "t1", basePassRate: 0.5, candidatePassRate: 0.8, delta: 0.3, costDelta: 0, baseMeanCostUsd: 1, candidateMeanCostUsd: 1, promoted: true },
    ];
    const record = f.promote(
      "cand-001",
      { loopBounds: { maxRepair: 5 } },
      [{ taskId: "t1", runs: [], meanCostUsd: 0, worstCostUsd: 0, passRate: 0.8, anySecretsLeaked: false, hasPendingLabels: false }],
      comparison
    );
    expect(store.all()).toHaveLength(2);
    expect(record.adrPath).not.toBeNull();
    expect(existsSync(record.adrPath!)).toBe(true);
  });

  it("promotion blocked when rules fail; applied when they pass", () => {
    const store = new BaselineStore(baselineFile());
    store.store([{ taskId: "t1", runs: [], meanCostUsd: 0, worstCostUsd: 0, passRate: 0.5, anySecretsLeaked: false, hasPendingLabels: false }]);
    const f = new Frontier(store, harnessDir());

    const regression = [
      { taskId: "t1", basePassRate: 0.8, candidatePassRate: 0.5, delta: -0.3, costDelta: 0, baseMeanCostUsd: 1, candidateMeanCostUsd: 1, promoted: false },
    ];
    expect(f.shouldPromote(regression)).toBe(false);

    const improvement = [
      { taskId: "t1", basePassRate: 0.5, candidatePassRate: 0.9, delta: 0.4, costDelta: 0, baseMeanCostUsd: 1, candidateMeanCostUsd: 1, promoted: true },
    ];
    expect(f.shouldPromote(improvement)).toBe(true);
  });

  it("rollback restores a prior baseline", () => {
    const store = new BaselineStore(baselineFile());
    store.store([{ taskId: "t1", runs: [], meanCostUsd: 0, worstCostUsd: 0, passRate: 0.5, anySecretsLeaked: false, hasPendingLabels: false }]);
    store.store([{ taskId: "t1", runs: [], meanCostUsd: 0, worstCostUsd: 0, passRate: 0.9, anySecretsLeaked: false, hasPendingLabels: false }]);
    store.rollback(1);
    expect(store.latest()?.version).toBe(1);
  });

  it("promotions are persisted and loadable", () => {
    const store = new BaselineStore(baselineFile());
    store.store([{ taskId: "t1", runs: [], meanCostUsd: 0, worstCostUsd: 0, passRate: 0.5, anySecretsLeaked: false, hasPendingLabels: false }]);
    const f = new Frontier(store, harnessDir());
    f.promote(
      "cand-001",
      { loopBounds: { maxRepair: 5 } },
      [{ taskId: "t1", runs: [], meanCostUsd: 0, worstCostUsd: 0, passRate: 0.8, anySecretsLeaked: false, hasPendingLabels: false }],
      [{ taskId: "t1", basePassRate: 0.5, candidatePassRate: 0.8, delta: 0.3, costDelta: 0, baseMeanCostUsd: 1, candidateMeanCostUsd: 1, promoted: true }]
    );
    const f2 = new Frontier(store, harnessDir());
    expect(f2.loadPromotions()).toHaveLength(1);
    expect(f2.loadPromotions()[0].candidateId).toBe("cand-001");
  });
});

describe("HarnessOptimizer — escalated review failures target prompts", () => {
  it("proposes a systemPrompts change when review cycles were already raised", () => {
    const opt = new HarnessOptimizer();
    const proposal = opt.propose([
      { runId: "r1", state: "REVIEW", reason: "max review cycles (3) exceeded", count: 2 },
    ]);
    expect(proposal.change.systemPrompts?.implementer).toBeDefined();
    expect(proposal.change.loopBounds).toBeUndefined();
    expect(validateCandidateConfig(proposal.change)).toBe(true);
  });

  it("still proposes loopBounds when cycles are at the default", () => {
    const opt = new HarnessOptimizer();
    const proposal = opt.propose([
      { runId: "r1", state: "REVIEW", reason: "max review cycles (2) exceeded", count: 2 },
    ]);
    expect(proposal.change.loopBounds?.maxReview).toBe(3);
    expect(proposal.change.systemPrompts).toBeUndefined();
  });
});

describe("HarnessOptimizer — rejected candidate memory", () => {
  it("falls back to prompt-scope candidate when loopBounds was rejected", () => {
    const opt = new HarnessOptimizer();
    const proposal = opt.propose(
      [{ runId: "r1", state: "REVIEW", reason: "max review cycles (2) exceeded", count: 1 }],
      [{ loopBounds: { maxReview: 3 } }]
    );
    expect(proposal.change.systemPrompts?.implementer).toBeDefined();
    expect(proposal.change.loopBounds).toBeUndefined();
    expect(proposal.rationale).toContain("rejected");
  });

  it("escalates with empty change when all candidates are rejected", () => {
    const opt = new HarnessOptimizer();
    const proposal = opt.propose(
      [{ runId: "r1", state: "REVIEW", reason: "max review cycles (2) exceeded", count: 1 }],
      [
        { loopBounds: { maxReview: 3 } },
        opt.propose(
          [{ runId: "r1", state: "REVIEW", reason: "max review cycles (2) exceeded", count: 1 }],
          [{ loopBounds: { maxReview: 3 } }]
        ).change,
      ]
    );
    expect(proposal.change).toEqual({});
    expect(proposal.rationale).toContain("escalate to human");
  });
});
