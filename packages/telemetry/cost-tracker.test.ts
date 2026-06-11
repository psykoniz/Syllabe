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

  it("bills cache read tokens at 0.1x input price", () => {
    // sonnet: $3/M input → 1M cache-read tokens = $0.30
    const result = computeCost([
      { model: "claude-sonnet-4-6", inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
    ]);
    expect(result.totalUsd).toBeCloseTo(0.3, 6);
    expect(result.byModel["claude-sonnet-4-6"].cacheReadTokens).toBe(1_000_000);
  });

  it("bills cache write tokens at 1.25x input price", () => {
    // sonnet: $3/M input → 1M cache-write tokens = $3.75
    const result = computeCost([
      { model: "claude-sonnet-4-6", inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 },
    ]);
    expect(result.totalUsd).toBeCloseTo(3.75, 6);
    expect(result.byModel["claude-sonnet-4-6"].cacheWriteTokens).toBe(1_000_000);
  });

  it("combines uncached, cache read, cache write and output costs", () => {
    // fable-5: $10/M input, $50/M output
    // 0.1M input = $1, 0.1M output = $5, 1M read = $1, 0.1M write = $1.25
    const result = computeCost([
      {
        model: "claude-fable-5",
        inputTokens: 100_000,
        outputTokens: 100_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 100_000,
      },
    ]);
    expect(result.totalUsd).toBeCloseTo(8.25, 6);
  });

  it("absent cache fields leave the cost unchanged (backward compatible)", () => {
    const withFields = computeCost([
      { model: "claude-opus-4-8", inputTokens: 200_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
    const withoutFields = computeCost([
      { model: "claude-opus-4-8", inputTokens: 200_000, outputTokens: 100_000 },
    ]);
    expect(withoutFields.totalUsd).toBeCloseTo(withFields.totalUsd, 9);
    // opus-4-8: 0.2M * $5 + 0.1M * $25 = $3.50
    expect(withoutFields.totalUsd).toBeCloseTo(3.5, 6);
    expect(withoutFields.byModel["claude-opus-4-8"].cacheReadTokens).toBe(0);
    expect(withoutFields.byModel["claude-opus-4-8"].cacheWriteTokens).toBe(0);
  });

  it("aggregates cache tokens across calls to the same model", () => {
    const result = computeCost([
      { model: "claude-haiku-4-5", inputTokens: 0, outputTokens: 0, cacheReadTokens: 400_000, cacheWriteTokens: 100_000 },
      { model: "claude-haiku-4-5", inputTokens: 0, outputTokens: 0, cacheReadTokens: 600_000 },
    ]);
    expect(result.byModel["claude-haiku-4-5"].cacheReadTokens).toBe(1_000_000);
    expect(result.byModel["claude-haiku-4-5"].cacheWriteTokens).toBe(100_000);
    // haiku $1/M: read 1M*0.1 = $0.10, write 0.1M*1.25 = $0.125
    expect(result.totalUsd).toBeCloseTo(0.225, 6);
  });

  it("treats unknown model as zero cost", () => {
    const result = computeCost([{ model: "gpt-unknown", inputTokens: 1_000_000, outputTokens: 1_000_000 }]);
    expect(result.totalUsd).toBe(0);
  });
});
