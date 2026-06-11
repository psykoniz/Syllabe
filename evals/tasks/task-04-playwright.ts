import type { BenchmarkTask } from "@projectos/evals";
import { runEvalTask } from "./_harness";

/** Add end-to-end tests for a simple counter module */
export const task04Playwright: BenchmarkTask = {
  id: "task-04-playwright",
  description: "Write end-to-end-style integration tests for a counter module",
  async run() {
    return runEvalTask({
      taskId: "task-04-playwright",
      task: "Build a Counter class in TypeScript with increment(), decrement(), reset(), and getValue() methods. Then write comprehensive bun:test integration tests covering: initial value, increment/decrement sequences, reset after modifications, and boundary behavior (decrement below zero should stay at zero). All tests must pass with bun test.",
      pendingLabels: ["architectureQuality"],
    });
  },
};
