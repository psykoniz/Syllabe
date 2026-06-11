import { Command } from "commander";
import { ProjectSession } from "@projectos/core";
import { readFileSync, existsSync } from "fs";
import { computeCost } from "@projectos/telemetry";
import type { TraceEvent } from "@projectos/telemetry";

export const reportCommand = new Command("report")
  .description("Show cost and status report for all runs")
  .option("--db <path>", "SQLite database path", ".projectos/runs.db")
  .option("--traces <path>", "JSONL trace log path", ".projectos/traces.jsonl")
  .action((opts) => {
    const session = new ProjectSession({
      model: "report",
      workspace: process.cwd(),
      dbPath: opts.db,
      tracePath: opts.traces,
    });

    try {
      const runs = session.listRuns();
      if (runs.length === 0) {
        console.log("No runs found.");
        return;
      }

      console.log(`\n${"Run ID".padEnd(38)} ${"Status".padEnd(10)} ${"Model"}`);
      console.log("─".repeat(80));
      for (const r of runs) {
        console.log(`${r.runId.padEnd(38)} ${r.status.padEnd(10)} ${r.model}`);
      }

      if (existsSync(opts.traces)) {
        const lines = readFileSync(opts.traces, "utf8").trim().split("\n").filter(Boolean);
        const usage = lines.map((l) => {
          const e = JSON.parse(l) as TraceEvent;
          return { model: e.model, inputTokens: e.inputTokens, outputTokens: e.outputTokens };
        });
        const { totalUsd, byModel } = computeCost(usage);
        console.log("\nCost breakdown:");
        for (const [model, data] of Object.entries(byModel)) {
          console.log(`  ${model}: $${data.usd.toFixed(4)} (in: ${data.inputTokens}, out: ${data.outputTokens})`);
        }
        console.log(`  Total: $${totalUsd.toFixed(4)}`);
      }
    } finally {
      session.close();
    }
  });
