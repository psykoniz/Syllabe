import { Database } from "bun:sqlite";
import type { RunContext } from "./state-machine";

export interface CheckpointRow {
  runId: string;
  seq: number;
  state: string;
  workUnitIndex: number;
  repairCount: number;
  reviewCycleCount: number;
  escalationReason: string | null;
  ts: string;
}

export function ensureCheckpointTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      run_id            TEXT NOT NULL,
      seq               INTEGER NOT NULL,
      state             TEXT NOT NULL,
      work_unit_index   INTEGER NOT NULL,
      repair_count      INTEGER NOT NULL,
      review_cycle_count INTEGER NOT NULL,
      escalation_reason TEXT,
      ts                TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    )
  `);
}

export function writeCheckpoint(db: Database, runId: string, seq: number, ctx: RunContext): void {
  db.run(
    `INSERT OR REPLACE INTO checkpoints
       (run_id, seq, state, work_unit_index, repair_count, review_cycle_count, escalation_reason, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      runId,
      seq,
      ctx.state,
      ctx.workUnitIndex,
      ctx.repairCount,
      ctx.reviewCycleCount,
      ctx.escalationReason,
      new Date().toISOString(),
    ]
  );
}

export function loadCheckpoints(db: Database, runId: string): CheckpointRow[] {
  return db
    .query<CheckpointRow, string>(
      `SELECT run_id as runId, seq, state, work_unit_index as workUnitIndex,
              repair_count as repairCount, review_cycle_count as reviewCycleCount,
              escalation_reason as escalationReason, ts
       FROM checkpoints WHERE run_id = ? ORDER BY seq ASC`
    )
    .all(runId);
}

export function loadLatestCheckpoint(db: Database, runId: string): CheckpointRow | null {
  return db
    .query<CheckpointRow, string>(
      `SELECT run_id as runId, seq, state, work_unit_index as workUnitIndex,
              repair_count as repairCount, review_cycle_count as reviewCycleCount,
              escalation_reason as escalationReason, ts
       FROM checkpoints WHERE run_id = ? ORDER BY seq DESC LIMIT 1`
    )
    .get(runId) ?? null;
}
