/**
 * SWE-bench Lite runner for ProjectOS.
 *
 * Maps each SWE-bench instance to a ProjectOS run in --repo mode, then
 * extracts the agent's source patch into a predictions file consumed by the
 * OFFICIAL SWE-bench Docker harness for scoring. We do NOT score in-process:
 * faithful evaluation needs the per-version Docker environments that the
 * official harness provides.
 *
 * Flow per instance:
 *   1. clone repo at base_commit (test_patch is NOT applied — no eval leakage)
 *   2. give the agent the problem statement as the task
 *   3. extract `git diff base_commit` (source only, test files stripped)
 *   4. append a prediction line; the official harness verifies later
 */

import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync, rmSync, copyFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { spawnSync } from "child_process";
import { buildTaskPrompt } from "./loader";
import { stripNonSourceChanges, toPredictionLine } from "./predictions";
import type { SweBenchInstance } from "./loader";

const OUTPUT_DIR = "evals/results/swe-bench";

export interface SWEBenchRunResult {
  instanceId: string;
  repo: string;
  baseCommit: string;
  /** Whether the agent produced a non-empty source patch */
  producedPatch: boolean;
  agentState: string;
  patchSize: number;
  costUsd: number;
  durationMs: number;
  notes: string;
}

export interface SWEBenchSuiteResult {
  date: string;
  modelName: string;
  totalInstances: number;
  patchesProduced: number;
  totalCostUsd: number;
  totalDurationMs: number;
  predictionsPath: string;
  results: SWEBenchRunResult[];
}

/** Clone the repo at base_commit into a fresh workspace (no test_patch). */
function setupWorkspace(instance: SweBenchInstance, workspace: string): boolean {
  const repoUrl = `https://github.com/${instance.repo}.git`;

  spawnSync("git", ["clone", repoUrl, workspace], { encoding: "utf8", timeout: 180_000 });
  if (!existsSync(join(workspace, ".git"))) return false;

  spawnSync("git", ["checkout", instance.base_commit], {
    cwd: workspace, encoding: "utf8", timeout: 60_000,
  });
  spawnSync("git", ["config", "user.email", "agent@projectos"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "ProjectOS"], { cwd: workspace });
  return true;
}

/** Git pathspecs excluding agent-internal dirs and build artifacts, so they
 *  are never staged or diffed (also keeps the binary runs.db out of the diff). */
const DIFF_EXCLUDES = [
  ":(exclude).agent/**",
  ":(exclude).projectos/**",
  ":(exclude)**/node_modules/**",
  ":(exclude)**/__pycache__/**",
  ":(exclude)bun.lock",
  ":(exclude)bun.lockb",
  ":(exclude)*.log",
];

/** Source-only diff of everything the agent changed vs base_commit. */
function extractModelPatch(workspace: string, baseCommit: string): string {
  // Stage everything (incl. new files) so the diff captures untracked work too,
  // but keep agent metadata and build artifacts out of the index.
  spawnSync("git", ["add", "-A", "--", ".", ...DIFF_EXCLUDES], {
    cwd: workspace, encoding: "utf8",
  });
  const r = spawnSync("git", ["diff", baseCommit, "--", ".", ...DIFF_EXCLUDES], {
    cwd: workspace, encoding: "utf8", maxBuffer: 50 * 1024 * 1024,
  });
  if (r.status !== 0) return "";
  // Belt-and-suspenders: also strip test files and any internal sections that
  // slipped past the pathspec (e.g. already-tracked artifacts).
  return stripNonSourceChanges(r.stdout ?? "");
}

/** Run a single instance: solve + extract patch (no scoring). */
export async function runInstance(
  instance: SweBenchInstance,
  modelName: string,
  opts: {
    modelOverride?: string;
    maxIterationsPerState?: number;
    autoSteering?: boolean;
    /** Hard per-instance token ceiling — the only in-run spend guard. */
    tokenBudgetPerInstance?: number;
    /** Where to keep the preserved per-instance trace. */
    outputDir?: string;
  } = {}
): Promise<{ result: SWEBenchRunResult; predictionLine: string | null }> {
  const start = Date.now();
  const workspace = join(tmpdir(), `projectos-swe-${instance.instance_id}-${randomUUID().slice(0, 8)}`);

  let agentState = "error";
  let costUsd = 0;
  let notes = "";
  let patch = "";

  const dbPath = join(workspace, ".projectos", "runs.db");
  const tracePath = join(workspace, ".projectos", "traces.jsonl");

  try {
    if (!setupWorkspace(instance, workspace)) {
      notes = "clone failed";
    } else {
      mkdirSync(join(workspace, ".projectos"), { recursive: true });
      const db = new Database(dbPath, { create: true });
      const { ProjectRun, defaultCreateMessage } = await import("@projectos/core");
      const { computeCost } = await import("@projectos/telemetry");

      const createMessage = await defaultCreateMessage();
      const run = new ProjectRun({
        runId: randomUUID(),
        task: buildTaskPrompt(instance),
        workspace,
        db,
        tracePath,
        createMessage,
        autoYes: true,
        maxIterationsPerState: opts.maxIterationsPerState ?? 15,
        modelOverride: opts.modelOverride ?? process.env.PROJECTOS_MODEL_OVERRIDE,
        autoSteering: opts.autoSteering ?? false,
        // Without this a single instance is unbounded: the suite's cost cap is
        // only checked BETWEEN instances, so on a 1-instance run it never fires.
        tokenBudget: opts.tokenBudgetPerInstance,
      });

      const result = await run.run();
      agentState = result.finalContext.state;
      notes = `state=${agentState} steps=${result.steps}`;
      if (result.finalContext.escalationReason) notes += ` escalation=${result.finalContext.escalationReason}`;
      db.close();

      if (existsSync(tracePath)) {
        const usage = readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean).map((l) => {
          const e = JSON.parse(l);
          return { model: e.model ?? "", inputTokens: e.inputTokens ?? 0, outputTokens: e.outputTokens ?? 0 };
        });
        costUsd = computeCost(usage).totalUsd;
      }

      patch = extractModelPatch(workspace, instance.base_commit);
    }
  } catch (err) {
    notes = `error: ${(err as Error).message}`;
  } finally {
    // Preserve the trace BEFORE deleting the workspace. Without this every run
    // was analysable and then erased, so per-state cost/duration could never be
    // studied after the fact — the data needed to find where spend concentrates.
    try {
      if (existsSync(tracePath)) {
        const keepDir = join(opts.outputDir ?? OUTPUT_DIR, "traces");
        mkdirSync(keepDir, { recursive: true });
        copyFileSync(tracePath, join(keepDir, `${instance.instance_id}.jsonl`));
      }
    } catch {
      // trace preservation is best-effort
    }
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  const producedPatch = patch.trim().length > 0;
  const result: SWEBenchRunResult = {
    instanceId: instance.instance_id,
    repo: instance.repo,
    baseCommit: instance.base_commit,
    producedPatch,
    agentState,
    patchSize: patch.length,
    costUsd,
    durationMs: Date.now() - start,
    notes,
  };

  // Always emit a prediction (empty patch = scored as unresolved by the harness).
  const predictionLine = toPredictionLine(instance.instance_id, modelName, patch);
  return { result, predictionLine };
}

/** Run a suite: produce a predictions.jsonl for the official harness. */
export async function runSWEBenchSuite(
  instances: SweBenchInstance[],
  opts: {
    modelOverride?: string;
    maxIterationsPerState?: number;
    autoSteering?: boolean;
    costCapUsd?: number;
    outputDir?: string;
    tokenBudgetPerInstance?: number;
  } = {}
): Promise<SWEBenchSuiteResult> {
  const outDir = opts.outputDir ?? OUTPUT_DIR;
  mkdirSync(outDir, { recursive: true });

  const modelName = `projectos-${opts.modelOverride ?? process.env.PROJECTOS_MODEL_OVERRIDE ?? "default"}`;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const predictionsPath = join(outDir, `predictions-${timestamp}.jsonl`);
  writeFileSync(predictionsPath, "");

  const costCap = opts.costCapUsd ?? 50;

  // The loop below only checks the cap BETWEEN instances, so on a 1-instance
  // run it can never fire. Derive a per-instance token ceiling from the cap so
  // a single runaway run is bounded too. Observed traces are ~98% input
  // tokens, so pricing the whole budget at the priciest tier the router uses
  // (opus-4-8 input, $5/M) is a deliberately conservative conversion.
  const WORST_CASE_USD_PER_MTOK = 5;
  const perInstanceCap = costCap / Math.max(instances.length, 1);
  const tokenBudgetPerInstance =
    opts.tokenBudgetPerInstance ??
    Math.max(500_000, Math.floor((perInstanceCap / WORST_CASE_USD_PER_MTOK) * 1_000_000));
  console.log(
    `Per-instance token budget: ${tokenBudgetPerInstance.toLocaleString()} ` +
    `(~$${perInstanceCap.toFixed(2)} worst case)`
  );

  const results: SWEBenchRunResult[] = [];
  let totalCost = 0;

  for (const instance of instances) {
    if (totalCost > costCap) {
      console.warn(`Cost cap $${costCap} reached — stopping before ${instance.instance_id}.`);
      break;
    }

    console.log(`\n[${results.length + 1}/${instances.length}] ${instance.instance_id} (${instance.repo})`);
    const { result, predictionLine } = await runInstance(instance, modelName, {
      ...opts,
      tokenBudgetPerInstance,
    });
    results.push(result);
    totalCost += result.costUsd;
    if (predictionLine) appendFileSync(predictionsPath, predictionLine);

    const icon = result.producedPatch ? "✎" : "∅";
    console.log(`  ${icon} ${result.agentState} | patch ${result.patchSize}B | $${result.costUsd.toFixed(4)} | ${Math.round(result.durationMs / 1000)}s | ${result.notes}`);

    // Auth/billing failures are not transient: every remaining instance will
    // fail the same way. Continuing just re-clones large repos for nothing —
    // observed burning 7 matplotlib clones after the credit ran out.
    if (/\b(401|403)\b|insufficient balance|billing_error|invalid[_ ]api[_ ]key|authentication/i.test(result.notes)) {
      console.error(
        `\nAborting suite: provider rejected the request (auth/billing). ` +
        `${results.length}/${instances.length} instances attempted.`
      );
      break;
    }
  }

  const suite: SWEBenchSuiteResult = {
    date: new Date().toISOString(),
    modelName,
    totalInstances: results.length,
    patchesProduced: results.filter((r) => r.producedPatch).length,
    totalCostUsd: totalCost,
    totalDurationMs: results.reduce((s, r) => s + r.durationMs, 0),
    predictionsPath,
    results,
  };

  writeFileSync(join(outDir, `summary-${timestamp}.json`), JSON.stringify(suite, null, 2));
  console.log(`\nPredictions written to ${predictionsPath}`);

  return suite;
}

export function formatSummary(suite: SWEBenchSuiteResult): string {
  return [
    `SWE-bench Lite — ProjectOS (solve phase)`,
    `Date:        ${suite.date}`,
    `Model:       ${suite.modelName}`,
    `Instances:   ${suite.totalInstances}`,
    `Patches:     ${suite.patchesProduced} / ${suite.totalInstances} produced a source diff`,
    `Total cost:  $${suite.totalCostUsd.toFixed(4)}`,
    `Total time:  ${Math.round(suite.totalDurationMs / 60000)}m`,
    `Predictions: ${suite.predictionsPath}`,
    "",
    `Next: score with the official Docker harness:`,
    `  bash evals/swe-bench/run-official-eval.sh ${suite.predictionsPath}`,
  ].join("\n");
}
