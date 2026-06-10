import type { WorkUnit } from "./state-machine";

export interface TaskResult {
  workUnitId: string;
  success: boolean;
  testsPassed: boolean;
  reviewApproved: boolean;
  escalationReason: string | null;
}

export interface TaskExecutor {
  implement(wu: WorkUnit): Promise<{ success: boolean }>;
  test(wu: WorkUnit): Promise<{ passed: boolean }>;
  repair(wu: WorkUnit, attempt: number): Promise<void>;
  review(wu: WorkUnit): Promise<{ approved: boolean; mustFix: string[] }>;
}

export interface TaskRunnerOptions {
  maxRepair: number;
  maxReview: number;
}

export async function runWorkUnit(
  wu: WorkUnit,
  executor: TaskExecutor,
  opts: TaskRunnerOptions = { maxRepair: 3, maxReview: 2 }
): Promise<TaskResult> {
  const base: TaskResult = {
    workUnitId: wu.id,
    success: false,
    testsPassed: false,
    reviewApproved: false,
    escalationReason: null,
  };

  for (let reviewCycle = 0; reviewCycle <= opts.maxReview; reviewCycle++) {
    await executor.implement(wu);

    let passed = false;
    for (let repair = 0; repair <= opts.maxRepair; repair++) {
      const { passed: p } = await executor.test(wu);
      if (p) { passed = true; break; }
      if (repair === opts.maxRepair) {
        return { ...base, escalationReason: `max repair (${opts.maxRepair}) exceeded` };
      }
      await executor.repair(wu, repair + 1);
    }

    if (!passed) {
      return { ...base, escalationReason: "tests never passed" };
    }

    const { approved, mustFix } = await executor.review(wu);
    if (approved) {
      return { ...base, success: true, testsPassed: true, reviewApproved: true };
    }

    if (reviewCycle === opts.maxReview) {
      return { ...base, escalationReason: `max review cycles (${opts.maxReview}) exceeded, mustFix: ${mustFix.join(", ")}` };
    }
  }

  return { ...base, escalationReason: "unexpected loop exit" };
}
