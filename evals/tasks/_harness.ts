/**
 * Shared harness runner for eval tasks.
 * When ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY is set, spins up a real ProjectRun.
 * Otherwise returns a "skip" result so CI doesn't fail without credentials.
 */
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { Database } from "bun:sqlite";
import type { TaskScore } from "@projectos/evals";

export type EvalRunOpts = {
  taskId: string;
  task: string;
  costCapUsd?: number;
  pendingLabels?: string[];
  /** Force all role calls to this model (avoids fable 503s) */
  modelOverride?: string;
  /** Loop bounds override (e.g. from a candidate config under benchmark) */
  loopBounds?: { maxRepair: number; maxReview: number };
};

/** Sum cost across all trace events using the telemetry price table */
function computeCostFromTraces(tracePath: string): number {
  if (!existsSync(tracePath)) return 0;
  try {
    const { computeCost } = require("@projectos/telemetry");
    const lines = readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean);
    const usage = lines.map((l: string) => {
      const e = JSON.parse(l);
      return { model: e.model, inputTokens: e.inputTokens ?? 0, outputTokens: e.outputTokens ?? 0 };
    });
    return computeCost(usage).totalUsd;
  } catch {
    return 0;
  }
}

/** Read loop bounds from PROJECTOS_LOOP_BOUNDS env (JSON, e.g. '{"maxRepair":3,"maxReview":3}') */
function envLoopBounds(): { maxRepair: number; maxReview: number } | undefined {
  const raw = process.env.PROJECTOS_LOOP_BOUNDS;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.maxRepair === "number" && typeof parsed.maxReview === "number") return parsed;
  } catch {
    // ignore malformed env
  }
  return undefined;
}

export async function runEvalTask(opts: EvalRunOpts): Promise<Omit<TaskScore, "taskId" | "runIndex">> {
  const hasCredentials = !!(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY);

  if (!hasCredentials) {
    return {
      passed: false,
      costUsd: 0,
      durationMs: 0,
      secretsLeaked: false,
      notes: "skip — no API credentials in environment",
      pendingLabels: opts.pendingLabels ?? [],
    };
  }

  const workspace = `/tmp/projectos-eval-${opts.taskId}-${randomUUID()}`;
  mkdirSync(workspace, { recursive: true });

  const { spawnSync } = await import("child_process");
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace });
  spawnSync("git", ["config", "user.email", "eval@projectos"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "ProjectOS Eval"], { cwd: workspace });

  const { ProjectRun, defaultCreateMessage } = await import("@projectos/core");
  const dbPath = join(workspace, ".projectos", "runs.db");
  mkdirSync(join(workspace, ".projectos"), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.run(`CREATE TABLE IF NOT EXISTS agent_loop_runs (
    run_id TEXT PRIMARY KEY, state TEXT NOT NULL,
    work_unit_index INTEGER NOT NULL DEFAULT 0,
    repair_count INTEGER NOT NULL DEFAULT 0,
    steps INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);

  const start = Date.now();
  let passed = false;
  let secretsLeaked = false;
  let notes = "";
  let costUsd = 0;
  const tracePath = join(workspace, ".projectos", "traces.jsonl");

  try {
    const createMessage = await defaultCreateMessage();
    const run = new ProjectRun({
      runId: randomUUID(),
      task: opts.task,
      workspace,
      db,
      tracePath,
      createMessage,
      autoYes: true,
      maxIterationsPerState: 20,
      modelOverride: opts.modelOverride ?? process.env.PROJECTOS_MODEL_OVERRIDE,
      loopBounds: opts.loopBounds ?? envLoopBounds(),
    });

    const result = await run.run();
    passed = result.finalContext.state === "COMPLETE";
    notes = `state=${result.finalContext.state} steps=${result.steps}`;
    if (result.finalContext.escalationReason) {
      notes += ` escalation=${result.finalContext.escalationReason}`;
    }
  } catch (err) {
    notes = `error: ${(err as Error).message}`;
  } finally {
    costUsd = computeCostFromTraces(tracePath);
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }

  return {
    passed,
    costUsd,
    durationMs: Date.now() - start,
    secretsLeaked,
    notes,
    pendingLabels: opts.pendingLabels ?? [],
  };
}
