import type { BenchmarkTask } from "@projectos/evals";

/** Transform a vague brief into a working MVP landing page */
export const task05LandingPage: BenchmarkTask = {
  id: "task-05-landing-page",
  description: "Transform a vague brief into a working MVP landing page",
  async run() {
    return {
      passed: false,
      costUsd: 0,
      durationMs: 0,
      secretsLeaked: false,
      notes: "stub — requires live harness",
      pendingLabels: ["unnecessaryQuestions", "architectureQuality"],
    };
  },
};
