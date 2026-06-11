import { Command } from "commander";
import { ProjectSession } from "@projectos/core";
import { MODEL_IDS } from "@projectos/router";
import { autoApprove, interactiveApproval } from "@projectos/policy";

export const runCommand = new Command("run")
  .description("Start a new ProjectOS agent run")
  .requiredOption("--prompt <text>", "Initial user prompt")
  .option("--model <id>", "Model ID", MODEL_IDS.sonnet)
  .option("--workspace <path>", "Workspace directory (cwd lock for tools)", process.cwd())
  .option("--db <path>", "SQLite database path", ".projectos/runs.db")
  .option("--traces <path>", "JSONL trace log path", ".projectos/traces.jsonl")
  .option("--max-iterations <n>", "Max agent loop iterations", "50")
  .option("--yes", "Auto-approve all 'ask' permission prompts", false)
  .action(async (opts) => {
    const session = new ProjectSession({
      model: opts.model,
      workspace: opts.workspace,
      dbPath: opts.db,
      tracePath: opts.traces,
      maxIterations: parseInt(opts.maxIterations, 10),
      approval: opts.yes ? autoApprove : interactiveApproval,
    });

    console.log(`Starting run ${session.runId} (model: ${opts.model}) …`);
    try {
      const result = await session.start(opts.prompt);
      console.log(`\n${result.finalText}\n`);
      console.log(
        `Run complete — ${result.turns} turn(s), ` +
          `${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens ` +
          `(stop: ${result.stopReason})`
      );
    } catch (err) {
      console.error("Run failed:", err);
      process.exit(1);
    } finally {
      session.close();
    }
  });
