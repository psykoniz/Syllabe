import { Command } from "commander";
import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { Database } from "bun:sqlite";
import { ProjectRun, defaultCreateMessage } from "@projectos/core";
import { ensureRunMetaTable, setRunMeta, loadPromotedConfig, redactGitUrl } from "@projectos/core";
import { autoApprove, interactiveApproval } from "@projectos/policy";

export const buildCommand = new Command("build")
  .description("Run the full ProjectOS state machine for a task")
  .requiredOption("--task <text>", "Task description")
  .option("--workspace <path>", "Workspace directory", process.cwd())
  .option("--db <path>", "SQLite database path", ".projectos/runs.db")
  .option("--traces <path>", "JSONL trace log path", ".projectos/traces.jsonl")
  .option("--max-iterations <n>", "Max agent iterations per state", "20")
  .option("--yes", "Apply all interview defaults (non-interactive)", false)
  .option("--model-override <id>", "Force all role calls to use this model (e.g. claude-sonnet-4-6)")
  .option("--sandbox", "Run bash commands in a Docker sandbox (requires Docker)", false)
  .option("--sandbox-image <image>", "Docker image for the sandbox", "node:20-alpine")
  .option("--browser-tools", "Enable Playwright browser automation tools", false)
  .option("--parallel <n>", "Run work units concurrently with this concurrency (>=2 enables)", "0")
  .option("--repo <url-or-path>", "Existing git repository to work on (URL or local path)")
  .option("--base-branch <name>", "Base branch to clone from", "main")
  .option("--harness-dir <path>", "Harness dir with promoted config (promotions.json)", "~/.projectos/harness")
  .action(async (opts) => {
    // PROJECTOS_RUN_ID lets a parent process (e.g. the web UI) pre-assign the
    // run id so it can track the run it just launched.
    const runId = process.env.PROJECTOS_RUN_ID ?? randomUUID();
    mkdirSync(dirname(opts.db), { recursive: true });
    const db = new Database(opts.db, { create: true });
    ensureRunMetaTable(db);
    setRunMeta(db, runId, "task", opts.task);
    setRunMeta(db, runId, "model", opts.modelOverride ?? "default");
    setRunMeta(db, runId, "startedAt", new Date().toISOString());

    const workBranch = opts.repo ? `projectos/run-${runId.slice(0, 8)}` : undefined;
    if (opts.repo) {
      setRunMeta(db, runId, "git_url", redactGitUrl(opts.repo));
      setRunMeta(db, runId, "base_branch", opts.baseBranch);
      setRunMeta(db, runId, "work_branch", workBranch!);
    }

    console.log(`\nProjectOS build — run ${runId}`);
    console.log(`Workspace: ${opts.workspace}`);
    if (opts.repo) {
      console.log(`Repository: ${redactGitUrl(opts.repo)} (base: ${opts.baseBranch}, work branch: ${workBranch})`);
    }
    console.log(`Task: ${opts.task}\n`);

    const createMessage = await defaultCreateMessage();

    // Apply config promoted by the self-improvement loop (and not rolled
    // back) so validated improvements reach normal builds, not just evals.
    const harnessDir = opts.harnessDir.replace(/^~/, process.env.HOME ?? "~");
    const promoted = loadPromotedConfig(harnessDir);
    if (promoted.loopBounds || promoted.systemPrompts) {
      console.log("Applying promoted harness config:", JSON.stringify(promoted).slice(0, 120));
    }

    const run = new ProjectRun({
      runId,
      task: opts.task,
      workspace: opts.workspace,
      db,
      tracePath: opts.traces,
      createMessage,
      approval: opts.yes ? autoApprove : interactiveApproval,
      autoYes: opts.yes,
      maxIterationsPerState: parseInt(opts.maxIterations, 10),
      modelOverride: opts.modelOverride,
      loopBounds: promoted.loopBounds
        ? { maxRepair: 3, maxReview: 2, ...promoted.loopBounds }
        : undefined,
      systemPromptOverrides: promoted.systemPrompts,
      sandbox: opts.sandbox,
      sandboxImage: opts.sandboxImage,
      browserTools: opts.browserTools,
      parallelWorkUnits: parseInt(opts.parallel, 10) || undefined,
      gitUrl: opts.repo,
      baseBranch: opts.baseBranch,
      workBranch,
    });

    try {
      const result = await run.run();
      console.log(`\nBuild complete — state: ${result.finalContext.state}, steps: ${result.steps}`);
      if (result.finalContext.escalationReason) {
        console.error(`Escalation: ${result.finalContext.escalationReason}`);
      }
    } catch (err) {
      console.error("Build failed:", err);
      process.exit(1);
    } finally {
      db.close();
    }
  });
