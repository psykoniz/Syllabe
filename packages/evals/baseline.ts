import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { AggregateScore } from "./scorers";

export interface BaselineEntry {
  version: number;
  date: string;
  scores: AggregateScore[];
}

const MAX_BASELINES = 3;

export class BaselineStore {
  private baselines: BaselineEntry[] = [];

  constructor(private filePath: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      this.baselines = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      this.baselines = [];
    }
  }

  store(scores: AggregateScore[]): BaselineEntry {
    const version = (this.baselines[this.baselines.length - 1]?.version ?? 0) + 1;
    const entry: BaselineEntry = { version, date: new Date().toISOString(), scores };
    this.baselines.push(entry);
    // Keep only the last MAX_BASELINES
    if (this.baselines.length > MAX_BASELINES) {
      this.baselines = this.baselines.slice(-MAX_BASELINES);
    }
    this.persist();
    return entry;
  }

  latest(): BaselineEntry | null {
    return this.baselines[this.baselines.length - 1] ?? null;
  }

  all(): BaselineEntry[] {
    return [...this.baselines];
  }

  /** Roll back to a prior baseline by version number */
  rollback(version: number): BaselineEntry | null {
    const entry = this.baselines.find((b) => b.version === version);
    if (!entry) return null;
    // Remove all entries after this version
    this.baselines = this.baselines.filter((b) => b.version <= version);
    this.persist();
    return entry;
  }

  /** Compare two baselines: returns per-task delta in pass rate */
  compare(baseVersion: number, candidateVersion: number): ComparisonResult[] {
    const base = this.baselines.find((b) => b.version === baseVersion);
    const candidate = this.baselines.find((b) => b.version === candidateVersion);
    if (!base || !candidate) return [];
    const results: ComparisonResult[] = [];
    for (const cs of candidate.scores) {
      const bs = base.scores.find((s) => s.taskId === cs.taskId);
      if (!bs) continue;
      results.push({
        taskId: cs.taskId,
        basePassRate: bs.passRate,
        candidatePassRate: cs.passRate,
        delta: cs.passRate - bs.passRate,
        costDelta: cs.meanCostUsd - bs.meanCostUsd,
        baseMeanCostUsd: bs.meanCostUsd,
        candidateMeanCostUsd: cs.meanCostUsd,
        promoted: cs.passRate >= bs.passRate && !cs.anySecretsLeaked,
      });
    }
    return results;
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.baselines, null, 2), "utf8");
  }
}

export interface ComparisonResult {
  taskId: string;
  basePassRate: number;
  candidatePassRate: number;
  delta: number;
  costDelta: number;
  baseMeanCostUsd: number;
  candidateMeanCostUsd: number;
  promoted: boolean;
}
