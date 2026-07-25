export const STATES = [
  "INTAKE",
  "CLARIFY",
  "DESIGN",
  "PLAN",
  "REPRODUCE",
  "IMPLEMENT",
  "TEST",
  "REPAIR",
  "REVIEW",
  "DOCUMENT",
  "LEARN",
  "COMPLETE",
  "ESCALATED",
] as const;

export type State = (typeof STATES)[number];

export type OverflowPolicy = "summarize-and-continue" | "escalate" | "abort";

export interface WorkUnit {
  id: string;
  description: string;
}

export interface LoopBounds {
  maxRepair: number;   // max TEST ⇄ REPAIR iterations per work unit
  maxReview: number;   // max REVIEW→IMPLEMENT cycles per work unit
}

export interface RunContext {
  state: State;
  workUnits: WorkUnit[];
  workUnitIndex: number;
  repairCount: number;
  reviewCycleCount: number;
  bounds: LoopBounds;
  overflowPolicy: OverflowPolicy;
  escalationReason: string | null;
}

export type MachineEvent =
  | { type: "CLARIFY_DONE" }
  | { type: "DESIGN_DONE" }
  | { type: "PLAN_DONE"; workUnits: WorkUnit[]; blueprintValidated: boolean }
  | { type: "REPRODUCE_DONE" }
  | { type: "REPRODUCE_SKIP" }
  | { type: "IMPLEMENT_DONE"; allUnitsComplete?: boolean }
  | { type: "TESTS_PASS" }
  | { type: "TESTS_FAIL" }
  | { type: "REPAIR_DONE" }
  | { type: "REVIEW_APPROVE"; verdictProvided: boolean }
  | { type: "REVIEW_MUST_FIX" }
  | { type: "DOCUMENT_DONE" }
  | { type: "LEARN_DONE" }
  | { type: "BUDGET_OVERFLOW" }
  | { type: "ESCALATE"; reason: string };

export interface TransitionResult {
  context: RunContext;
  escalated: boolean;
  completed: boolean;
}

export function makeContext(
  workUnits: WorkUnit[] = [],
  bounds: LoopBounds = { maxRepair: 3, maxReview: 2 },
  overflowPolicy: OverflowPolicy = "escalate"
): RunContext {
  return {
    state: "INTAKE",
    workUnits,
    workUnitIndex: 0,
    repairCount: 0,
    reviewCycleCount: 0,
    bounds,
    overflowPolicy,
    escalationReason: null,
  };
}

function escalate(ctx: RunContext, reason: string): RunContext {
  return { ...ctx, state: "ESCALATED", escalationReason: reason };
}

function nextWorkUnit(ctx: RunContext): RunContext {
  const nextIndex = ctx.workUnitIndex + 1;
  if (nextIndex >= ctx.workUnits.length) {
    return { ...ctx, state: "DOCUMENT", workUnitIndex: nextIndex, repairCount: 0, reviewCycleCount: 0 };
  }
  return { ...ctx, state: "IMPLEMENT", workUnitIndex: nextIndex, repairCount: 0, reviewCycleCount: 0 };
}

export function transition(ctx: RunContext, event: MachineEvent): RunContext {
  const { state } = ctx;

  if (event.type === "BUDGET_OVERFLOW") {
    if (ctx.overflowPolicy === "escalate") return escalate(ctx, "budget overflow");
    if (ctx.overflowPolicy === "abort")    return escalate(ctx, "budget overflow: abort");
    // summarize-and-continue: stay in current state (caller handles summarization)
    return ctx;
  }

  if (event.type === "ESCALATE") {
    return escalate(ctx, event.reason);
  }

  switch (state) {
    case "INTAKE":
      if (event.type === "CLARIFY_DONE") return { ...ctx, state: "CLARIFY" };
      break;

    case "CLARIFY":
      if (event.type === "DESIGN_DONE") return { ...ctx, state: "DESIGN" };
      break;

    case "DESIGN":
      if (event.type === "PLAN_DONE") {
        if (!event.blueprintValidated) {
          return escalate(ctx, "blueprint incomplete: all 4 blueprint files must exist and be non-empty");
        }
        return { ...ctx, state: "PLAN", workUnits: event.workUnits };
      }
      break;

    case "PLAN":
      if (event.type === "IMPLEMENT_DONE") {
        // allUnitsComplete: a parallel executor already ran every unit's
        // implement/test/review pipeline — skip straight to DOCUMENT.
        if (ctx.workUnits.length === 0 || event.allUnitsComplete) {
          return { ...ctx, state: "DOCUMENT" };
        }
        return { ...ctx, state: "REPRODUCE" };
      }
      break;

    case "REPRODUCE":
      if (event.type === "REPRODUCE_DONE" || event.type === "REPRODUCE_SKIP") {
        return { ...ctx, state: "IMPLEMENT" };
      }
      break;

    case "IMPLEMENT":
      if (event.type === "IMPLEMENT_DONE") return { ...ctx, state: "TEST" };
      break;

    case "TEST":
      if (event.type === "TESTS_PASS") {
        return { ...ctx, state: "REVIEW", repairCount: 0 };
      }
      if (event.type === "TESTS_FAIL") {
        if (ctx.repairCount >= ctx.bounds.maxRepair) {
          return escalate(ctx, `max repair iterations (${ctx.bounds.maxRepair}) exceeded`);
        }
        return { ...ctx, state: "REPAIR", repairCount: ctx.repairCount + 1 };
      }
      break;

    case "REPAIR":
      if (event.type === "REPAIR_DONE") return { ...ctx, state: "TEST" };
      break;

    case "REVIEW":
      if (event.type === "REVIEW_APPROVE") {
        if (!event.verdictProvided) {
          return escalate(ctx, "cannot approve review: no verdict object provided");
        }
        return nextWorkUnit(ctx);
      }
      if (event.type === "REVIEW_MUST_FIX") {
        if (ctx.reviewCycleCount >= ctx.bounds.maxReview) {
          return escalate(ctx, `max review cycles (${ctx.bounds.maxReview}) exceeded`);
        }
        return { ...ctx, state: "IMPLEMENT", reviewCycleCount: ctx.reviewCycleCount + 1, repairCount: 0 };
      }
      break;

    case "DOCUMENT":
      if (event.type === "DOCUMENT_DONE") return { ...ctx, state: "LEARN" };
      break;

    case "LEARN":
      if (event.type === "LEARN_DONE") return { ...ctx, state: "COMPLETE" };
      break;

    case "COMPLETE":
    case "ESCALATED":
      break;
  }

  return ctx;
}
