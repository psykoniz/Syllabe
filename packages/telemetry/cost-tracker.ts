const PRICE_PER_MILLION: Record<string, { input: number; output: number }> = {
  "claude-fable-5":      { input: 10.0,  output: 50.0  },
  "claude-opus-4-8":     { input: 5.0,   output: 25.0  },
  "claude-sonnet-4-6":   { input: 3.0,   output: 15.0  },
  "claude-haiku-4-5":    { input: 1.0,   output: 5.0   },
  "gpt-5.5":             { input: 10.0,  output: 40.0  },
  "gpt-5.4":             { input: 10.0,  output: 40.0  },
  "gpt-4o":              { input: 2.5,   output: 10.0  },
  "gpt-4o-mini":         { input: 0.15,  output: 0.6   },
};

// Anthropic prompt caching multipliers (relative to input price):
// cache read ≈ 0.1×, cache write (5-min TTL) ≈ 1.25×.
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the prompt cache (billed at ~0.1× input price) */
  cacheReadTokens?: number;
  /** Tokens written to the prompt cache (billed at ~1.25× input price) */
  cacheWriteTokens?: number;
}

export interface CostSummary {
  totalUsd: number;
  byModel: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      usd: number;
    }
  >;
}

export function computeCost(usage: TokenUsage[]): CostSummary {
  const byModel: CostSummary["byModel"] = {};
  let totalUsd = 0;

  for (const { model, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0 } of usage) {
    const price = PRICE_PER_MILLION[model] ?? { input: 0, output: 0 };
    const usd =
      (inputTokens / 1_000_000) * price.input +
      (outputTokens / 1_000_000) * price.output +
      (cacheReadTokens / 1_000_000) * price.input * CACHE_READ_MULTIPLIER +
      (cacheWriteTokens / 1_000_000) * price.input * CACHE_WRITE_MULTIPLIER;
    if (!byModel[model]) {
      byModel[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0 };
    }
    byModel[model].inputTokens += inputTokens;
    byModel[model].outputTokens += outputTokens;
    byModel[model].cacheReadTokens += cacheReadTokens;
    byModel[model].cacheWriteTokens += cacheWriteTokens;
    byModel[model].usd += usd;
    totalUsd += usd;
  }

  return { totalUsd, byModel };
}
