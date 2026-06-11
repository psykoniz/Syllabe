import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import type { BenchmarkTask } from "@projectos/evals";
import { runEvalTask } from "./_harness";

/**
 * Hard task: multi-file refactoring under behavioural constraints.
 * Extract duplicated validation logic from two handlers into a shared
 * module WITHOUT changing observable behaviour (existing tests must
 * keep passing, and the duplication must actually be gone).
 */
const USERS_TS = `export interface CreateUserInput { email: string; name: string }

export function createUser(input: CreateUserInput): { ok: true } | { ok: false; error: string } {
  if (!input.email || !input.email.includes("@") || input.email.length > 254) {
    return { ok: false, error: "invalid email" };
  }
  if (!input.name || input.name.trim().length < 2 || input.name.length > 100) {
    return { ok: false, error: "invalid name" };
  }
  return { ok: true };
}
`;

const ORDERS_TS = `export interface CreateOrderInput { email: string; item: string; quantity: number }

export function createOrder(input: CreateOrderInput): { ok: true } | { ok: false; error: string } {
  if (!input.email || !input.email.includes("@") || input.email.length > 254) {
    return { ok: false, error: "invalid email" };
  }
  if (!input.item || input.item.trim().length === 0) {
    return { ok: false, error: "invalid item" };
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    return { ok: false, error: "invalid quantity" };
  }
  return { ok: true };
}
`;

const TESTS_TS = `import { describe, it, expect } from "bun:test";
import { createUser } from "../src/users";
import { createOrder } from "../src/orders";

describe("createUser", () => {
  it("accepts valid input", () => {
    expect(createUser({ email: "a@b.co", name: "Ann" })).toEqual({ ok: true });
  });
  it("rejects bad email", () => {
    expect(createUser({ email: "nope", name: "Ann" })).toEqual({ ok: false, error: "invalid email" });
  });
  it("rejects short name", () => {
    expect(createUser({ email: "a@b.co", name: "A" })).toEqual({ ok: false, error: "invalid name" });
  });
});

describe("createOrder", () => {
  it("accepts valid input", () => {
    expect(createOrder({ email: "a@b.co", item: "book", quantity: 2 })).toEqual({ ok: true });
  });
  it("rejects bad email", () => {
    expect(createOrder({ email: "x", item: "book", quantity: 1 })).toEqual({ ok: false, error: "invalid email" });
  });
  it("rejects zero quantity", () => {
    expect(createOrder({ email: "a@b.co", item: "book", quantity: 0 })).toEqual({ ok: false, error: "invalid quantity" });
  });
});
`;

export const task07Refactor: BenchmarkTask = {
  id: "task-07-refactor",
  description: "Extract duplicated email validation into a shared module without behaviour change",
  async run() {
    return runEvalTask({
      taskId: "task-07-refactor",
      task: `src/users.ts and src/orders.ts both duplicate the exact same email validation logic.
Refactor: extract the email validation into a new shared module src/validation.ts exposing
validateEmail(email: string): boolean (or equivalent), and make BOTH handlers use it.

Hard constraints:
- All existing tests in tests/handlers.test.ts must keep passing UNCHANGED — do not edit the test file.
- After the refactor, the string ".includes(\\"@\\")" must appear in exactly ONE source file (the shared module).
- Run bun test to confirm.`,
      setup(workspace) {
        mkdirSync(join(workspace, "src"), { recursive: true });
        mkdirSync(join(workspace, "tests"), { recursive: true });
        writeFileSync(join(workspace, "src/users.ts"), USERS_TS, "utf8");
        writeFileSync(join(workspace, "src/orders.ts"), ORDERS_TS, "utf8");
        writeFileSync(join(workspace, "tests/handlers.test.ts"), TESTS_TS, "utf8");
        spawnSync("git", ["add", "-A"], { cwd: workspace });
        spawnSync("git", ["commit", "-m", "seed: handlers with duplicated validation"], { cwd: workspace });
      },
      verify(workspace) {
        // 1. Tests must pass and the test file must be untouched
        const testFile = readFileSync(join(workspace, "tests/handlers.test.ts"), "utf8");
        if (testFile !== TESTS_TS) return false;
        const tests = spawnSync("bun", ["test"], { cwd: workspace, encoding: "utf8", timeout: 60_000 });
        if (tests.status !== 0) return false;

        // 2. Duplication must be gone: '@' check in exactly one src file
        const srcDir = join(workspace, "src");
        const grep = spawnSync("grep", ["-rl", '.includes("@")', srcDir], { encoding: "utf8" });
        const files = (grep.stdout ?? "").trim().split("\n").filter(Boolean);
        if (files.length !== 1) return false;

        // 3. Both handlers must import from the shared module
        const users = readFileSync(join(srcDir, "users.ts"), "utf8");
        const orders = readFileSync(join(srcDir, "orders.ts"), "utf8");
        return /from ["']\.\/validation["']/.test(users) && /from ["']\.\/validation["']/.test(orders);
      },
    });
  },
};
