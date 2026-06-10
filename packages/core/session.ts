import Anthropic from "@anthropic-ai/sdk";
import type { BetaManagedAgentsStreamSessionEvents } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { appendTrace } from "@projectos/telemetry";

export interface SessionConfig {
  agentId: string;
  environmentId: string;
  dbPath: string;
  tracePath: string;
}

export interface RunRecord {
  runId: string;
  agentId: string;
  sessionId: string | null;
  status: "running" | "complete" | "failed";
  createdAt: string;
  updatedAt: string;
}

function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id    TEXT PRIMARY KEY,
      agent_id  TEXT NOT NULL,
      session_id TEXT,
      status    TEXT NOT NULL DEFAULT 'running',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return db;
}

export class ProjectSession {
  private client: Anthropic;
  private db: Database;
  readonly runId: string;

  constructor(private config: SessionConfig) {
    this.client = new Anthropic();
    this.db = openDb(config.dbPath);
    this.runId = randomUUID();
  }

  private now(): string {
    return new Date().toISOString();
  }

  private async drainStream(sessionId: string): Promise<{ inputTokens: number; outputTokens: number }> {
    let inputTokens = 0;
    let outputTokens = 0;

    const stream = await this.client.beta.sessions.events.stream(sessionId);
    for await (const event of stream as AsyncIterable<BetaManagedAgentsStreamSessionEvents>) {
      if (event.type === "span.model_request_end") {
        inputTokens += event.model_usage.input_tokens;
        outputTokens += event.model_usage.output_tokens;
      }
    }

    return { inputTokens, outputTokens };
  }

  async start(userPrompt: string): Promise<void> {
    const now = this.now();
    this.db.run(
      `INSERT INTO runs (run_id, agent_id, session_id, status, created_at, updated_at)
       VALUES (?, ?, NULL, 'running', ?, ?)`,
      [this.runId, this.config.agentId, now, now]
    );

    const start = Date.now();

    const session = await this.client.beta.sessions.create({
      agent: this.config.agentId,
      environment_id: this.config.environmentId,
    });

    this.db.run(
      `UPDATE runs SET session_id = ?, updated_at = ? WHERE run_id = ?`,
      [session.id, this.now(), this.runId]
    );

    await this.client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: userPrompt }] }],
    });

    const { inputTokens, outputTokens } = await this.drainStream(session.id);
    const durationMs = Date.now() - start;

    this.db.run(
      `UPDATE runs SET status = 'complete', updated_at = ? WHERE run_id = ?`,
      [this.now(), this.runId]
    );

    appendTrace(this.config.tracePath, {
      ts: this.now(),
      runId: this.runId,
      phase: "SESSION",
      role: "core",
      model: "unknown",
      inputTokens,
      outputTokens,
      durationMs,
    });
  }

  async resume(sessionId: string, message: string): Promise<void> {
    const start = Date.now();

    await this.client.beta.sessions.events.send(sessionId, {
      events: [{ type: "user.message", content: [{ type: "text", text: message }] }],
    });

    const { inputTokens, outputTokens } = await this.drainStream(sessionId);
    const durationMs = Date.now() - start;

    this.db.run(
      `UPDATE runs SET updated_at = ? WHERE run_id = ?`,
      [this.now(), this.runId]
    );

    appendTrace(this.config.tracePath, {
      ts: this.now(),
      runId: this.runId,
      phase: "RESUME",
      role: "core",
      model: "unknown",
      inputTokens,
      outputTokens,
      durationMs,
    });
  }

  getRecord(): RunRecord | null {
    return this.db
      .query<RunRecord, string>(
        `SELECT run_id as runId, agent_id as agentId, session_id as sessionId,
                status, created_at as createdAt, updated_at as updatedAt
         FROM runs WHERE run_id = ?`
      )
      .get(this.runId) ?? null;
  }

  listRuns(): RunRecord[] {
    return this.db
      .query<RunRecord, []>(
        `SELECT run_id as runId, agent_id as agentId, session_id as sessionId,
                status, created_at as createdAt, updated_at as updatedAt
         FROM runs ORDER BY created_at DESC`
      )
      .all();
  }

  close(): void {
    this.db.close();
  }
}
