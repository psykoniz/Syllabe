import type { BenchmarkTask } from "@projectos/evals";

/** Fix 3 known bugs in broken fixture repo */
export const task03BugFix: BenchmarkTask = {
  id: "task-03-bug-fix",
  description: "Fix 3 known bugs in broken fixture repo",
  async run() {
    return {
      passed: false,
      costUsd: 0,
      durationMs: 0,
      secretsLeaked: false,
      notes: "stub — requires live harness",
      pendingLabels: [],
    };
  },
};
