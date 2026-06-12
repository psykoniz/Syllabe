/**
 * SWE-bench Lite runner for ProjectOS.
 *
 * Maps each SWE-bench instance to a ProjectOS run using --repo mode:
 * - clones the repo at base_commit
 * - gives the agent the problem statement as the task
 * - verifies FAIL_TO_PASS / PASS_TO_PASS after the run
 *
 * Usage:
 *   bun evals/swe-bench/run.ts [--limit 10] [--offset 0] [--repo astropy/astropy]
 *   bun evals/swe-bench/run.ts --instance-id astropy__astropy-12907
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { Database } from "bun:sqlite";
import { spawnSync } from "child_process";
import { loadSweBenchLite, buildTaskPrompt } from "./loader";
import { verifySWEBench } from "./verifier";
import type { SweBenchInstance } from "./loader";

const OUTPUT_DIR = "evals/results/swe-bench";

export interface SWEBenchRunResult {
  instanceId: string;
  repo: string;
  baseCommit: string;
  passed: boolean;
  agentState: string;
  verifyOutput: string;
  failToPassResults: Record<string, boolean>;
  passToPassResults: Record<string, boolean>;
  costUsd: number;
  durationMs: number;
  notes: string;
}

export interface SWEBenchSuiteResult {
  date: string;
  totalInstances: number;
  resolved: number;
  resolvedRate: number;
  totalCostUsd: number;
  totalDurationMs: number;
  results: SWEBenchRunResult[];
}

/** Clone the repo at the base_commit into a fresh workspace. */
async function setupWorkspace(instance: SweBenchInstance, workspace: string): Promise<boolean> {
  const repoUrl = `https://github.com/${instance.repo}.git`;

  spawnSync("git", ["clone", "--depth=100", repoUrl, workspace], {
    encoding: "utf8",
    timeout: 120_000,
  });

  if (!existsSync(join(workspace, ".git"))) return false;

  // Checkout the base commit (before the fix)
  spawnSync("git", ["checkout", instance.base_commit], {
    cwd: workspace, encoding: "utf8", timeout: 30_000,
  });

  // Apply the test patch so FAIL_TO_PASS tests exist (they fail at base_commit)
  if (instance.test_patch) {
    spawnSync("git", ["apply", "--whitespace=nowarn"],
      { cwd: workspace, encoding: "utf8", input: instance.test_patch, timeout: 30_000 }
    );
  }

  // Configure git identity for the agent's commits
  spawnSync("git", ["config", "user.email", "agent@projectos"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "ProjectOS"], { cwd: workspace });

  return true;
}

/** Run a single SWE-bench instance through ProjectOS. */
export async function runInstance(
  instance: SweBenchInstance,
  opts: {
    modelOverride?: string;
    maxIterationsPerState?: number;
    autoSteering?: boolean;
    timeoutMs?: number;
  } = {}
): Promise<SWEBenchRunResult> {
  const start = Date.now();
  const workspace = `/tmp/projectos-swe-${instance.instance_id}-${randomUUID().slice(0, 8)}`;
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(workspace, ".projectos"), { recursive: true });

  let passed = false;
  let agentState = "error";
  let verifyOutput = "";
  let failToPassResults: Record<string, boolean> = {};
  let passToPassResults: Record<string, boolean> = {};
  let costUsd = 0;
  let notes = "";

  const dbPath = join(workspace, ".projectos", "runs.db");
  const tracePath = join(workspace, ".projectos", "traces.jsonl");

  try {
    // Clone repo at base_commit + apply test patch
    const setupOk = await setupWorkspace(instance, workspace);
    if (!setupOk) {
      notes = "clone failed";
      return { instanceId: instance.instance_id, repo: instance.repo, baseCommit: instance.base_commit,
        passed: false, agentState: "error", verifyOutput: "clone failed",
        failToPassResults: {}, passToPassResults: {}, costUsd: 0,
        durationMs: Date.now() - start, notes };
    }

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
      maxIterationsPerState: opts.maxIterationsPerState ?? 25,
      modelOverride: opts.modelOverride ?? process.env.PROJECTOS_MODEL_OVERRIDE,
      autoSteering: opts.autoSteering ?? false,
    });

    const result = await run.run();
    agentState = result.finalContext.state;
    notes = `state=${agentState} steps=${result.steps}`;
    if (result.finalContext.escalationReason) {
      notes += ` escalation=${result.finalContext.escalationReason}`;
    }

    db.close();

    // Compute cost from traces
    if (existsSync(tracePath)) {
      const lines = readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean);
      const usage = lines.map((l) => {
        const e = JSON.parse(l);
        return { model: e.model ?? "", inputTokens: e.inputTokens ?? 0, outputTokens: e.outputTokens ?? 0 };
      });
      costUsd = computeCost(usage).totalUsd;
    }

    // Verify if agent reached COMPLETE
    if (agentState === "COMPLETE") {
      const verifyResult = await verifySWEBench(workspace, instance, opts.timeoutMs ?? 300_000);
      passed = verifyResult.passed;
      verifyOutput = verifyResult.output;
      failToPassResults = verifyResult.failToPassResults;
      passToPassResults = verifyResult.passToPassResults;
      if (!passed) notes += " verify=FAILED";
    }
  } catch (err) {
    notes = `error: ${(err as Error).message}`;
  } finally {
    // Clean up workspace to save disk space
    spawnSync("rm", ["-rf", workspace]);
  }

  return {
    instanceId: instance.instance_id,
    repo: instance.repo,
    baseCommit: instance.base_commit,
    passed,
    agentState,
    verifyOutput,
    failToPassResults,
    passToPassResults,
    costUsd,
    durationMs: Date.now() - start,
    notes,
  };
}

/** Run a suite of SWE-bench instances and save results. */
export async function runSWEBenchSuite(
  instances: SweBenchInstance[],
  opts: {
    modelOverride?: string;
    maxIterationsPerState?: number;
    autoSteering?: boolean;
    costCapUsd?: number;
    outputDir?: string;
    concurrency?: number;
  } = {}
): Promise<SWEBenchSuiteResult> {
  const outDir = opts.outputDir ?? OUTPUT_DIR;
  mkdirSync(outDir, { recursive: true });

  const costCap = opts.costCapUsd ?? 50;
  const results: SWEBenchRunResult[] = [];
  let totalCost = 0;
  let abortedAt: string | undefined;

  // Run instances sequentially by default (concurrency = 1)
  // Parallel mode can be enabled but needs careful resource management
  const concurrency = opts.concurrency ?? 1;

  if (concurrency === 1) {
    for (const instance of instances) {
      if (totalCost > costCap) {
        console.warn(`Cost cap $${costCap} reached at ${instance.instance_id} — stopping.`);
        abortedAt = instance.instance_id;
        break;
      }

      console.log(`\n[${results.length + 1}/${instances.length}] ${instance.instance_id} (${instance.repo})`);
      const result = await runInstance(instance, opts);
      results.push(result);
      totalCost += result.costUsd;

      const icon = result.passed ? "✓" : result.agentState === "COMPLETE" ? "✗" : "~";
      console.log(`  ${icon} ${result.agentState} | $${result.costUsd.toFixed(4)} | ${Math.round(result.durationMs / 1000)}s | ${result.notes}`);
    }
  } else {
    // Chunked parallel execution
    for (let i = 0; i < instances.length; i += concurrency) {
      if (totalCost > costCap) break;
      const chunk = instances.slice(i, i + concurrency);
      const chunkResults = await Promise.all(chunk.map((inst) => runInstance(inst, opts)));
      results.push(...chunkResults);
      totalCost += chunkResults.reduce((s, r) => s + r.costUsd, 0);
    }
  }

  const resolved = results.filter((r) => r.passed).length;
  const suite: SWEBenchSuiteResult = {
    date: new Date().toISOString(),
    totalInstances: results.length,
    resolved,
    resolvedRate: results.length > 0 ? resolved / results.length : 0,
    totalCostUsd: totalCost,
    totalDurationMs: results.reduce((s, r) => s + r.durationMs, 0),
    results,
  };

  // Save results
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = join(outDir, `results-${timestamp}.json`);
  writeFileSync(outPath, JSON.stringify(suite, null, 2));

  // Save summary table
  const tablePath = join(outDir, `results-${timestamp}-table.txt`);
  writeFileSync(tablePath, formatSWEBenchTable(suite));

  console.log(`\nResults saved to ${outPath}`);

  return suite;
}

export function formatSWEBenchTable(suite: SWEBenchSuiteResult): string {
  const lines = [
    `SWE-bench Lite — ProjectOS`,
    `Date:       ${suite.date}`,
    `Instances:  ${suite.totalInstances}`,
    `Resolved:   ${suite.resolved} / ${suite.totalInstances} (${(suite.resolvedRate * 100).toFixed(1)}%)`,
    `Total cost: $${suite.totalCostUsd.toFixed(4)}`,
    `Total time: ${Math.round(suite.totalDurationMs / 60000)}m`,
    "",
    `${"Instance".padEnd(50)} ${"Repo".padEnd(30)} ${"State".padEnd(12)} ${"Pass".padEnd(6)} Cost`,
    "─".repeat(110),
    ...suite.results.map((r) =>
      `${r.instanceId.slice(0, 49).padEnd(50)} ${r.repo.padEnd(30)} ${r.agentState.padEnd(12)} ${(r.passed ? "✓" : "✗").padEnd(6)} $${r.costUsd.toFixed(4)}`
    ),
  ];
  return lines.join("\n");
}
