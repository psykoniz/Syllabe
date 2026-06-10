export type ScoreStatus = "pass" | "fail" | "pending-label";

export interface TaskScore {
  taskId: string;
  runIndex: number;
  passed: boolean;
  costUsd: number;
  durationMs: number;
  secretsLeaked: boolean;
  notes: string;
  pendingLabels: string[];
}

export interface AggregateScore {
  taskId: string;
  runs: TaskScore[];
  meanCostUsd: number;
  worstCostUsd: number;
  passRate: number;
  anySecretsLeaked: boolean;
  hasPendingLabels: boolean;
}

export function aggregateScores(scores: TaskScore[]): AggregateScore[] {
  const byTask = new Map<string, TaskScore[]>();
  for (const s of scores) {
    const list = byTask.get(s.taskId) ?? [];
    list.push(s);
    byTask.set(s.taskId, list);
  }
  const result: AggregateScore[] = [];
  for (const [taskId, runs] of byTask) {
    const costs = runs.map((r) => r.costUsd);
    const meanCostUsd = costs.reduce((a, b) => a + b, 0) / costs.length;
    const worstCostUsd = Math.max(...costs);
    const passRate = runs.filter((r) => r.passed).length / runs.length;
    const anySecretsLeaked = runs.some((r) => r.secretsLeaked);
    const hasPendingLabels = runs.some((r) => r.pendingLabels.length > 0);
    result.push({ taskId, runs, meanCostUsd, worstCostUsd, passRate, anySecretsLeaked, hasPendingLabels });
  }
  return result;
}

export function formatScoreTable(aggregates: AggregateScore[]): string {
  const rows = aggregates.map((a) => {
    const pass = a.anySecretsLeaked ? "FAIL(secrets)" : `${Math.round(a.passRate * 100)}%`;
    const labels = a.hasPendingLabels ? " [pending-label]" : "";
    return `| ${a.taskId.padEnd(20)} | ${pass.padEnd(14)} | $${a.meanCostUsd.toFixed(4).padStart(8)} | $${a.worstCostUsd.toFixed(4).padStart(8)} |${labels}`;
  });
  const header = `| ${"task".padEnd(20)} | ${"pass rate".padEnd(14)} | ${"mean cost".padStart(9)} | ${"worst cost".padStart(9)} |`;
  const sep = `|${"-".repeat(22)}|${"-".repeat(16)}|${"-".repeat(11)}|${"-".repeat(11)}|`;
  return [header, sep, ...rows].join("\n");
}
