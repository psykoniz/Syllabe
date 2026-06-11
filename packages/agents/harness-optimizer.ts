import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

/** Scope of what a candidate may change (v1 — deliberately narrow) */
export interface CandidateConfig {
  /** System prompts per role */
  systemPrompts?: Record<string, string>;
  /** Role → model routing overrides */
  modelRouting?: Record<string, string>;
  /** Per-state budget overrides (tokens) */
  stateBudgets?: Record<string, number>;
  /** Loop bounds overrides */
  loopBounds?: { maxRepair?: number; maxReview?: number };
}

export interface FailurePattern {
  runId: string;
  state: string;
  reason: string;
  count: number;
}

export interface OptimizerProposal {
  rationale: string;
  change: CandidateConfig;
  /** Which failure patterns this targets */
  targetPatterns: string[];
}

/** Validates that a candidate config only touches allowed fields (v1 scope) */
export function validateCandidateConfig(config: unknown): config is CandidateConfig {
  if (!config || typeof config !== "object") return false;
  const c = config as Record<string, unknown>;
  const allowed = new Set(["systemPrompts", "modelRouting", "stateBudgets", "loopBounds"]);
  for (const key of Object.keys(c)) {
    if (!allowed.has(key)) return false;
  }
  if (c.systemPrompts !== undefined && !isStringRecord(c.systemPrompts)) return false;
  if (c.modelRouting !== undefined && !isStringRecord(c.modelRouting)) return false;
  if (c.stateBudgets !== undefined && !isNumberRecord(c.stateBudgets)) return false;
  if (c.loopBounds !== undefined) {
    if (typeof c.loopBounds !== "object" || c.loopBounds === null) return false;
    const lb = c.loopBounds as Record<string, unknown>;
    if (lb.maxRepair !== undefined && typeof lb.maxRepair !== "number") return false;
    if (lb.maxReview !== undefined && typeof lb.maxReview !== "number") return false;
  }
  return true;
}

/** Analyze failure patterns from run summaries and produce ONE targeted proposal */
export class HarnessOptimizer {
  analyzeFailures(patterns: FailurePattern[]): FailurePattern[] {
    // Group and sort by frequency
    const sorted = [...patterns].sort((a, b) => b.count - a.count);
    return sorted;
  }

  propose(patterns: FailurePattern[]): OptimizerProposal {
    if (patterns.length === 0) {
      return {
        rationale: "No failure patterns detected; no change proposed.",
        change: {},
        targetPatterns: [],
      };
    }
    // Target the single most frequent pattern
    const top = patterns[0];
    const change = buildChangeForPattern(top);
    return {
      rationale: `Targeting most frequent failure: ${top.reason} in state ${top.state} (${top.count} occurrences)`,
      change,
      targetPatterns: [top.reason],
    };
  }

  saveProposal(filePath: string, proposal: OptimizerProposal): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(proposal, null, 2), "utf8");
  }
}

const IMPLEMENTER_CONVERGENCE_PROMPT = [
  "You are a senior software implementer working inside a build pipeline.",
  "A reviewer has rejected previous attempts. Before writing any code:",
  "1. Re-read the reviewer's mustFix list and restate each item in your own words.",
  "2. Address every mustFix item explicitly — do not move on while any remain.",
  "3. Run the tests after your changes and confirm they pass before finishing.",
  "Never repeat an approach the reviewer already rejected.",
].join("\n");

function buildChangeForPattern(pattern: FailurePattern): CandidateConfig {
  if (pattern.state === "REPAIR" || pattern.reason.includes("repair")) {
    return { loopBounds: { maxRepair: 5 } };
  }
  if (pattern.state === "REVIEW" || pattern.reason.includes("review")) {
    // If cycles were already raised beyond the default 2 and still fail,
    // the bottleneck is convergence behaviour, not the bound — target the prompt.
    const cyclesMatch = /\((\d+)\)/.exec(pattern.reason);
    const cycles = cyclesMatch ? parseInt(cyclesMatch[1], 10) : 2;
    if (cycles >= 3) {
      return { systemPrompts: { implementer: IMPLEMENTER_CONVERGENCE_PROMPT } };
    }
    return { loopBounds: { maxReview: 3 } };
  }
  if (pattern.reason.includes("budget") || pattern.reason.includes("overflow")) {
    return { stateBudgets: { [pattern.state]: 200000 } };
  }
  // Default: no structural change possible within v1 scope
  return {};
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (typeof v !== "object" || v === null) return false;
  return Object.values(v as object).every((x) => typeof x === "string");
}

function isNumberRecord(v: unknown): v is Record<string, number> {
  if (typeof v !== "object" || v === null) return false;
  return Object.values(v as object).every((x) => typeof x === "number");
}
