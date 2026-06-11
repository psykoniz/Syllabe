import { describe, it, expect } from "bun:test";
import { runWorkUnitsParallel } from "./parallel-runner";
import type { ParallelWorkUnit } from "./parallel-runner";
import type { TaskExecutor } from "./task-runner";

function makeExecutor(opts?: {
  failTests?: Set<string>;
  log?: Array<{ id: string; at: number }>;
  delayMs?: number;
}): TaskExecutor {
  const log = opts?.log;
  let clock = 0;
  return {
    async implement(wu) {
      log?.push({ id: wu.id, at: clock++ });
      if (opts?.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return { success: true };
    },
    async test(wu) {
      return { passed: !opts?.failTests?.has(wu.id) };
    },
    async repair() {},
    async review() {
      return { approved: true, mustFix: [] };
    },
  };
}

const wu = (id: string, dependsOn?: string[]): ParallelWorkUnit => ({
  id,
  description: `unit ${id}`,
  ...(dependsOn ? { dependsOn } : {}),
});

describe("runWorkUnitsParallel", () => {
  it("runs all independent units and succeeds", async () => {
    const result = await runWorkUnitsParallel(
      [wu("a"), wu("b"), wu("c")],
      makeExecutor(),
      { maxRepair: 1, maxReview: 1, concurrency: 3 }
    );
    expect(result.allSucceeded).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.escalated).toHaveLength(0);
  });

  it("returns results in original unit order", async () => {
    const result = await runWorkUnitsParallel(
      [wu("z"), wu("a"), wu("m")],
      makeExecutor(),
      { maxRepair: 1, maxReview: 1 }
    );
    expect(result.results.map((r) => r.workUnitId)).toEqual(["z", "a", "m"]);
  });

  it("respects concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const executor: TaskExecutor = {
      async implement() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return { success: true };
      },
      async test() { return { passed: true }; },
      async repair() {},
      async review() { return { approved: true, mustFix: [] }; },
    };
    await runWorkUnitsParallel(
      [wu("a"), wu("b"), wu("c"), wu("d"), wu("e")],
      executor,
      { maxRepair: 1, maxReview: 1, concurrency: 2 }
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("waits for dependencies before launching dependent units", async () => {
    const order: string[] = [];
    const executor: TaskExecutor = {
      async implement(unit) {
        order.push(unit.id);
        await new Promise((r) => setTimeout(r, 10));
        return { success: true };
      },
      async test() { return { passed: true }; },
      async repair() {},
      async review() { return { approved: true, mustFix: [] }; },
    };
    await runWorkUnitsParallel(
      [wu("c", ["a", "b"]), wu("a"), wu("b")],
      executor,
      { maxRepair: 1, maxReview: 1, concurrency: 3 }
    );
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("a"));
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("b"));
  });

  it("skips units whose dependency escalated (cascade)", async () => {
    const result = await runWorkUnitsParallel(
      [wu("a"), wu("b", ["a"])],
      makeExecutor({ failTests: new Set(["a"]) }),
      { maxRepair: 0, maxReview: 0 }
    );
    expect(result.allSucceeded).toBe(false);
    const b = result.results.find((r) => r.workUnitId === "b")!;
    expect(b.escalationReason).toContain("dependency a failed");
  });

  it("flags dependency cycles as unresolvable", async () => {
    const result = await runWorkUnitsParallel(
      [wu("a", ["b"]), wu("b", ["a"])],
      makeExecutor(),
      { maxRepair: 1, maxReview: 1 }
    );
    expect(result.allSucceeded).toBe(false);
    for (const r of result.results) {
      expect(r.escalationReason).toContain("unresolvable");
    }
  });

  it("captures executor exceptions as escalations", async () => {
    const executor: TaskExecutor = {
      async implement() { throw new Error("boom"); },
      async test() { return { passed: true }; },
      async repair() {},
      async review() { return { approved: true, mustFix: [] }; },
    };
    const result = await runWorkUnitsParallel([wu("a")], executor, {
      maxRepair: 1,
      maxReview: 1,
    });
    expect(result.results[0].escalationReason).toContain("boom");
  });

  it("reports progress through onUnitStart/onUnitDone", async () => {
    const started: string[] = [];
    const done: string[] = [];
    await runWorkUnitsParallel([wu("a"), wu("b")], makeExecutor(), {
      maxRepair: 1,
      maxReview: 1,
      onUnitStart: (u) => started.push(u.id),
      onUnitDone: (r) => done.push(r.workUnitId),
    });
    expect(started.sort()).toEqual(["a", "b"]);
    expect(done.sort()).toEqual(["a", "b"]);
  });
});
