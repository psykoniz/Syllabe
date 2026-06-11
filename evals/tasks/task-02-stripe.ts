import type { BenchmarkTask } from "@projectos/evals";
import { runEvalTask } from "./_harness";

/** Add payment processing logic (Stripe-style, mocked) */
export const task02Stripe: BenchmarkTask = {
  id: "task-02-stripe",
  description: "Add subscription billing logic (mocked Stripe-style)",
  async run() {
    return runEvalTask({
      taskId: "task-02-stripe",
      task: "Build a subscription billing module in TypeScript. It must support: createSubscription(userId, plan), cancelSubscription(subscriptionId), getSubscription(subscriptionId), and listActiveSubscriptions(). Use an in-memory store. Plans are 'basic' and 'pro'. Write bun:test tests for all operations including cancellation and listing. All tests must pass with `bun test`.",
      pendingLabels: ["unnecessaryQuestions"],
    });
  },
};
