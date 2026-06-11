import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import type { CandidateConfig } from "@projectos/agents";
import type { ComparisonResult } from "./baseline";
import { BaselineStore } from "./baseline";
import type { AggregateScore } from "./scorers";

export interface PromotionRecord {
  candidateId: string;
  config: CandidateConfig;
  promotedAt: string;
  comparison: ComparisonResult[];
  adrPath: string | null;
}

export interface PromotionRules {
  /** Candidate pass rate must be >= baseline on ALL tasks */
  noRegressions: boolean;
  /** Candidate must not leak secrets */
  noSecretsLeaked: boolean;
  /** Max allowed total-cost increase ratio at equal pass rate (0.2 = +20%).
   *  Each +0.01 mean pass-rate gain buys +0.02 extra cost tolerance —
   *  improvements may cost more, silent cost drift may not. */
  maxCostIncreaseRatio: number;
}

export const DEFAULT_PROMOTION_RULES: PromotionRules = {
  noRegressions: true,
  noSecretsLeaked: true,
  maxCostIncreaseRatio: 0.2,
};

/** Cost guard: total candidate cost must stay within the allowed ratio of
 *  the baseline total. Pass-rate gains widen the tolerance (exchange rate
 *  2:1 — +10 points of mean pass rate allows +20% extra cost). */
export function costGuardAllows(comparison: ComparisonResult[], maxRatio: number): boolean {
  const baseTotal = comparison.reduce((s, c) => s + c.baseMeanCostUsd, 0);
  const candTotal = comparison.reduce((s, c) => s + c.candidateMeanCostUsd, 0);
  if (baseTotal <= 0) return true; // no cost data — nothing to guard
  const meanDelta = comparison.reduce((s, c) => s + c.delta, 0) / comparison.length;
  const allowed = maxRatio + Math.max(0, meanDelta) * 2;
  return candTotal <= baseTotal * (1 + allowed);
}

export class Frontier {
  constructor(
    private baselineStore: BaselineStore,
    private harnessDir: string
  ) {}

  /** Evaluate whether a candidate should be promoted */
  shouldPromote(comparison: ComparisonResult[], rules: PromotionRules = DEFAULT_PROMOTION_RULES): boolean {
    if (rules.noRegressions && comparison.some((c) => c.delta < 0)) return false;
    if (rules.noSecretsLeaked && comparison.some((c) => !c.promoted && c.delta >= 0)) return false;
    if (!costGuardAllows(comparison, rules.maxCostIncreaseRatio)) return false;
    return true;
  }

  /** Promote a candidate: store its scores as a new baseline and log an ADR */
  promote(
    candidateId: string,
    config: CandidateConfig,
    scores: AggregateScore[],
    comparison: ComparisonResult[]
  ): PromotionRecord {
    this.baselineStore.store(scores);

    const adrDir = join(this.harnessDir, "decisions");
    mkdirSync(adrDir, { recursive: true });

    const existingAdrs = existsSync(adrDir)
      ? require("fs").readdirSync(adrDir).filter((f: string) => /^ADR-\d+/.test(f))
      : [];
    const nextNum = existingAdrs.length + 1;
    const slug = `harness-optimizer-candidate-${candidateId}`;
    const adrFilename = `ADR-${String(nextNum).padStart(3, "0")}-${slug}.md`;
    const adrPath = join(adrDir, adrFilename);

    const adrContent = formatPromotionAdr(nextNum, candidateId, config, comparison);
    writeFileSync(adrPath, adrContent, "utf8");

    const record: PromotionRecord = {
      candidateId,
      config,
      promotedAt: new Date().toISOString(),
      comparison,
      adrPath,
    };

    const logPath = join(this.harnessDir, "promotions.json");
    const history: PromotionRecord[] = existsSync(logPath)
      ? JSON.parse(readFileSync(logPath, "utf8"))
      : [];
    history.push(record);
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, JSON.stringify(history, null, 2), "utf8");

    return record;
  }

  loadPromotions(): PromotionRecord[] {
    const logPath = join(this.harnessDir, "promotions.json");
    if (!existsSync(logPath)) return [];
    try {
      return JSON.parse(readFileSync(logPath, "utf8"));
    } catch {
      return [];
    }
  }
}

function formatPromotionAdr(
  num: number,
  candidateId: string,
  config: CandidateConfig,
  comparison: ComparisonResult[]
): string {
  const changes = JSON.stringify(config, null, 2);
  const deltas = comparison
    .map((c) => `- ${c.taskId}: ${c.basePassRate.toFixed(2)} → ${c.candidatePassRate.toFixed(2)} (Δ${c.delta >= 0 ? "+" : ""}${c.delta.toFixed(2)})`)
    .join("\n");
  return [
    `# ADR-${String(num).padStart(3, "0")}: Promote Harness Candidate ${candidateId}`,
    "",
    "**Status:** accepted",
    "",
    "## Context",
    "",
    `Harness optimizer proposed candidate \`${candidateId}\`. Benchmark results met promotion rules.`,
    "",
    "## Decision",
    "",
    "Promote candidate config as new baseline.",
    "",
    "```json",
    changes,
    "```",
    "",
    "## Consequences",
    "",
    "Pass rate deltas across tasks:",
    "",
    deltas,
    "",
  ].join("\n");
}
