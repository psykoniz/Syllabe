export interface RunSummary {
  run_id: string;
  state: string;
  work_unit_index: number;
  escalation_reason: string | null;
  ts: string;
  created_at: string;
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
  run: CheckpointRow;
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
