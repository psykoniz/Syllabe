/** One-off runner for the hard tasks (06-07) — separate output, no baseline write. */
import { mkdirSync } from "fs";
import { BenchmarkRunner } from "@projectos/evals";
import { task06SubtleBug } from "./tasks/task-06-subtle-bug";
import { task07Refactor } from "./tasks/task-07-refactor";

const outputDir = "evals/results/hard-tasks";
mkdirSync(outputDir, { recursive: true });

const runner = new BenchmarkRunner([task06SubtleBug, task07Refactor], {
  outputDir,
  runsPerTask: parseInt(process.env.RUNS ?? "3", 10),
  costCapUsd: parseFloat(process.env.COST_CAP ?? "6"),
  storeBaseline: false,
});

const result = await runner.run();
console.log(`\nScores: ${result.scoresFile}`);
console.log(`Total cost: $${result.totalCostUsd.toFixed(4)}`);
if (result.abortedByCapAt) console.warn(`Aborted by cap at: ${result.abortedByCapAt}`);
