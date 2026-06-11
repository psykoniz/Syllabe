import type { BenchmarkTask } from "@projectos/evals";
import { runEvalTask } from "./_harness";

/** Smoke canary: minimal Node CLI with one passing test. Cost cap < $0.50. */
export const task00Smoke: BenchmarkTask = {
  id: "task-00-smoke",
  description: "Minimal Node CLI with one passing test (canary)",
  async run() {
    return runEvalTask({
      taskId: "task-00-smoke",
      task: "Build a minimal Node.js CLI tool. It must have a single command `hello` that prints 'Hello, world!'. Write a bun:test test that calls the function and asserts the output. All tests must pass with `bun test`.",
      costCapUsd: 0.5,
    });
  },
};
