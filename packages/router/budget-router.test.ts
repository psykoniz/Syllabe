import { describe, it, expect } from "bun:test";
import { BudgetRouter } from "./budget-router";
import { MODEL_IDS } from "./model-router";
import type { BudgetOverflowEvent } from "./budget-router";

function makeRouter(
  overflows: BudgetOverflowEvent[] = [],
  stateLimits?: Record<string, number>,
  totalLimit?: number
) {
  return new BudgetRouter({
    stateLimits: stateLimits as any,
    totalLimit,
    onOverflow: (e) => overflows.push(e),
  });
}

describe("BudgetRouter cost tracking", () => {
  it("tracks cost for a single model call", () => {
    const r = makeRouter();
    // claude-sonnet-4-6: $3/M input, $15/M output
    r.record("IMPLEMENT", { modelId: MODEL_IDS.sonnet, inputTokens: 1_000_000, outputTokens: 0 });
    expect(r.getTotalSpent()).toBeCloseTo(3.0, 6);
  });

  it("accumulates cost across multiple records in same state", () => {
    const r = makeRouter();
    r.record("IMPLEMENT", { modelId: MODEL_IDS.haiku, inputTokens: 500_000, outputTokens: 500_000 });
    r.record("IMPLEMENT", { modelId: MODEL_IDS.haiku, inputTokens: 500_000, outputTokens: 500_000 });
    // haiku: $1/M in + $5/M out → 1M in + 1M out = $6
    expect(r.getStateCost("IMPLEMENT")!.usd).toBeCloseTo(6.0, 6);
  });

  it("tracks cost across different states", () => {
    const r = makeRouter();
    r.record("IMPLEMENT", { modelId: MODEL_IDS.sonnet, inputTokens: 100_000, outputTokens: 0 });
    r.record("REVIEW",    { modelId: MODEL_IDS.fable,  inputTokens: 100_000, outputTokens: 0 });
    expect(r.getStateCost("IMPLEMENT")).not.toBeNull();
    expect(r.getStateCost("REVIEW")).not.toBeNull();
    // sonnet $3/M → 0.1M = $0.30; fable $10/M → 0.1M = $1.00
    expect(r.getTotalSpent()).toBeCloseTo(1.30, 6);
  });

  it("toReport returns all states", () => {
    const r = makeRouter();
    r.record("IMPLEMENT", { modelId: MODEL_IDS.sonnet, inputTokens: 1000, outputTokens: 1000 });
    r.record("TEST",      { modelId: MODEL_IDS.sonnet, inputTokens: 1000, outputTokens: 1000 });
    expect(r.toReport()).toHaveLength(2);
  });
});

describe("BudgetRouter overflow", () => {
  it("fires onOverflow when state limit exceeded", () => {
    const overflows: BudgetOverflowEvent[] = [];
    const r = makeRouter(overflows, { IMPLEMENT: 0.001 }); // $0.001 limit
    r.record("IMPLEMENT", { modelId: MODEL_IDS.fable, inputTokens: 1_000_000, outputTokens: 0 });
    expect(overflows).toHaveLength(1);
    expect(overflows[0].state).toBe("IMPLEMENT");
    expect(overflows[0].spent).toBeGreaterThan(overflows[0].limit);
  });

  it("fires onOverflow when total limit exceeded", () => {
    const overflows: BudgetOverflowEvent[] = [];
    const r = makeRouter(overflows, undefined, 0.001);
    r.record("REVIEW", { modelId: MODEL_IDS.fable, inputTokens: 1_000_000, outputTokens: 0 });
    expect(overflows).toHaveLength(1);
  });

  it("does not fire when under limit", () => {
    const overflows: BudgetOverflowEvent[] = [];
    const r = makeRouter(overflows, { IMPLEMENT: 100 });
    r.record("IMPLEMENT", { modelId: MODEL_IDS.haiku, inputTokens: 100, outputTokens: 100 });
    expect(overflows).toHaveLength(0);
  });
});
