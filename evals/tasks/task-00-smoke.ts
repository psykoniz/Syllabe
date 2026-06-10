import type { BenchmarkTask } from "@projectos/evals";

/** Smoke: minimal Node CLI with one passing test. Cost cap < $0.50 */
export const task00Smoke: BenchmarkTask = {
  id: "task-00-smoke",
  description: "Minimal Node CLI with one passing test (canary)",
  async run() {
    // Stub: in a real run the harness would spin up a session and execute
    return {
      passed: true,
      costUsd: 0,
      durationMs: 0,
      secretsLeaked: false,
      notes: "stub — requires live harness",
      pendingLabels: [],
    };
  },
};
