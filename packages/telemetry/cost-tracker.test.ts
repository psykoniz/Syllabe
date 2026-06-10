import { describe, it, expect } from "bun:test";
import { computeCost } from "./cost-tracker";

describe("computeCost", () => {
  it("returns zero for empty input", () => {
    const result = computeCost([]);
    expect(result.totalUsd).toBe(0);
    expect(result.byModel).toEqual({});
  });

  it("computes cost for a single model", () => {
    // claude-sonnet-4-6: $3/M input, $15/M output
    const result = computeCost([{ model: "claude-sonnet-4-6", inputTokens: 1_000_000, outputTokens: 1_000_000 }]);
    expect(result.totalUsd).toBeCloseTo(18.0, 6);
    expect(result.byModel["claude-sonnet-4-6"].usd).toBeCloseTo(18.0, 6);
  });

  it("aggregates multiple calls to same model", () => {
    const result = computeCost([
      { model: "claude-haiku-4-5", inputTokens: 500_000, outputTokens: 0 },
      { model: "claude-haiku-4-5", inputTokens: 500_000, outputTokens: 0 },
    ]);
    // $1/M input → 1M tokens = $1.00
    expect(result.totalUsd).toBeCloseTo(1.0, 6);
    expect(result.byModel["claude-haiku-4-5"].inputTokens).toBe(1_000_000);
  });

  it("sums costs across different models", () => {
    const result = computeCost([
      { model: "claude-fable-5",    inputTokens: 100_000, outputTokens: 0 },
      { model: "claude-haiku-4-5",  inputTokens: 100_000, outputTokens: 0 },
    ]);
    // fable-5: 0.1M * $10 = $1.00, haiku: 0.1M * $1 = $0.10
    expect(result.totalUsd).toBeCloseTo(1.10, 6);
  });

  it("treats unknown model as zero cost", () => {
    const result = computeCost([{ model: "gpt-unknown", inputTokens: 1_000_000, outputTokens: 1_000_000 }]);
    expect(result.totalUsd).toBe(0);
  });
});
