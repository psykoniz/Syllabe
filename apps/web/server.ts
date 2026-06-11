import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const PORT = parseInt(process.env.PORT ?? "4321", 10);
const DB_PATH = process.env.PROJECTOS_DB_PATH ?? join(process.cwd(), ".projectos", "runs.db");
const TRACES_PATH = process.env.PROJECTOS_TRACES_PATH ?? join(process.cwd(), ".projectos", "traces.jsonl");
const APPROVALS_DIR = join(process.cwd(), ".projectos", "approvals");
const DIST_DIR = join(import.meta.dir, "dist");
const CLI_PATH = join(import.meta.dir, "../../apps/cli/index.ts");

function openDb(): Database | null {
  if (!existsSync(DB_PATH)) return null;
  return new Database(DB_PATH, { readonly: true });
}

function openDbRw(): Database | null {
  mkdirSync(join(process.cwd(), ".projectos"), { recursive: true });
  return new Database(DB_PATH, { create: true });
}

interface RunRow {
  run_id: string;
  state: string;
  work_unit_index: number;
  escalation_reason: string | null;
  ts: string;
  created_at: string;
}

interface TraceEvent {
  ts: string;
  runId: string;
  phase: string;
  role: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs: number;
  meta?: Record<string, unknown>;
}

function getRunMeta(db: Database, runId: string): Record<string, string> {
  try {
    const rows = db
      .query<{ key: string; value: string }, string>(
        `SELECT key, value FROM run_meta WHERE run_id = ?`
      )
      .all(runId);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  }
}

function listRuns(): Array<RunRow & { task?: string }> {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db
      .query<RunRow, []>(`
        SELECT c.run_id, c.state, c.work_unit_index, c.escalation_reason, c.ts, c.ts as created_at
        FROM checkpoints c
        INNER JOIN (
          SELECT run_id, MAX(seq) as max_seq FROM checkpoints GROUP BY run_id
        ) latest ON c.run_id = latest.run_id AND c.seq = latest.max_seq
        ORDER BY c.ts DESC
      `)
      .all();

    return rows.map((r) => {
      const meta = getRunMeta(db, r.run_id);
      return { ...r, task: meta.task };
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function getRunDetail(runId: string): { run: (RunRow & { task?: string }) | null; checkpoints: RunRow[] } {
  const db = openDb();
  if (!db) return { run: null, checkpoints: [] };
  try {
    const run = db
      .query<RunRow, string>(`
        SELECT c.run_id, c.state, c.work_unit_index, c.escalation_reason, c.ts, c.ts as created_at
        FROM checkpoints c
        INNER JOIN (
          SELECT run_id, MAX(seq) as max_seq FROM checkpoints WHERE run_id = ? GROUP BY run_id
        ) latest ON c.run_id = latest.run_id AND c.seq = latest.max_seq
      `)
      .get(runId) ?? null;

    const checkpoints = db
      .query<RunRow, string>(`
        SELECT run_id, state, work_unit_index, escalation_reason, ts, ts as created_at
        FROM checkpoints WHERE run_id = ? ORDER BY seq ASC
      `)
      .all(runId);

    if (!run) return { run: null, checkpoints };
    const meta = getRunMeta(db, runId);
    return { run: { ...run, task: meta.task }, checkpoints };
  } catch {
    return { run: null, checkpoints: [] };
  } finally {
    db.close();
  }
}

function readTraces(runId: string): TraceEvent[] {
  if (!existsSync(TRACES_PATH)) return [];
  const lines = readFileSync(TRACES_PATH, "utf8").split("\n").filter(Boolean);
  const events: TraceEvent[] = [];
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as TraceEvent;
      if (ev.runId === runId) events.push(ev);
    } catch {
      // skip malformed
    }
  }
  return events;
}

const PRICE: Record<string, { input: number; output: number }> = {
  "claude-fable-5":    { input: 10.0, output: 50.0 },
  "claude-opus-4-8":   { input: 5.0,  output: 25.0 },
  "claude-sonnet-4-6": { input: 3.0,  output: 15.0 },
  "claude-haiku-4-5":  { input: 1.0,  output: 5.0  },
};

// Prompt caching multipliers (× input price): read ≈ 0.1, write ≈ 1.25.
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

function computeCostFromTraces(traces: TraceEvent[]) {
  const byModel: Record<
    string,
    { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; usd: number }
  > = {};
  let totalUsd = 0;
  for (const t of traces) {
    const price = PRICE[t.model] ?? { input: 0, output: 0 };
    const cacheRead = t.cacheReadTokens ?? 0;
    const cacheWrite = t.cacheWriteTokens ?? 0;
    const usd =
      (t.inputTokens / 1e6) * price.input +
      (t.outputTokens / 1e6) * price.output +
      (cacheRead / 1e6) * price.input * CACHE_READ_MULT +
      (cacheWrite / 1e6) * price.input * CACHE_WRITE_MULT;
    if (!byModel[t.model]) {
      byModel[t.model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0 };
    }
    byModel[t.model].inputTokens += t.inputTokens;
    byModel[t.model].outputTokens += t.outputTokens;
    byModel[t.model].cacheReadTokens += cacheRead;
    byModel[t.model].cacheWriteTokens += cacheWrite;
    byModel[t.model].usd += usd;
    totalUsd += usd;
  }
  return { totalUsd, byModel };
}

function getPendingApprovals(): Array<{ runId: string; tool: string; args: unknown; id: string }> {
  const toolCallsPath = join(process.cwd(), ".projectos", "tool-calls.jsonl");
  if (!existsSync(toolCallsPath)) return [];
  const results: Array<{ runId: string; tool: string; args: unknown; id: string }> = [];
  try {
    const lines = readFileSync(toolCallsPath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const ev = JSON.parse(line) as {
        runId?: string; tool?: string; args?: unknown; id?: string; status?: string;
      };
      if (ev.status === "pending" && ev.runId && ev.tool) {
        const approvalFile = join(APPROVALS_DIR, `${ev.runId}.json`);
        if (!existsSync(approvalFile)) {
          results.push({ runId: ev.runId!, tool: ev.tool!, args: ev.args, id: ev.id ?? "" });
        }
      }
    }
  } catch {
    // ignore
  }
  return results;
}

function writeApproval(runId: string, decision: "approve" | "deny"): void {
  mkdirSync(APPROVALS_DIR, { recursive: true });
  writeFileSync(
    join(APPROVALS_DIR, `${runId}.json`),
    JSON.stringify({ decision, ts: new Date().toISOString() }),
    "utf8"
  );
}

/** Launch a build in the background (detached process) */
function spawnBuild(opts: { task: string; model?: string; autoYes?: boolean; sandbox?: boolean }): string {
  const { randomUUID } = require("crypto") as { randomUUID: () => string };
  const runId = randomUUID();
  const args = [
    "bun", CLI_PATH, "build",
    "--task", opts.task,
    "--db", DB_PATH,
    "--traces", TRACES_PATH,
  ];
  if (opts.model) args.push("--model-override", opts.model);
  if (opts.autoYes) args.push("--yes");
  if (opts.sandbox) args.push("--sandbox");

  // Write run_meta before spawning so the UI can show the task immediately
  const db = openDbRw();
  if (db) {
    try {
      db.run(`CREATE TABLE IF NOT EXISTS run_meta (run_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (run_id, key))`);
      db.run(`INSERT OR REPLACE INTO run_meta VALUES (?, 'task', ?)`, [runId, opts.task]);
      db.run(`INSERT OR REPLACE INTO run_meta VALUES (?, 'model', ?)`, [runId, opts.model ?? "default"]);
      db.run(`INSERT OR REPLACE INTO run_meta VALUES (?, 'startedAt', ?)`, [runId, new Date().toISOString()]);
    } finally {
      db.close();
    }
  }

  // Bun.spawn with detached=false — runs in background relative to the HTTP request
  Bun.spawn(args, {
    env: { ...process.env, PROJECTOS_RUN_ID: runId },
    stdout: "pipe",
    stderr: "pipe",
  });

  return runId;
}

function serveFile(filePath: string): Response {
  if (!existsSync(filePath)) return new Response("Not found", { status: 404 });
  const file = Bun.file(filePath);
  return new Response(file);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // POST /api/runs — launch a new build
    if (pathname === "/api/runs" && req.method === "POST") {
      try {
        const body = (await req.json()) as {
          task: string;
          model?: string;
          autoYes?: boolean;
          sandbox?: boolean;
        };
        if (!body.task?.trim()) return json({ error: "task is required" }, 400);
        const runId = spawnBuild(body);
        return json({ runId }, 202);
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // GET /api/runs
    if (pathname === "/api/runs" && req.method === "GET") {
      const runs = listRuns();
      const enriched = runs.map((r) => {
        const traces = readTraces(r.run_id);
        const cost = computeCostFromTraces(traces);
        const totalInputTokens = traces.reduce((s, t) => s + t.inputTokens, 0);
        const totalOutputTokens = traces.reduce((s, t) => s + t.outputTokens, 0);
        const durationMs = traces.reduce((s, t) => s + t.durationMs, 0);
        return {
          ...r,
          totalInputTokens,
          totalOutputTokens,
          totalCostUsd: cost.totalUsd,
          durationMs,
          startedAt: r.ts,
        };
      });
      return json(enriched);
    }

    // GET /api/runs/:id
    const runDetailMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runDetailMatch && req.method === "GET") {
      const runId = runDetailMatch[1];
      const { run, checkpoints } = getRunDetail(runId);
      if (!run) return json({ error: "not found" }, 404);
      const traces = readTraces(runId);
      const cost = computeCostFromTraces(traces);
      return json({ run, checkpoints, traces, cost });
    }

    // GET /api/runs/:id/events — SSE tail
    const eventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (eventsMatch && req.method === "GET") {
      const runId = eventsMatch[1];

      const existingLines: string[] = [];
      let offset = 0;
      if (existsSync(TRACES_PATH)) {
        const content = readFileSync(TRACES_PATH, "utf8");
        const lines = content.split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const ev = JSON.parse(line) as TraceEvent;
            if (ev.runId === runId) existingLines.push(line);
          } catch { /* skip */ }
        }
        offset = content.length;
      }

      const stream = new ReadableStream({
        start(controller) {
          const enc = (s: string) => new TextEncoder().encode(s);
          for (const line of existingLines) {
            controller.enqueue(enc(`data: ${line}\n\n`));
          }

          if (!existsSync(TRACES_PATH)) { controller.close(); return; }

          let currentOffset = offset;
          const interval = setInterval(() => {
            try {
              const file = Bun.file(TRACES_PATH);
              const size = file.size;
              if (size > currentOffset) {
                const content = readFileSync(TRACES_PATH, "utf8");
                const newLines = content.slice(currentOffset).split("\n").filter(Boolean);
                for (const line of newLines) {
                  try {
                    const ev = JSON.parse(line) as TraceEvent;
                    if (ev.runId === runId) controller.enqueue(enc(`data: ${line}\n\n`));
                  } catch { /* skip */ }
                }
                currentOffset = size;
              }
            } catch {
              clearInterval(interval);
              try { controller.close(); } catch { /* already closed */ }
            }
          }, 500);

          setTimeout(() => {
            clearInterval(interval);
            try { controller.close(); } catch { /* already closed */ }
          }, 10 * 60 * 1000);
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // POST /api/runs/:id/approve|deny
    const approveMatch = pathname.match(/^\/api\/runs\/([^/]+)\/(approve|deny)$/);
    if (approveMatch && req.method === "POST") {
      const runId = approveMatch[1];
      const decision = approveMatch[2] as "approve" | "deny";
      writeApproval(runId, decision);
      return json({ ok: true, decision });
    }

    // GET /api/approvals
    if (pathname === "/api/approvals" && req.method === "GET") {
      return json(getPendingApprovals());
    }

    // Unknown API
    if (pathname.startsWith("/api")) {
      return json({ error: "not found" }, 404);
    }

    // Static files
    const staticPath = join(DIST_DIR, pathname === "/" ? "index.html" : pathname);
    if (existsSync(staticPath) && !staticPath.endsWith("/")) {
      return serveFile(staticPath);
    }

    // SPA fallback
    const indexPath = join(DIST_DIR, "index.html");
    if (existsSync(indexPath)) return serveFile(indexPath);

    return new Response(
      "ProjectOS Web UI — run `bun run build` first or `bun run dev` for development.",
      { status: 200, headers: { "Content-Type": "text/plain" } }
    );
  },
});

console.log(`\nProjectOS Web UI  →  http://localhost:${PORT}`);
console.log(`DB: ${DB_PATH}\n`);
