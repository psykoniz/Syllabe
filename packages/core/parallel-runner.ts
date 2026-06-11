import type { WorkUnit } from "./state-machine";
import type { TaskExecutor, TaskResult, TaskRunnerOptions } from "./task-runner";
import { runWorkUnit } from "./task-runner";

export interface ParallelRunnerOptions extends TaskRunnerOptions {
  /** Max work units running concurrently (default 3) */
  concurrency?: number;
  /** Called when a unit starts / finishes — for progress reporting */
  onUnitStart?: (wu: WorkUnit) => void;
  onUnitDone?: (result: TaskResult) => void;
}

export interface ParallelRunResult {
  results: TaskResult[];
  /** true when every unit succeeded */
  allSucceeded: boolean;
  /** ids of units that escalated */
  escalated: string[];
}

/** A work unit may declare ids it depends on via `dependsOn`. Units without
 *  dependencies (or whose dependencies are complete) run concurrently up to
 *  the concurrency limit; dependent units wait for their prerequisites. */
export interface ParallelWorkUnit extends WorkUnit {
  dependsOn?: string[];
}

/**
 * Run work units in parallel waves, respecting declared dependencies.
 *
 * Scheduling: at each step, every unit whose dependencies are all complete
 * and that is not yet running is eligible; up to `concurrency` units run at
 * once. A unit whose dependency escalated is skipped with an escalation
 * (cascade failure) rather than run against a broken prerequisite.
 */
export async function runWorkUnitsParallel(
  units: ParallelWorkUnit[],
  executor: TaskExecutor,
  opts: ParallelRunnerOptions = { maxRepair: 3, maxReview: 2 }
): Promise<ParallelRunResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const results = new Map<string, TaskResult>();
  const running = new Map<string, Promise<void>>();
  const pending = new Set(units.map((u) => u.id));
  const byId = new Map(units.map((u) => [u.id, u]));

  const depsDone = (u: ParallelWorkUnit): boolean =>
    (u.dependsOn ?? []).every((d) => results.has(d));

  const depsFailed = (u: ParallelWorkUnit): string | null => {
    for (const d of u.dependsOn ?? []) {
      const r = results.get(d);
      if (r && !r.success) return d;
    }
    return null;
  };

  const launch = (u: ParallelWorkUnit): void => {
    pending.delete(u.id);
    opts.onUnitStart?.(u);
    const p = runWorkUnit(u, executor, opts)
      .then((r) => {
        results.set(u.id, r);
        opts.onUnitDone?.(r);
      })
      .catch((e) => {
        const r: TaskResult = {
          workUnitId: u.id,
          success: false,
          testsPassed: false,
          reviewApproved: false,
          escalationReason: `executor threw: ${(e as Error).message}`,
        };
        results.set(u.id, r);
        opts.onUnitDone?.(r);
      })
      .finally(() => {
        running.delete(u.id);
      });
    running.set(u.id, p);
  };

  while (pending.size > 0 || running.size > 0) {
    // Skip units whose dependencies failed (cascade) before scheduling
    for (const id of [...pending]) {
      const u = byId.get(id)!;
      const failedDep = depsFailed(u);
      if (failedDep) {
        pending.delete(id);
        const r: TaskResult = {
          workUnitId: id,
          success: false,
          testsPassed: false,
          reviewApproved: false,
          escalationReason: `dependency ${failedDep} failed — unit skipped`,
        };
        results.set(id, r);
        opts.onUnitDone?.(r);
      }
    }

    // Launch every eligible unit up to the concurrency limit
    for (const id of [...pending]) {
      if (running.size >= concurrency) break;
      const u = byId.get(id)!;
      if (depsDone(u)) launch(u);
    }

    if (running.size === 0 && pending.size > 0) {
      // Remaining units form a dependency cycle or reference unknown ids
      for (const id of [...pending]) {
        pending.delete(id);
        results.set(id, {
          workUnitId: id,
          success: false,
          testsPassed: false,
          reviewApproved: false,
          escalationReason: "unresolvable dependencies (cycle or unknown id)",
        });
      }
      break;
    }

    if (running.size > 0) {
      await Promise.race(running.values());
    }
  }

  // Return results in original unit order
  const ordered = units.map((u) => results.get(u.id)!);
  return {
    results: ordered,
    allSucceeded: ordered.every((r) => r.success),
    escalated: ordered.filter((r) => !r.success).map((r) => r.workUnitId),
  };
}
