import type { BenchmarkTask } from "@projectos/evals";
import { runEvalTask } from "./_harness";

/** Transform a vague brief into a working MVP with tests */
export const task05LandingPage: BenchmarkTask = {
  id: "task-05-landing-page",
  description: "Transform a vague brief into a working MVP with tests",
  async run() {
    return runEvalTask({
      taskId: "task-05-landing-page",
      task: "Build an MVP for a URL shortener service. It must support: shorten(url) returns a short code, expand(code) returns the original URL, and track click counts. Use an in-memory store. Write bun:test tests covering shortening, expanding, click tracking, and handling unknown codes gracefully. All tests must pass with bun test.",
      pendingLabels: ["unnecessaryQuestions", "architectureQuality"],
    });
  },
};
