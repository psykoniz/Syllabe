import { Command } from "commander";
import { ProjectSession } from "@projectos/core";

export const runCommand = new Command("run")
  .description("Start a new ProjectOS agent run")
  .requiredOption("--agent-id <id>", "Managed agent ID")
  .requiredOption("--environment-id <id>", "Managed environment ID")
  .requiredOption("--prompt <text>", "Initial user prompt")
  .option("--db <path>", "SQLite database path", ".projectos/runs.db")
  .option("--traces <path>", "JSONL trace log path", ".projectos/traces.jsonl")
  .action(async (opts) => {
    const session = new ProjectSession({
      agentId: opts.agentId,
      environmentId: opts.environmentId,
      dbPath: opts.db,
      tracePath: opts.traces,
    });

    console.log(`Starting run ${session.runId} …`);
    try {
      await session.start(opts.prompt);
      const record = session.getRecord();
      console.log(`Run complete. Session ID: ${record?.sessionId}`);
    } catch (err) {
      console.error("Run failed:", err);
      process.exit(1);
    } finally {
      session.close();
    }
  });
