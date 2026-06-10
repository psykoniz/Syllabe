import { Command } from "commander";
import { ProjectSession } from "@projectos/core";

export const resumeCommand = new Command("resume")
  .description("Resume an existing session with a follow-up message")
  .requiredOption("--agent-id <id>", "Managed agent ID")
  .requiredOption("--environment-id <id>", "Managed environment ID")
  .requiredOption("--session-id <id>", "Session ID to resume")
  .requiredOption("--message <text>", "Follow-up message")
  .option("--db <path>", "SQLite database path", ".projectos/runs.db")
  .option("--traces <path>", "JSONL trace log path", ".projectos/traces.jsonl")
  .action(async (opts) => {
    const session = new ProjectSession({
      agentId: opts.agentId,
      environmentId: opts.environmentId,
      dbPath: opts.db,
      tracePath: opts.traces,
    });

    console.log(`Resuming session ${opts.sessionId} …`);
    try {
      await session.resume(opts.sessionId, opts.message);
      console.log("Resume complete.");
    } catch (err) {
      console.error("Resume failed:", err);
      process.exit(1);
    } finally {
      session.close();
    }
  });
