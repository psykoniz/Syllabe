import type { BenchmarkTask } from "@projectos/evals";

/** Todo app with auth (Next.js + local Postgres fixture) */
export const task01TodoApp: BenchmarkTask = {
  id: "task-01-todo-app",
  description: "Todo app with auth (Next.js + local Postgres fixture)",
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
