const PRICE_PER_MILLION: Record<string, { input: number; output: number }> = {
  "claude-fable-5":      { input: 10.0,  output: 50.0  },
  "claude-opus-4-8":     { input: 5.0,   output: 25.0  },
  "claude-sonnet-4-6":   { input: 3.0,   output: 15.0  },
  "claude-haiku-4-5":    { input: 1.0,   output: 5.0   },
};

export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface CostSummary {
  totalUsd: number;
  byModel: Record<string, { inputTokens: number; outputTokens: number; usd: number }>;
}

export function computeCost(usage: TokenUsage[]): CostSummary {
  const byModel: CostSummary["byModel"] = {};
  let totalUsd = 0;

  for (const { model, inputTokens, outputTokens } of usage) {
    const price = PRICE_PER_MILLION[model] ?? { input: 0, output: 0 };
    const usd = (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
    if (!byModel[model]) byModel[model] = { inputTokens: 0, outputTokens: 0, usd: 0 };
    byModel[model].inputTokens += inputTokens;
    byModel[model].outputTokens += outputTokens;
    byModel[model].usd += usd;
    totalUsd += usd;
  }

  return { totalUsd, byModel };
}
