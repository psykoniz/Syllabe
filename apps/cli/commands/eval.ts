import { Command } from "commander";
import { mkdirSync } from "fs";
import { join } from "path";
import { BenchmarkRunner, BaselineStore } from "@projectos/evals";

export const evalCommand = new Command("eval")
  .description("Run the eval suite and compare against baseline")
  .addCommand(
    new Command("run")
      .description("Execute benchmark tasks and write scores.json")
      .option("--output <dir>", "Output directory for results", "evals/results")
      .option("--runs <n>", "Repetitions per task", "3")
      .option("--cost-cap <usd>", "Hard cost cap in USD", "15")
      .option("--no-baseline", "Skip storing result as new baseline")
      .action(async (opts) => {
        const date = new Date().toISOString().slice(0, 10);
        const outputDir = join(opts.output, date);
        mkdirSync(outputDir, { recursive: true });

        // Dynamically import task definitions to keep CLI startup fast
        const { task00Smoke } = await import("../../../evals/tasks/task-00-smoke");
        const { task01TodoApp } = await import("../../../evals/tasks/task-01-todo-app");
        const { task02Stripe } = await import("../../../evals/tasks/task-02-stripe");
        const { task03BugFix } = await import("../../../evals/tasks/task-03-bug-fix");
        const { task04Playwright } = await import("../../../evals/tasks/task-04-playwright");
        const { task05LandingPage } = await import("../../../evals/tasks/task-05-landing-page");

        const tasks = [task00Smoke, task01TodoApp, task02Stripe, task03BugFix, task04Playwright, task05LandingPage];

        console.log(`\nProjectOS eval run — ${tasks.length} tasks × ${opts.runs} reps — cap $${opts.costCap}`);
        console.log(`Output: ${outputDir}\n`);

        const runner = new BenchmarkRunner(tasks, {
          outputDir,
          runsPerTask: parseInt(opts.runs, 10),
          costCapUsd: parseFloat(opts.costCap),
          storeBaseline: opts.baseline !== false,
        });

        const result = await runner.run();

        console.log(`\nScores written to: ${result.scoresFile}`);
        console.log(`Total cost: $${result.totalCostUsd.toFixed(4)}`);
        if (result.abortedByCapAt) {
          console.warn(`\nAborted by cost cap at task: ${result.abortedByCapAt}`);
          process.exit(2);
        }
      })
  )
  .addCommand(
    new Command("compare")
      .description("Compare latest results against stored baseline")
      .option("--baseline <path>", "Baseline file", "evals/results/baseline.json")
      .option("--scores <path>", "Scores file to compare against baseline")
      .action(async (opts) => {
        const { aggregateScores, formatScoreTable } = await import("@projectos/evals");
        const { readFileSync, existsSync } = await import("fs");

        if (!existsSync(opts.baseline)) {
          console.error("No baseline found. Run `projectos eval run` first.");
          process.exit(1);
        }

        const store = new BaselineStore(opts.baseline);
        const latest = store.latest();
        if (!latest) {
          console.error("Baseline file is empty or corrupt.");
          process.exit(1);
        }

        if (!opts.scores) {
          console.log("\nCurrent baseline:\n");
          console.log(formatScoreTable(latest.scores));
          return;
        }

        if (!existsSync(opts.scores)) {
          console.error(`Scores file not found: ${opts.scores}`);
          process.exit(1);
        }

        const { scores } = JSON.parse(readFileSync(opts.scores, "utf8")) as { scores: import("@projectos/evals").TaskScore[] };
        const candidate = aggregateScores(scores);

        console.log("\nBaseline:\n");
        console.log(formatScoreTable(latest.scores));
        console.log("\nCandidate:\n");
        console.log(formatScoreTable(candidate));

        const regressions = candidate.filter((c) => {
          const b = latest.scores.find((x) => x.taskId === c.taskId);
          return b && c.passRate < b.passRate;
        });

        if (regressions.length > 0) {
          console.warn(`\nRegressions detected in: ${regressions.map((r) => r.taskId).join(", ")}`);
          process.exit(1);
        } else {
          console.log("\nNo regressions detected.");
        }
      })
  );
