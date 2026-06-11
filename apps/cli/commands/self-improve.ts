import { Command } from "commander";
import { mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { HarnessOptimizer, validateCandidateConfig } from "@projectos/agents";
import type { FailurePattern } from "@projectos/agents";
import { CandidateRunner, BaselineStore, Frontier, aggregateScores } from "@projectos/evals";
import type { BenchmarkTask } from "@projectos/evals";

export const selfImproveCommand = new Command("self-improve")
  .description("Analyze failed runs, propose a candidate change, benchmark it, and promote if better")
  .option("--runs-dir <path>", "Directory containing run records", ".projectos")
  .option("--baseline <path>", "Baseline file", "evals/results/baseline.json")
  .option("--harness-dir <path>", "Harness ADR + promotions directory", "~/.projectos/harness")
  .option("--output <dir>", "Candidate benchmark output directory", "evals/results/candidates")
  .option("--runs <n>", "Repetitions per task for benchmark", "3")
  .option("--cost-cap <usd>", "Hard cost cap in USD for candidate benchmark", "15")
  .option("--dry-run", "Analyze and propose but do not benchmark or promote", false)
  .action(async (opts) => {
    const harnessDir = opts.harnessDir.replace(/^~/, process.env.HOME ?? "~");

    console.log("\nProjectOS self-improve");
    console.log(`Runs dir:    ${opts.runsDir}`);
    console.log(`Baseline:    ${opts.baseline}`);
    console.log(`Harness dir: ${harnessDir}\n`);

    // ── 1. Collect failure patterns from run records + baseline scores ──────────

    const patterns = [
      ...collectFailurePatterns(opts.runsDir),
      ...collectFailurePatternsFromBaseline(opts.baseline),
    ];
    console.log(`Collected ${patterns.length} failure pattern(s).`);
    if (patterns.length > 0) {
      for (const p of patterns.slice(0, 5)) {
        console.log(`  [${p.count}x] ${p.state}: ${p.reason}`);
      }
    }

    // ── 2. Analyze + propose ──────────────────────────────────────────────────

    const optimizer = new HarnessOptimizer();
    const sorted = optimizer.analyzeFailures(patterns);
    const proposal = optimizer.propose(sorted);

    console.log(`\nProposal: ${proposal.rationale}`);
    console.log(`Change:   ${JSON.stringify(proposal.change)}`);

    if (!validateCandidateConfig(proposal.change)) {
      console.error("Proposal failed schema validation — aborting.");
      process.exit(1);
    }

    if (Object.keys(proposal.change).length === 0) {
      console.log("No change to benchmark. Exiting.");
      return;
    }

    if (opts.dryRun) {
      console.log("\n--dry-run set: skipping benchmark and promotion.");
      return;
    }

    // ── 3. Benchmark the candidate ────────────────────────────────────────────

    const { task00Smoke } = await import("../../../evals/tasks/task-00-smoke");
    const { task01TodoApp } = await import("../../../evals/tasks/task-01-todo-app");
    const { task02Stripe } = await import("../../../evals/tasks/task-02-stripe");
    const { task03BugFix } = await import("../../../evals/tasks/task-03-bug-fix");
    const { task04Playwright } = await import("../../../evals/tasks/task-04-playwright");
    const { task05LandingPage } = await import("../../../evals/tasks/task-05-landing-page");
    const tasks: BenchmarkTask[] = [task00Smoke, task01TodoApp, task02Stripe, task03BugFix, task04Playwright, task05LandingPage];

    const candidateId = `auto-${Date.now()}`;
    mkdirSync(opts.output, { recursive: true });

    console.log(`\nBenchmarking candidate ${candidateId} (${tasks.length} tasks × ${opts.runs} reps)…`);
    const runner = new CandidateRunner(tasks, {
      outputDir: opts.output,
      runsPerTask: parseInt(opts.runs, 10),
      costCapUsd: parseFloat(opts.costCap),
    });
    // Apply the candidate's loop bounds to the benchmark runs via env
    // (eval tasks read PROJECTOS_LOOP_BOUNDS in _harness.ts)
    const prevBounds = process.env.PROJECTOS_LOOP_BOUNDS;
    if (proposal.change.loopBounds) {
      const merged = { maxRepair: 3, maxReview: 2, ...proposal.change.loopBounds };
      process.env.PROJECTOS_LOOP_BOUNDS = JSON.stringify(merged);
    }
    let candidateRun;
    try {
      candidateRun = await runner.run(candidateId, proposal.change);
    } finally {
      if (prevBounds === undefined) delete process.env.PROJECTOS_LOOP_BOUNDS;
      else process.env.PROJECTOS_LOOP_BOUNDS = prevBounds;
    }
    const candidateScores = aggregateScores(candidateRun.result.scores);

    console.log(`Benchmark done. Total cost: $${candidateRun.result.totalCostUsd.toFixed(4)}`);
    if (candidateRun.result.abortedByCapAt) {
      console.warn(`Cost cap hit at task: ${candidateRun.result.abortedByCapAt}`);
    }

    // ── 4. Compare against baseline ───────────────────────────────────────────

    const baselineStore = new BaselineStore(opts.baseline);
    const latestBaseline = baselineStore.latest();

    if (!latestBaseline) {
      console.log("No baseline found — storing candidate as initial baseline.");
      baselineStore.store(candidateScores);
      console.log("Baseline stored. Run again after more runs to enable comparison.");
      return;
    }

    const comparison = latestBaseline.scores.map((b) => {
      const c = candidateScores.find((s) => s.taskId === b.taskId);
      if (!c) return null;
      return {
        taskId: b.taskId,
        basePassRate: b.passRate,
        candidatePassRate: c.passRate,
        delta: c.passRate - b.passRate,
        costDelta: c.meanCostUsd - b.meanCostUsd,
        promoted: c.passRate >= b.passRate && !c.anySecretsLeaked,
      };
    }).filter((x): x is NonNullable<typeof x> => x !== null);

    // ── 5. Promote or reject ──────────────────────────────────────────────────

    const frontier = new Frontier(baselineStore, harnessDir);
    const shouldPromote = frontier.shouldPromote(comparison);

    console.log("\nComparison:");
    for (const c of comparison) {
      const arrow = c.delta >= 0 ? "↑" : "↓";
      console.log(`  ${c.taskId}: ${c.basePassRate.toFixed(2)} → ${c.candidatePassRate.toFixed(2)} ${arrow}`);
    }

    if (shouldPromote) {
      const record = frontier.promote(candidateId, proposal.change, candidateScores, comparison);
      console.log(`\nPromoted candidate ${candidateId}.`);
      if (record.adrPath) console.log(`ADR written: ${record.adrPath}`);
    } else {
      console.log("\nCandidate rejected — regressions detected or secrets leaked.");
      process.exit(1);
    }
  });

/** Scan .projectos/ for failed run records and build FailurePattern list */
export function collectFailurePatterns(runsDir: string): FailurePattern[] {
  const tracePath = join(runsDir, "traces.jsonl");
  if (!existsSync(tracePath)) return [];

  try {
    const lines = readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean);
    const counts = new Map<string, { runId: string; state: string; reason: string; count: number }>();

    for (const line of lines) {
      const event = JSON.parse(line) as { runId?: string; phase?: string; escalationReason?: string };
      if (!event.escalationReason) continue;
      const key = `${event.phase ?? "UNKNOWN"}:${event.escalationReason}`;
      const existing = counts.get(key);
      if (existing) {
        existing.count++;
      } else {
        counts.set(key, {
          runId: event.runId ?? "unknown",
          state: event.phase ?? "UNKNOWN",
          reason: event.escalationReason,
          count: 1,
        });
      }
    }
    return Array.from(counts.values());
  } catch {
    return [];
  }
}

/** Derive failure patterns from baseline scores (0% pass rate = failure) */
export function collectFailurePatternsFromBaseline(baselinePath: string): FailurePattern[] {
  if (!existsSync(baselinePath)) return [];
  try {
    const store = JSON.parse(readFileSync(baselinePath, "utf8")) as Array<{
      version: number;
      scores: Array<{ taskId: string; passRate: number; runs: Array<{ notes: string }> }>;
    }>;
    const latest = store[store.length - 1];
    if (!latest) return [];

    return latest.scores
      .filter((s) => s.passRate === 0)
      .map((s) => {
        // Extract escalation reason from run notes if available
        const note = s.runs?.[0]?.notes ?? "";
        const escalationMatch = /escalation=(.+)/.exec(note);
        const reason = escalationMatch ? escalationMatch[1] : `task failed: ${s.taskId}`;
        return {
          runId: `baseline-v${latest.version}`,
          state: "REVIEW",
          reason,
          count: s.runs?.length ?? 1,
        };
      });
  } catch {
    return [];
  }
}
