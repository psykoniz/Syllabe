import { describe, it, expect } from "bun:test";
import { runWorkUnit } from "./task-runner";
import type { TaskExecutor, TaskRunnerOptions } from "./task-runner";
import type { WorkUnit } from "./state-machine";

const wu: WorkUnit = { id: "wu-1", description: "build feature" };

function makeExecutor(overrides: Partial<{
  implementFails: boolean;
  testPassAfter: number;   // pass on this attempt (0 = immediate)
  reviewApproveAfter: number; // approve on this review cycle (0 = immediate)
  mustFix: string[];
}>): TaskExecutor {
  let testAttempt = 0;
  let reviewCycle = 0;
  const { testPassAfter = 0, reviewApproveAfter = 0, mustFix = [] } = overrides;
  return {
    async implement() { return { success: true }; },
    async test() {
      const pass = testAttempt++ >= testPassAfter;
      return { passed: pass };
    },
    async repair() {},
    async review() {
      const approve = reviewCycle++ >= reviewApproveAfter;
      return { approved: approve, mustFix: approve ? [] : mustFix };
    },
  };
}

const opts: TaskRunnerOptions = { maxRepair: 3, maxReview: 2 };

describe("runWorkUnit", () => {
  it("succeeds immediately when tests pass and review approves", async () => {
    const result = await runWorkUnit(wu, makeExecutor({}), opts);
    expect(result.success).toBe(true);
    expect(result.testsPassed).toBe(true);
    expect(result.reviewApproved).toBe(true);
    expect(result.escalationReason).toBeNull();
  });

  it("succeeds after one repair cycle", async () => {
    const result = await runWorkUnit(wu, makeExecutor({ testPassAfter: 1 }), opts);
    expect(result.success).toBe(true);
  });

  it("escalates when repair limit exceeded", async () => {
    const result = await runWorkUnit(wu, makeExecutor({ testPassAfter: 99 }), { maxRepair: 2, maxReview: 2 });
    expect(result.success).toBe(false);
    expect(result.escalationReason).toMatch(/max repair/);
  });

  it("succeeds after one review rejection", async () => {
    const result = await runWorkUnit(
      wu,
      makeExecutor({ reviewApproveAfter: 1, mustFix: ["fix-a"] }),
      opts
    );
    expect(result.success).toBe(true);
  });

  it("escalates when review cycle limit exceeded", async () => {
    const result = await runWorkUnit(
      wu,
      makeExecutor({ reviewApproveAfter: 99, mustFix: ["blocker"] }),
      { maxRepair: 3, maxReview: 1 }
    );
    expect(result.success).toBe(false);
    expect(result.escalationReason).toMatch(/max review/);
  });
});
