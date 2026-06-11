import type { BenchmarkTask } from "@projectos/evals";
import { runEvalTask } from "./_harness";

/** Fix 3 known bugs in a broken TypeScript module */
export const task03BugFix: BenchmarkTask = {
  id: "task-03-bug-fix",
  description: "Fix 3 known bugs in a broken TypeScript module",
  async run() {
    return runEvalTask({
      taskId: "task-03-bug-fix",
      task: `Fix the following three bugs in a TypeScript utility module:
1. A sum(numbers) function that returns NaN when given an empty array (should return 0)
2. A formatDate(date) function that adds an extra day due to UTC/local timezone confusion (should return the local date as YYYY-MM-DD)
3. A debounce(fn, delay) function where the timer is never cleared on repeated calls (should reset the timer on each call)

Create the module with the buggy implementations first, write bun:test tests that expose each bug, fix the bugs, and confirm all tests pass with bun test.`,
    });
  },
};
