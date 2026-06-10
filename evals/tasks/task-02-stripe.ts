import type { BenchmarkTask } from "@projectos/evals";

/** Add Stripe subscription (test mode, recorded webhooks) to fixture app */
export const task02Stripe: BenchmarkTask = {
  id: "task-02-stripe",
  description: "Add Stripe subscription (test mode, recorded webhooks) to fixture app",
  async run() {
    return {
      passed: false,
      costUsd: 0,
      durationMs: 0,
      secretsLeaked: false,
      notes: "stub — requires live harness",
      pendingLabels: ["unnecessaryQuestions"],
    };
  },
};
