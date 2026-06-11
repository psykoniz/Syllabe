import type { BenchmarkTask } from "@projectos/evals";
import { runEvalTask } from "./_harness";

/** Todo app with auth (Next.js + local Postgres fixture) */
export const task01TodoApp: BenchmarkTask = {
  id: "task-01-todo-app",
  description: "Todo app with auth (Next.js + local Postgres fixture)",
  async run() {
    return runEvalTask({
      taskId: "task-01-todo-app",
      task: "Build a simple todo list application using TypeScript. It must support: create a todo item, list all todos, mark a todo as done, delete a todo. Use an in-memory store (no database required). Write bun:test tests covering all four operations. All tests must pass with `bun test`.",
      pendingLabels: ["unnecessaryQuestions", "architectureQuality"],
    });
  },
};
