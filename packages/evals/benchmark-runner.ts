import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { TaskScore } from "./scorers";
import { aggregateScores, formatScoreTable } from "./scorers";
import { BaselineStore } from "./baseline";

export interface BenchmarkTask {
  id: string;
  description: string;
  /** Run the task once; return score data */
  run(): Promise<Omit<TaskScore, "taskId" | "runIndex">>;
}

export interface BenchmarkRunnerOptions {
  outputDir: string;
  runsPerTask?: number;    // default 3
  costCapUsd?: number;     // default 15; runner aborts past cap
  storeBaseline?: boolean; // default true
}

export interface BenchmarkResult {
  date: string;
  scoresFile: string;
  scores: TaskScore[];
  abortedByCapAt?: string;
  totalCostUsd: number;
}

export class BenchmarkRunner {
  private runsPerTask: number;
  private costCapUsd: number;
  private storeBaseline: boolean;

  constructor(
    private tasks: BenchmarkTask[],
    private opts: BenchmarkRunnerOptions
  ) {
    this.runsPerTask = opts.runsPerTask ?? 3;
    this.costCapUsd = opts.costCapUsd ?? 15;
    this.storeBaseline = opts.storeBaseline ?? true;
  }

  async run(): Promise<BenchmarkResult> {
    const date = new Date().toISOString();
    mkdirSync(this.opts.outputDir, { recursive: true });

    const scores: TaskScore[] = [];
    let totalCostUsd = 0;
    let abortedByCapAt: string | undefined;

    outer: for (const task of this.tasks) {
      for (let i = 0; i < this.runsPerTask; i++) {
        if (totalCostUsd >= this.costCapUsd) {
          abortedByCapAt = task.id;
          break outer;
        }
        const result = await task.run();
        const score: TaskScore = { taskId: task.id, runIndex: i, ...result };
        scores.push(score);
        totalCostUsd += score.costUsd;
      }
    }

    const scoresFile = join(this.opts.outputDir, "scores.json");
    writeFileSync(scoresFile, JSON.stringify({ date, scores, totalCostUsd, abortedByCapAt }, null, 2), "utf8");

    const aggregates = aggregateScores(scores);
    const tableFile = join(this.opts.outputDir, "scores-table.txt");
    writeFileSync(tableFile, formatScoreTable(aggregates), "utf8");

    if (this.storeBaseline && scores.length > 0) {
      const baselineFile = join(this.opts.outputDir, "..", "baseline.json");
      const store = new BaselineStore(baselineFile);
      store.store(aggregates);
    }

    return { date, scoresFile, scores, abortedByCapAt, totalCostUsd };
  }
}
