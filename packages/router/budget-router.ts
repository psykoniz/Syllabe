import type { ModelId } from "./model-router";
import type { State } from "@projectos/core";

// USD per 1M tokens
const PRICE_PER_MILLION: Record<ModelId, { input: number; output: number }> = {
  "claude-fable-5":    { input: 10.0, output: 50.0 },
  "claude-opus-4-8":   { input:  5.0, output: 25.0 },
  "claude-sonnet-4-6": { input:  3.0, output: 15.0 },
  "claude-haiku-4-5":  { input:  1.0, output:  5.0 },
};

export interface TokenUsage {
  modelId: ModelId;
  inputTokens: number;
  outputTokens: number;
}

export interface StateCost {
  state: State;
  usd: number;
  byModel: Record<ModelId, { inputTokens: number; outputTokens: number; usd: number }>;
}

export interface BudgetOverflowEvent {
  state: State;
  spent: number;
  limit: number;
}

export interface BudgetRouterOptions {
  stateLimits?: Partial<Record<State, number>>; // USD limit per state
  totalLimit?: number;                          // USD limit for entire run
  onOverflow: (event: BudgetOverflowEvent) => void;
}

function tokenCost(modelId: ModelId, inputTokens: number, outputTokens: number): number {
  const p = PRICE_PER_MILLION[modelId];
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

export class BudgetRouter {
  private byState: Map<State, StateCost> = new Map();
  private totalSpent = 0;

  constructor(private opts: BudgetRouterOptions) {}

  record(state: State, usage: TokenUsage): void {
    const usd = tokenCost(usage.modelId, usage.inputTokens, usage.outputTokens);

    if (!this.byState.has(state)) {
      this.byState.set(state, { state, usd: 0, byModel: {} as StateCost["byModel"] });
    }
    const entry = this.byState.get(state)!;
    entry.usd += usd;

    if (!entry.byModel[usage.modelId]) {
      entry.byModel[usage.modelId] = { inputTokens: 0, outputTokens: 0, usd: 0 };
    }
    entry.byModel[usage.modelId].inputTokens += usage.inputTokens;
    entry.byModel[usage.modelId].outputTokens += usage.outputTokens;
    entry.byModel[usage.modelId].usd += usd;

    this.totalSpent += usd;

    const stateLimit = this.opts.stateLimits?.[state];
    if (stateLimit !== undefined && entry.usd > stateLimit) {
      this.opts.onOverflow({ state, spent: entry.usd, limit: stateLimit });
    }

    if (this.opts.totalLimit !== undefined && this.totalSpent > this.opts.totalLimit) {
      this.opts.onOverflow({ state, spent: this.totalSpent, limit: this.opts.totalLimit });
    }
  }

  getStateCost(state: State): StateCost | null {
    return this.byState.get(state) ?? null;
  }

  getTotalSpent(): number {
    return this.totalSpent;
  }

  toReport(): StateCost[] {
    return Array.from(this.byState.values());
  }
}
