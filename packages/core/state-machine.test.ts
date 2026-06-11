import { describe, it, expect } from "bun:test";
import {
  makeContext,
  transition,
  type RunContext,
  type WorkUnit,
} from "./state-machine";

const wu: WorkUnit[] = [
  { id: "wu-1", description: "first" },
  { id: "wu-2", description: "second" },
];

describe("initial state", () => {
  it("starts at INTAKE", () => {
    expect(makeContext().state).toBe("INTAKE");
  });
});

describe("happy path transitions", () => {
  it("INTAKE → CLARIFY on CLARIFY_DONE", () => {
    const ctx = makeContext();
    expect(transition(ctx, { type: "CLARIFY_DONE" }).state).toBe("CLARIFY");
  });

  it("CLARIFY → DESIGN on DESIGN_DONE", () => {
    const ctx: RunContext = { ...makeContext(), state: "CLARIFY" };
    expect(transition(ctx, { type: "DESIGN_DONE" }).state).toBe("DESIGN");
  });

  it("DESIGN → PLAN on PLAN_DONE, stores work units", () => {
    const ctx: RunContext = { ...makeContext(), state: "DESIGN" };
    const next = transition(ctx, { type: "PLAN_DONE", workUnits: wu, blueprintValidated: true });
    expect(next.state).toBe("PLAN");
    expect(next.workUnits).toHaveLength(2);
  });

  it("PLAN → IMPLEMENT on IMPLEMENT_DONE", () => {
    const ctx: RunContext = { ...makeContext(), state: "PLAN", workUnits: wu };
    expect(transition(ctx, { type: "IMPLEMENT_DONE" }).state).toBe("IMPLEMENT");
  });

  it("PLAN → DOCUMENT when allUnitsComplete (parallel mode)", () => {
    const ctx: RunContext = { ...makeContext(), state: "PLAN", workUnits: wu };
    expect(transition(ctx, { type: "IMPLEMENT_DONE", allUnitsComplete: true }).state).toBe("DOCUMENT");
  });

  it("IMPLEMENT → TEST on IMPLEMENT_DONE", () => {
    const ctx: RunContext = { ...makeContext(), state: "IMPLEMENT" };
    expect(transition(ctx, { type: "IMPLEMENT_DONE" }).state).toBe("TEST");
  });

  it("TEST → REVIEW on TESTS_PASS", () => {
    const ctx: RunContext = { ...makeContext(), state: "TEST" };
    expect(transition(ctx, { type: "TESTS_PASS" }).state).toBe("REVIEW");
  });

  it("REVIEW → IMPLEMENT on REVIEW_MUST_FIX (first cycle)", () => {
    const ctx: RunContext = { ...makeContext(), state: "REVIEW", workUnits: wu };
    const next = transition(ctx, { type: "REVIEW_MUST_FIX" });
    expect(next.state).toBe("IMPLEMENT");
    expect(next.reviewCycleCount).toBe(1);
  });

  it("REVIEW → next IMPLEMENT work unit on REVIEW_APPROVE", () => {
    const ctx: RunContext = { ...makeContext(), state: "REVIEW", workUnits: wu, workUnitIndex: 0 };
    const next = transition(ctx, { type: "REVIEW_APPROVE", verdictProvided: true });
    expect(next.state).toBe("IMPLEMENT");
    expect(next.workUnitIndex).toBe(1);
    expect(next.repairCount).toBe(0);
    expect(next.reviewCycleCount).toBe(0);
  });

  it("REVIEW → DOCUMENT when last work unit approved", () => {
    const ctx: RunContext = { ...makeContext(), state: "REVIEW", workUnits: wu, workUnitIndex: 1 };
    expect(transition(ctx, { type: "REVIEW_APPROVE", verdictProvided: true }).state).toBe("DOCUMENT");
  });

  it("DOCUMENT → LEARN → COMPLETE", () => {
    const doc: RunContext = { ...makeContext(), state: "DOCUMENT" };
    const learn = transition(doc, { type: "DOCUMENT_DONE" });
    expect(learn.state).toBe("LEARN");
    const complete = transition(learn, { type: "LEARN_DONE" });
    expect(complete.state).toBe("COMPLETE");
  });
});

describe("bounded loops", () => {
  it("TEST → REPAIR increments repairCount", () => {
    const ctx: RunContext = { ...makeContext(), state: "TEST" };
    const next = transition(ctx, { type: "TESTS_FAIL" });
    expect(next.state).toBe("REPAIR");
    expect(next.repairCount).toBe(1);
  });

  it("REPAIR → TEST on REPAIR_DONE", () => {
    const ctx: RunContext = { ...makeContext(), state: "REPAIR" };
    expect(transition(ctx, { type: "REPAIR_DONE" }).state).toBe("TEST");
  });

  it("escalates after maxRepair TEST failures", () => {
    let ctx: RunContext = { ...makeContext([], { maxRepair: 3, maxReview: 2 }), state: "TEST", repairCount: 3 };
    const next = transition(ctx, { type: "TESTS_FAIL" });
    expect(next.state).toBe("ESCALATED");
    expect(next.escalationReason).toMatch(/max repair/);
  });

  it("escalates after maxReview REVIEW_MUST_FIX cycles", () => {
    const ctx: RunContext = {
      ...makeContext(wu, { maxRepair: 3, maxReview: 2 }),
      state: "REVIEW",
      reviewCycleCount: 2,
    };
    const next = transition(ctx, { type: "REVIEW_MUST_FIX" });
    expect(next.state).toBe("ESCALATED");
    expect(next.escalationReason).toMatch(/max review/);
  });
});

describe("budget overflow", () => {
  it("escalates on overflow when policy is 'escalate'", () => {
    const ctx = makeContext([], { maxRepair: 3, maxReview: 2 }, "escalate");
    expect(transition(ctx, { type: "BUDGET_OVERFLOW" }).state).toBe("ESCALATED");
  });

  it("aborts on overflow when policy is 'abort'", () => {
    const ctx = makeContext([], { maxRepair: 3, maxReview: 2 }, "abort");
    const next = transition(ctx, { type: "BUDGET_OVERFLOW" });
    expect(next.state).toBe("ESCALATED");
    expect(next.escalationReason).toMatch(/abort/);
  });

  it("stays in current state on overflow when policy is 'summarize-and-continue'", () => {
    const ctx: RunContext = {
      ...makeContext([], { maxRepair: 3, maxReview: 2 }, "summarize-and-continue"),
      state: "IMPLEMENT",
    };
    expect(transition(ctx, { type: "BUDGET_OVERFLOW" }).state).toBe("IMPLEMENT");
  });
});

describe("ESCALATE event", () => {
  it("escalates from any state with reason", () => {
    const ctx: RunContext = { ...makeContext(), state: "IMPLEMENT" };
    const next = transition(ctx, { type: "ESCALATE", reason: "manual stop" });
    expect(next.state).toBe("ESCALATED");
    expect(next.escalationReason).toBe("manual stop");
  });
});

describe("unknown events", () => {
  it("returns unchanged context on irrelevant event", () => {
    const ctx = makeContext();
    // TESTS_PASS in INTAKE state is irrelevant
    const next = transition(ctx, { type: "TESTS_PASS" });
    expect(next.state).toBe("INTAKE");
  });
});
