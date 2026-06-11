import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import type { BenchmarkTask } from "@projectos/evals";
import { runEvalTask } from "./_harness";

/**
 * Hard task: fix a subtle off-by-one + reference-sharing bug inside an
 * EXISTING codebase without breaking the passing tests around it.
 *
 * The bug: `chunk()` reuses the same array reference for every chunk and
 * slices with an off-by-one bound. Tests for `flatten` and `unique` pass
 * already; tests for `chunk` are intentionally missing — the agent must
 * find the bug from the task description, fix it, and add tests.
 */
const COLLECTIONS_TS = `/** Array helpers used across the project. */

export function flatten<T>(nested: T[][]): T[] {
  return nested.reduce((acc, cur) => acc.concat(cur), [] as T[]);
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("size must be > 0");
  const chunks: T[][] = [];
  let current: T[] = [];
  for (let i = 0; i <= items.length; i++) {
    current.push(items[i]);
    if (current.length === size) {
      chunks.push(current);
      current.length = 0;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
`;

const EXISTING_TESTS = `import { describe, it, expect } from "bun:test";
import { flatten, unique } from "../src/collections";

describe("flatten", () => {
  it("flattens one level", () => {
    expect(flatten([[1, 2], [3]])).toEqual([1, 2, 3]);
  });
});

describe("unique", () => {
  it("removes duplicates", () => {
    expect(unique([1, 1, 2, 3, 3])).toEqual([1, 2, 3]);
  });
});
`;

export const task06SubtleBug: BenchmarkTask = {
  id: "task-06-subtle-bug",
  description: "Fix a subtle chunk() bug in an existing codebase without breaking passing tests",
  async run() {
    return runEvalTask({
      taskId: "task-06-subtle-bug",
      task: `The file src/collections.ts contains a chunk(items, size) function that is broken:
callers report it returns wrong chunks, sometimes containing 'undefined', and all chunks
appear to be empty or identical. flatten() and unique() work and have passing tests in
tests/collections.test.ts — do NOT break them.

Diagnose the bug in chunk(), fix it, add bun:test tests for chunk() covering: even split,
remainder chunk, size larger than the array, and that returned chunks are independent
arrays. Run the full test suite and make sure everything passes.`,
      setup(workspace) {
        mkdirSync(join(workspace, "src"), { recursive: true });
        mkdirSync(join(workspace, "tests"), { recursive: true });
        writeFileSync(join(workspace, "src/collections.ts"), COLLECTIONS_TS, "utf8");
        writeFileSync(join(workspace, "tests/collections.test.ts"), EXISTING_TESTS, "utf8");
        spawnSync("git", ["add", "-A"], { cwd: workspace });
        spawnSync("git", ["commit", "-m", "seed: collections module with broken chunk()"], { cwd: workspace });
      },
      verify(workspace) {
        // Objective check: run the suite AND assert chunk actually works now
        const probe = `
import { chunk } from "./src/collections";
const r = chunk([1,2,3,4,5], 2);
if (JSON.stringify(r) !== "[[1,2],[3,4],[5]]") { console.error("chunk broken:", JSON.stringify(r)); process.exit(1); }
r[0].push(99);
if (r[1].length !== 2) { console.error("chunks share references"); process.exit(1); }
console.log("ok");
`;
        writeFileSync(join(workspace, "__probe.ts"), probe, "utf8");
        const tests = spawnSync("bun", ["test"], { cwd: workspace, encoding: "utf8", timeout: 60_000 });
        const probeRun = spawnSync("bun", ["__probe.ts"], { cwd: workspace, encoding: "utf8", timeout: 30_000 });
        return tests.status === 0 && probeRun.status === 0;
      },
    });
  },
};
