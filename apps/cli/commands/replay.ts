import { Command } from "commander";
import { replayRun, listRunIds } from "@projectos/telemetry";

export const replayCommand = new Command("replay")
  .description("Replay a past run's timeline from its JSONL transcripts")
  .argument("[runId]", "Run ID to replay (omit to list available runs)")
  .option("--traces <path>", "JSONL trace log path", ".projectos/traces.jsonl")
  .option("--tool-calls <path>", "JSONL tool call log path", ".projectos/tool-calls.jsonl")
  .option("--no-tools", "Hide tool calls, show only LLM phase events")
  .action((runId: string | undefined, opts) => {
    if (!runId) {
      const ids = listRunIds(opts.traces);
      if (ids.length === 0) {
        console.log("No runs found in", opts.traces);
        return;
      }
      console.log("\nAvailable runs (most recent first):");
      for (const id of ids) console.log(`  ${id}`);
      console.log("\nUsage: projectos replay <runId>");
      return;
    }

    const session = replayRun(opts.traces, runId, opts.tools ? opts.toolCalls : undefined);
    if (!session) {
      console.error(`Run ${runId} not found in ${opts.traces}`);
      process.exit(1);
    }

    console.log(`\nReplay — run ${session.runId}`);
    console.log(`Started:  ${session.startedAt}`);
    console.log(`Ended:    ${session.endedAt}`);
    console.log(`Phases:   ${session.phases.join(" → ")}`);
    console.log(`Duration: ${(session.totalDurationMs / 1000).toFixed(1)}s (sum of step durations)`);
    console.log(`Cost:     $${session.cost.totalUsd.toFixed(4)}\n`);

    console.log("Timeline:");
    for (const step of session.steps) {
      const time = step.ts.slice(11, 19);
      const marker = step.kind === "trace" ? "◆" : "·";
      const dur = step.durationMs ? ` [${(step.durationMs / 1000).toFixed(1)}s]` : "";
      console.log(`  ${time} ${marker} ${step.label.padEnd(12)} ${step.detail}${dur}`);
    }
  });
