export interface RunSummary {
  run_id: string;
  state: string;
  work_unit_index: number;
  escalation_reason: string | null;
  ts: string;
  created_at: string;
  task?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  durationMs: number;
  startedAt: string;
}

export interface CheckpointRow {
  run_id: string;
  state: string;
  work_unit_index: number;
  escalation_reason: string | null;
  ts: string;
  created_at: string;
}

export interface TraceEvent {
  ts: string;
  runId: string;
  phase: string;
  role: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  meta?: Record<string, unknown>;
}

export interface CostSummary {
  totalUsd: number;
  byModel: Record<string, { inputTokens: number; outputTokens: number; usd: number }>;
}

export interface RunDetail {
  run: CheckpointRow & { task?: string };
  checkpoints: CheckpointRow[];
  traces: TraceEvent[];
  cost: CostSummary;
}

export interface PendingApproval {
  runId: string;
  tool: string;
  args: unknown;
  id: string;
}

export type PhaseGroup = "planning" | "working" | "quality" | "finishing" | "escalated";

export function phaseGroup(state: string): PhaseGroup {
  const s = state.toUpperCase();
  if (["INTAKE", "CLARIFY", "DESIGN", "PLAN"].includes(s)) return "planning";
  if (["IMPLEMENT", "TEST", "REPAIR"].includes(s)) return "working";
  if (["REVIEW"].includes(s)) return "quality";
  if (["DOCUMENT", "LEARN", "COMPLETE"].includes(s)) return "finishing";
  return "escalated";
}

export function isRunning(state: string): boolean {
  return !["COMPLETE", "ESCALATED"].includes(state.toUpperCase());
}
