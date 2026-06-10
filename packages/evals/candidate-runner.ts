import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import type { CandidateConfig } from "@projectos/agents";
import type { BenchmarkTask, BenchmarkResult } from "./benchmark-runner";
import { BenchmarkRunner } from "./benchmark-runner";

export interface CandidateRun {
  id: string;
  config: CandidateConfig;
  result: BenchmarkResult;
}

export interface CandidateRunnerOptions {
  outputDir: string;
  runsPerTask?: number;
  costCapUsd?: number;
}

/** Runs a benchmark with a candidate config distinct from baseline */
export class CandidateRunner {
  constructor(
    private tasks: BenchmarkTask[],
    private opts: CandidateRunnerOptions
  ) {}

  async run(candidateId: string, config: CandidateConfig): Promise<CandidateRun> {
    const outDir = join(this.opts.outputDir, `candidate-${candidateId}`);
    mkdirSync(outDir, { recursive: true });

    // Persist the candidate config alongside results
    writeFileSync(join(outDir, "candidate-config.json"), JSON.stringify(config, null, 2), "utf8");

    const runner = new BenchmarkRunner(this.tasks, {
      outputDir: outDir,
      runsPerTask: this.opts.runsPerTask ?? 3,
      costCapUsd: this.opts.costCapUsd ?? 15,
      storeBaseline: false,
    });

    const result = await runner.run();
    return { id: candidateId, config, result };
  }

  loadConfig(candidateId: string): CandidateConfig | null {
    const configPath = join(this.opts.outputDir, `candidate-${candidateId}`, "candidate-config.json");
    if (!existsSync(configPath)) return null;
    try {
      return JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      return null;
    }
  }
}
