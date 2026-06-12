import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { computeDurationSeconds, listRuns, loadRecentRuns, renderRunsTable } from "./runs";

const TMP = "/tmp/projectos-runs-test";

function openTestDb(name = "runs.db"): { db: Database; path: string } {
  mkdirSync(TMP, { recursive: true });
  const path = join(TMP, name);
  return { db: new Database(path, { create: true }), path };
}

function createKeyValueSchema(db: Database): void {
  db.run(`CREATE TABLE run_meta (run_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (run_id, key))`);
  db.run(`CREATE TABLE checkpoints (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    state TEXT NOT NULL,
    work_unit_index INTEGER NOT NULL,
    repair_count INTEGER NOT NULL,
    review_cycle_count INTEGER NOT NULL,
    escalation_reason TEXT,
    ts TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
  )`);
}

function setMeta(db: Database, runId: string, key: string, value: string): void {
  db.run(`INSERT INTO run_meta (run_id, key, value) VALUES (?, ?, ?)`, [runId, key, value]);
}

function addCheckpoint(db: Database, runId: string, seq: number, state: string, ts: string): void {
  db.run(
    `INSERT INTO checkpoints
       (run_id, seq, state, work_unit_index, repair_count, review_cycle_count, escalation_reason, ts)
     VALUES (?, ?, ?, 0, 0, 0, NULL, ?)`,
    [runId, seq, state, ts]
  );
}

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("loadRecentRuns", () => {
  it("loads recent runs from key-value run_meta with final checkpoint state and duration", () => {
    const { db } = openTestDb();
    try {
      createKeyValueSchema(db);
      const runId = "1234567890abcdef";
      setMeta(db, runId, "task", "Build a small dashboard with charts and filters");
      setMeta(db, runId, "model", "claude-sonnet-4-6");
      setMeta(db, runId, "startedAt", "2024-01-01T00:00:00.000Z");
      addCheckpoint(db, runId, 1, "IMPLEMENT", "2024-01-01T00:00:10.000Z");
      addCheckpoint(db, runId, 2, "COMPLETE", "2024-01-01T00:01:05.000Z");

      const rows = loadRecentRuns(db);

      expect(rows).toEqual([
        {
          runId,
          state: "COMPLETE",
          durationSeconds: 65,
          model: "claude-sonnet-4-6",
          task: "Build a small dashboard with charts and filters",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("uses the checkpoint with the highest seq as final state", () => {
    const { db } = openTestDb();
    try {
      createKeyValueSchema(db);
      setMeta(db, "run-a", "startedAt", "2024-01-01T00:00:00.000Z");
      setMeta(db, "run-a", "model", "default");
      setMeta(db, "run-a", "task", "Task");
      addCheckpoint(db, "run-a", 10, "ESCALATED", "2024-01-01T00:00:20.000Z");
      addCheckpoint(db, "run-a", 2, "TEST", "2024-01-01T00:00:30.000Z");

      expect(loadRecentRuns(db)[0].state).toBe("ESCALATED");
      expect(loadRecentRuns(db)[0].durationSeconds).toBe(20);
    } finally {
      db.close();
    }
  });

  it("limits output to the 10 most recent startedAt values", () => {
    const { db } = openTestDb();
    try {
      createKeyValueSchema(db);
      for (let i = 0; i < 12; i++) {
        const runId = `run-${String(i).padStart(2, "0")}`;
        setMeta(db, runId, "startedAt", `2024-01-01T00:${String(i).padStart(2, "0")}:00.000Z`);
        setMeta(db, runId, "model", "default");
        setMeta(db, runId, "task", `Task ${i}`);
        addCheckpoint(db, runId, 1, "COMPLETE", `2024-01-01T00:${String(i).padStart(2, "0")}:01.000Z`);
      }

      const rows = loadRecentRuns(db);

      expect(rows).toHaveLength(10);
      expect(rows[0].runId).toBe("run-11");
      expect(rows[9].runId).toBe("run-02");
    } finally {
      db.close();
    }
  });

  it("returns metadata rows safely when checkpoints table is absent", () => {
    const { db } = openTestDb();
    try {
      db.run(`CREATE TABLE run_meta (run_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (run_id, key))`);
      setMeta(db, "run-no-checkpoint", "startedAt", "2024-01-01T00:00:00.000Z");
      setMeta(db, "run-no-checkpoint", "model", "default");
      setMeta(db, "run-no-checkpoint", "task", "No checkpoints yet");

      expect(loadRecentRuns(db)).toEqual([
        {
          runId: "run-no-checkpoint",
          state: "unknown",
          durationSeconds: null,
          model: "default",
          task: "No checkpoints yet",
        },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("renderRunsTable", () => {
  it("formats the required text table and truncates task previews", () => {
    const output = renderRunsTable([
      {
        runId: "abcdef1234567890",
        state: "COMPLETE",
        durationSeconds: 12,
        model: "model-a",
        task: "This task has more than fifty characters and should be truncated cleanly",
      },
    ]);

    expect(output).toBe(
      "ID | State | Duration(s) | Model | Task\n" +
        "abcdef12 | COMPLETE | 12 | model-a | This task has more than fifty characters and shoul"
    );
  });
});

describe("computeDurationSeconds", () => {
  it("returns null for missing or invalid dates and clamps negative durations", () => {
    expect(computeDurationSeconds(null, "2024-01-01T00:00:01.000Z")).toBeNull();
    expect(computeDurationSeconds("bad", "2024-01-01T00:00:01.000Z")).toBeNull();
    expect(computeDurationSeconds("2024-01-01T00:00:10.000Z", "2024-01-01T00:00:01.000Z")).toBe(0);
  });
});

describe("listRuns", () => {
  it("renders only the header for a missing database", () => {
    expect(listRuns(join(TMP, "missing.db"))).toBe("ID | State | Duration(s) | Model | Task");
  });

  it("renders recent runs ordered with final state, duration, model, and truncated fields", () => {
    const { db, path } = openTestDb("integrated-runs.db");
    try {
      createKeyValueSchema(db);

      const olderRunId = "older-run-abcdefgh";
      setMeta(db, olderRunId, "startedAt", "2024-01-01T00:00:00.000Z");
      setMeta(db, olderRunId, "model", "older-model");
      setMeta(db, olderRunId, "task", "Older task");
      addCheckpoint(db, olderRunId, 1, "IMPLEMENT", "2024-01-01T00:00:03.000Z");
      addCheckpoint(db, olderRunId, 5, "DONE", "2024-01-01T00:00:07.000Z");

      const newerRunId = "newer-run-1234567890";
      setMeta(db, newerRunId, "startedAt", "2024-01-01T00:01:00.000Z");
      setMeta(db, newerRunId, "model", "newer-model");
      setMeta(db, newerRunId, "task", "12345678901234567890123456789012345678901234567890EXTRA");
      addCheckpoint(db, newerRunId, 1, "IMPLEMENT", "2024-01-01T00:01:05.000Z");
      addCheckpoint(db, newerRunId, 3, "REVIEW", "2024-01-01T00:01:45.000Z");
    } finally {
      db.close();
    }

    expect(listRuns(path)).toBe(
      "ID | State | Duration(s) | Model | Task\n" +
        "newer-ru | REVIEW | 45 | newer-model | 12345678901234567890123456789012345678901234567890\n" +
        "older-ru | DONE | 7 | older-model | Older task"
    );
  });
});
