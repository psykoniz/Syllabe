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

  propose(patterns: FailurePattern[], rejectedConfigs: CandidateConfig[] = []): OptimizerProposal {
    if (patterns.length === 0) {
      return {
        rationale: "No failure patterns detected; no change proposed.",
        change: {},
        targetPatterns: [],
      };
    }
    // Target the single most frequent pattern
    const top = patterns[0];
    let change = buildChangeForPattern(top);

    // Never re-propose a config that a prior benchmark/re-validation rejected.
    // For review-convergence failures, fall back to the prompt-scope candidate.
    if (isRejected(change, rejectedConfigs)) {
      const isReviewPattern = top.state === "REVIEW" || top.reason.includes("review");
      const fallback: CandidateConfig = isReviewPattern
        ? { systemPrompts: { implementer: IMPLEMENTER_CONVERGENCE_PROMPT } }
        : {};
      if (isRejected(fallback, rejectedConfigs)) {
        return {
          rationale: `All in-scope candidates for "${top.reason}" were previously rejected; escalate to human.`,
          change: {},
          targetPatterns: [top.reason],
        };
      }
      return {
        rationale: `Prior candidate for "${top.reason}" was rejected after re-validation; proposing prompt-scope fallback.`,
        change: fallback,
        targetPatterns: [top.reason],
      };
    }

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

function isRejected(change: CandidateConfig, rejected: CandidateConfig[]): boolean {
  const key = JSON.stringify(change);
  return rejected.some((r) => JSON.stringify(r) === key);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (typeof v !== "object" || v === null) return false;
  return Object.values(v as object).every((x) => typeof x === "string");
}

function isNumberRecord(v: unknown): v is Record<string, number> {
  if (typeof v !== "object" || v === null) return false;
  return Object.values(v as object).every((x) => typeof x === "number");
}

// ─── V2: LLM-assisted optimizer ──────────────────────────────────────────────

export interface CreateMessageFn {
  (params: {
    model: string;
    max_tokens: number;
    system?: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  }): Promise<{
    content: Array<{ type: string; text?: string }>;
  }>;
}

const OPTIMIZER_PROMPT = [
  "You are a meta-agent that optimizes an AI coding agent harness.",
  "You analyze failure patterns from past runs and propose configuration changes.",
  "",
  "Available configuration levers (CandidateConfig):",
  "- systemPrompts: Record<role, prompt> — override system prompts for specific roles",
  "  Roles: product-strategist, architect, implementer, test-engineer, reviewer, memory-curator",
  "- modelRouting: Record<role, model> — override which model handles which role",
  "  Available: claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5",
  "- stateBudgets: Record<state, maxTokens> — token budget per state",
  "  States: INTAKE, CLARIFY, DESIGN, PLAN, IMPLEMENT, TEST, REPAIR, REVIEW, DOCUMENT, LEARN",
  "- loopBounds: { maxRepair?: number, maxReview?: number }",
  "",
  "Reply with valid JSON matching CandidateConfig. Include a rationale field explaining why.",
  "Never propose changes outside these 4 fields.",
  "Keep the proposal minimal — target the root cause, do not change everything at once.",
].join("\n");

/** V2 optimizer: heuristics first (cheap), LLM fallback (expensive but smart).
 *  The LLM call only fires when heuristics return {} (no known fix). */
export class HarnessOptimizerV2 extends HarnessOptimizer {
  constructor(private createMessage: CreateMessageFn) {
    super();
  }

  /** Try heuristics first; fall back to an LLM-proposed config when the
   *  static rules don't cover the failure pattern. */
  async proposeLLM(
    patterns: FailurePattern[],
    rejectedConfigs: CandidateConfig[] = [],
    traceExcerpts = "",
  ): Promise<OptimizerProposal> {
    // Cheap path: heuristic rules
    const heuristic = this.propose(patterns, rejectedConfigs);
    if (Object.keys(heuristic.change).length > 0) return heuristic;

    // Heuristics returned {} — the pattern is unknown; ask the LLM
    if (patterns.length === 0) return heuristic;

    const model = process.env.PROJECTOS_MODEL_OVERRIDE ?? "claude-opus-4-8";

    try {
      const response = await this.createMessage({
        model,
        max_tokens: 1024,
        system: OPTIMIZER_PROMPT,
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              failurePatterns: patterns.slice(0, 10),
              rejectedConfigs,
              traceExcerpts: traceExcerpts.slice(0, 3000),
            }),
          },
        ],
      });

      const text = response.content
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("\n");

      // Extract JSON from the response (may be wrapped in markdown fences)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        const { rationale, ...change } = parsed;
        if (validateCandidateConfig(change)) {
          return {
            rationale: String(rationale ?? "LLM-proposed change"),
            change: change as CandidateConfig,
            targetPatterns: patterns.map((p) => p.reason),
          };
        }
      }
    } catch {
      // LLM call failed — fall through
    }

    return {
      rationale: "LLM proposal failed validation or heuristics exhausted; escalate to human.",
      change: {},
      targetPatterns: patterns.map((p) => p.reason),
    };
  }
}

