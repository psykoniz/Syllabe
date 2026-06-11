import { describe, it, expect } from "bun:test";
import { RoleRouter } from "./role-router";
import { MODEL_IDS } from "./model-router";
import type { EscalationEvent } from "./role-router";

function makeRouter(escalations: EscalationEvent[] = []) {
  return new RoleRouter({ onEscalate: (e) => escalations.push(e) });
}

describe("RoleRouter.route", () => {
  it("routes implementer to sonnet without fallback", () => {
    const r = makeRouter().route("implementer");
    expect(r.modelId).toBe(MODEL_IDS.sonnet);
    expect(r.fallbackUsed).toBe(false);
  });

  it("routes architect to opus without fallback", () => {
    const r = makeRouter().route("architect");
    expect(r.modelId).toBe(MODEL_IDS.opus);
    expect(r.fallbackUsed).toBe(false);
  });

  it("routes harness-optimizer analysis to opus", () => {
    expect(makeRouter().route("harness-optimizer", "analysis").modelId).toBe(MODEL_IDS.opus);
  });

  it("routes harness-optimizer implementation to sonnet", () => {
    expect(makeRouter().route("harness-optimizer", "implementation").modelId).toBe(MODEL_IDS.sonnet);
  });
});

describe("RoleRouter.handleModelError — execution roles fallback", () => {
  it("implementer error falls back to haiku", () => {
    const escalations: EscalationEvent[] = [];
    const r = makeRouter(escalations).handleModelError("implementer", "overloaded");
    expect(r.modelId).toBe(MODEL_IDS.haiku);
    expect(r.fallbackUsed).toBe(true);
    expect(escalations).toHaveLength(0);
  });

  it("test-engineer error falls back to haiku", () => {
    const r = makeRouter().handleModelError("test-engineer", "rate-limit");
    expect(r.modelId).toBe(MODEL_IDS.haiku);
    expect(r.fallbackUsed).toBe(true);
  });

  it("memory-curator error stays on haiku", () => {
    const r = makeRouter().handleModelError("memory-curator", "error");
    expect(r.modelId).toBe(MODEL_IDS.haiku);
    expect(r.fallbackUsed).toBe(true);
  });
});

describe("RoleRouter.handleModelError — decision roles escalate", () => {
  it("architect error escalates and never falls back", () => {
    const escalations: EscalationEvent[] = [];
    const r = makeRouter(escalations).handleModelError("architect", "model down");
    expect(r.fallbackUsed).toBe(false);
    expect(r.modelId).toBe(MODEL_IDS.opus); // original preserved
    expect(escalations).toHaveLength(1);
    expect(escalations[0].role).toBe("architect");
    expect(escalations[0].reason).toBe("model down");
  });

  it("reviewer error escalates", () => {
    const escalations: EscalationEvent[] = [];
    makeRouter(escalations).handleModelError("reviewer", "timeout");
    expect(escalations).toHaveLength(1);
    expect(escalations[0].role).toBe("reviewer");
  });

  it("product-strategist error escalates", () => {
    const escalations: EscalationEvent[] = [];
    makeRouter(escalations).handleModelError("product-strategist", "error");
    expect(escalations).toHaveLength(1);
  });
});
