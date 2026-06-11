import { Command } from "commander";
import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { Database } from "bun:sqlite";
import { ProjectRun } from "@projectos/core";
import { MODEL_IDS } from "@projectos/router";
import { autoApprove, interactiveApproval } from "@projectos/policy";

async function getCreateMessage() {
  // Dynamic import keeps the SDK out of the type graph for this package
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { default: Anthropic } = await import("@anthropic-ai/sdk" as any);
  const client = new Anthropic();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (params: any) => client.messages.create(params) as any;
}

export const buildCommand = new Command("build")
  .description("Run the full ProjectOS state machine for a task")
  .requiredOption("--task <text>", "Task description")
  .option("--workspace <path>", "Workspace directory", process.cwd())
  .option("--db <path>", "SQLite database path", ".projectos/runs.db")
  .option("--traces <path>", "JSONL trace log path", ".projectos/traces.jsonl")
  .option("--max-iterations <n>", "Max agent iterations per state", "20")
  .option("--yes", "Apply all interview defaults (non-interactive)", false)
  .action(async (opts) => {
    const runId = randomUUID();
    mkdirSync(dirname(opts.db), { recursive: true });
    const db = new Database(opts.db, { create: true });

    console.log(`\nProjectOS build — run ${runId}`);
    console.log(`Workspace: ${opts.workspace}`);
    console.log(`Task: ${opts.task}\n`);

    const createMessage = await getCreateMessage();

    const run = new ProjectRun({
      runId,
      task: opts.task,
      workspace: opts.workspace,
      db,
      tracePath: opts.traces,
      createMessage: createMessage as never,
      approval: opts.yes ? autoApprove : interactiveApproval,
      autoYes: opts.yes,
      maxIterationsPerState: parseInt(opts.maxIterations, 10),
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
