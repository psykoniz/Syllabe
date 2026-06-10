import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runAgentLoop } from "./agent-loop";
import { makeContext, type RunContext, type MachineEvent, type State } from "./state-machine";
import { loadCheckpoints } from "./checkpoint";
import type { AgentHandler } from "./agent-loop";

const wu = [
  { id: "wu-1", description: "first unit" },
  { id: "wu-2", description: "second unit" },
];

function memDb(): Database {
  return new Database(":memory:");
}

// Scripted handler: returns events from a queue; throws if queue exhausted
function scriptedHandler(events: MachineEvent[]): AgentHandler {
  let i = 0;
  return {
    async onState(_state: State, _ctx: RunContext): Promise<MachineEvent> {
      if (i >= events.length) throw new Error(`No more events at step ${i}, state ${_state}`);
      return events[i++];
    },
  };
}

describe("runAgentLoop", () => {
  it("writes initial checkpoint at seq=0", async () => {
    const db = memDb();
    const handler = scriptedHandler([
      { type: "CLARIFY_DONE" },
      { type: "DESIGN_DONE" },
      { type: "PLAN_DONE", workUnits: [], blueprintValidated: true },
      { type: "IMPLEMENT_DONE" }, // PLAN → DOCUMENT (no work units)
      { type: "DOCUMENT_DONE" },
      { type: "LEARN_DONE" },
    ]);
    await runAgentLoop(makeContext(), { runId: "r1", db, handler });
    const rows = loadCheckpoints(db, "r1");
    expect(rows[0].seq).toBe(0);
    expect(rows[0].state).toBe("INTAKE");
  });

  it("writes a checkpoint on every state transition", async () => {
    const db = memDb();
    const handler = scriptedHandler([
      { type: "CLARIFY_DONE" },
      { type: "DESIGN_DONE" },
      { type: "PLAN_DONE", workUnits: [], blueprintValidated: true },
      { type: "IMPLEMENT_DONE" },
      { type: "DOCUMENT_DONE" },
      { type: "LEARN_DONE" },
    ]);
    await runAgentLoop(makeContext(), { runId: "r2", db, handler });
    const rows = loadCheckpoints(db, "r2");
    const states = rows.map((r) => r.state);
    // initial + each transition
    expect(states).toContain("INTAKE");
    expect(states).toContain("COMPLETE");
  });

  it("full traversal with 2 work units reaches COMPLETE", async () => {
    const db = memDb();
    const handler = scriptedHandler([
      { type: "CLARIFY_DONE" },
      { type: "DESIGN_DONE" },
      { type: "PLAN_DONE", workUnits: wu, blueprintValidated: true },
      { type: "IMPLEMENT_DONE" }, // PLAN → IMPLEMENT (wu-1)
      // wu-1
      { type: "IMPLEMENT_DONE" }, // IMPLEMENT → TEST
      { type: "TESTS_PASS" },     // TEST → REVIEW
      { type: "REVIEW_APPROVE", verdictProvided: true }, // REVIEW → IMPLEMENT (wu-2)
      // wu-2
      { type: "IMPLEMENT_DONE" },
      { type: "TESTS_PASS" },
      { type: "REVIEW_APPROVE", verdictProvided: true }, // → DOCUMENT
      { type: "DOCUMENT_DONE" },
      { type: "LEARN_DONE" },
    ]);
    const { finalContext } = await runAgentLoop(makeContext(), { runId: "r3", db, handler });
    expect(finalContext.state).toBe("COMPLETE");
  });

  it("forced repair loop and review rejection still reach COMPLETE", async () => {
    const db = memDb();
    const handler = scriptedHandler([
      { type: "CLARIFY_DONE" },
      { type: "DESIGN_DONE" },
      { type: "PLAN_DONE", workUnits: [wu[0]], blueprintValidated: true },
      { type: "IMPLEMENT_DONE" }, // PLAN → IMPLEMENT
      // wu-0: one repair
      { type: "IMPLEMENT_DONE" }, // → TEST
      { type: "TESTS_FAIL" },     // → REPAIR (repairCount=1)
      { type: "REPAIR_DONE" },    // → TEST
      { type: "TESTS_PASS" },     // → REVIEW
      // one review rejection
      { type: "REVIEW_MUST_FIX" }, // → IMPLEMENT (reviewCycle=1)
      { type: "IMPLEMENT_DONE" },  // → TEST
      { type: "TESTS_PASS" },
      { type: "REVIEW_APPROVE", verdictProvided: true }, // → DOCUMENT
      { type: "DOCUMENT_DONE" },
      { type: "LEARN_DONE" },
    ]);
    const { finalContext } = await runAgentLoop(makeContext(), { runId: "r4", db, handler });
    expect(finalContext.state).toBe("COMPLETE");
  });

  it("escalates when maxRepair exceeded", async () => {
    const db = memDb();
    const ctx = makeContext([wu[0]], { maxRepair: 1, maxReview: 2 });
    const handler = scriptedHandler([
      { type: "CLARIFY_DONE" },
      { type: "DESIGN_DONE" },
      { type: "PLAN_DONE", workUnits: [wu[0]], blueprintValidated: true },
      { type: "IMPLEMENT_DONE" }, // PLAN → IMPLEMENT
      { type: "IMPLEMENT_DONE" }, // IMPLEMENT → TEST
      { type: "TESTS_FAIL" },     // → REPAIR (count=1, limit=1 → next fail escalates)
      { type: "REPAIR_DONE" },    // → TEST
      { type: "TESTS_FAIL" },     // repairCount already at limit → ESCALATED
    ]);
    const { finalContext } = await runAgentLoop(ctx, { runId: "r5", db, handler });
    expect(finalContext.state).toBe("ESCALATED");
    expect(finalContext.escalationReason).toMatch(/max repair/);
  });

  it("resume restarts from last checkpoint state", async () => {
    // Simulate a mid-run checkpoint by passing a context already at IMPLEMENT
    const db = memDb();
    const midCtx: RunContext = {
      ...makeContext(wu),
      state: "IMPLEMENT",
      workUnitIndex: 0,
    };
    const handler = scriptedHandler([
      { type: "IMPLEMENT_DONE" }, // → TEST
      { type: "TESTS_PASS" },
      { type: "REVIEW_APPROVE", verdictProvided: true }, // → IMPLEMENT wu-1
      { type: "IMPLEMENT_DONE" },
      { type: "TESTS_PASS" },
      { type: "REVIEW_APPROVE", verdictProvided: true }, // → DOCUMENT
      { type: "DOCUMENT_DONE" },
      { type: "LEARN_DONE" },
    ]);
    const { finalContext } = await runAgentLoop(midCtx, { runId: "r6", db, handler });
    expect(finalContext.state).toBe("COMPLETE");
  });
});
