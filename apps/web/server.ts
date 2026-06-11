import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync, watchFile } from "fs";
import { join, dirname } from "path";

const PORT = parseInt(process.env.PORT ?? "4321", 10);
const DB_PATH = process.env.PROJECTOS_DB_PATH ?? join(process.cwd(), ".projectos", "runs.db");
const TRACES_PATH = process.env.PROJECTOS_TRACES_PATH ?? join(process.cwd(), ".projectos", "traces.jsonl");
const APPROVALS_DIR = join(process.cwd(), ".projectos", "approvals");
const DIST_DIR = join(import.meta.dir, "dist");

function openDb(): Database | null {
  if (!existsSync(DB_PATH)) return null;
  return new Database(DB_PATH, { readonly: true });
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
  durationMs: number;
  meta?: Record<string, unknown>;
}

function listRuns(): RunRow[] {
  const db = openDb();
  if (!db) return [];
  try {
    // Get latest checkpoint per run
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
    return rows;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function getRunDetail(runId: string): { run: RunRow | null; checkpoints: RunRow[] } {
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

    return { run, checkpoints };
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

function computeCostFromTraces(traces: TraceEvent[]) {
  const PRICE: Record<string, { input: number; output: number }> = {
    "claude-fable-5": { input: 10.0, output: 50.0 },
    "claude-opus-4-8": { input: 5.0, output: 25.0 },
    "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
    "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  };
  const byModel: Record<string, { inputTokens: number; outputTokens: number; usd: number }> = {};
  let totalUsd = 0;
  for (const t of traces) {
    const price = PRICE[t.model] ?? { input: 0, output: 0 };
    const usd = (t.inputTokens / 1e6) * price.input + (t.outputTokens / 1e6) * price.output;
    if (!byModel[t.model]) byModel[t.model] = { inputTokens: 0, outputTokens: 0, usd: 0 };
    byModel[t.model].inputTokens += t.inputTokens;
    byModel[t.model].outputTokens += t.outputTokens;
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
      const ev = JSON.parse(line) as { runId?: string; tool?: string; args?: unknown; id?: string; approved?: boolean; status?: string };
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

function serveFile(filePath: string): Response {
  if (!existsSync(filePath)) return new Response("Not found", { status: 404 });
  const file = Bun.file(filePath);
  return new Response(file);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
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

    // API routes
    if (pathname === "/api/runs" && req.method === "GET") {
      const runs = listRuns();
      // Enrich with trace cost/token summary
      const enriched = runs.map((r) => {
        const traces = readTraces(r.run_id);
        const cost = computeCostFromTraces(traces);
        const totalInputTokens = traces.reduce((s, t) => s + t.inputTokens, 0);
        const totalOutputTokens = traces.reduce((s, t) => s + t.outputTokens, 0);
        const firstTs = traces[0]?.ts ?? r.ts;
        const lastTs = traces[traces.length - 1]?.ts ?? r.ts;
        const durationMs = traces.reduce((s, t) => s + t.durationMs, 0);
        return {
          ...r,
          totalInputTokens,
          totalOutputTokens,
          totalCostUsd: cost.totalUsd,
          durationMs,
          startedAt: firstTs,
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
      let offset = 0;

      // Read existing lines first
      const existingLines: string[] = [];
      if (existsSync(TRACES_PATH)) {
        const content = readFileSync(TRACES_PATH, "utf8");
        const lines = content.split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const ev = JSON.parse(line) as TraceEvent;
            if (ev.runId === runId) existingLines.push(line);
          } catch {
            // skip
          }
        }
        offset = content.length;
      }

      const stream = new ReadableStream({
        start(controller) {
          // Send existing events
          for (const line of existingLines) {
            controller.enqueue(`data: ${line}\n\n`);
          }

          // Watch for new events
          if (!existsSync(TRACES_PATH)) {
            controller.close();
            return;
          }

          let currentOffset = offset;
          const interval = setInterval(() => {
            try {
              const file = Bun.file(TRACES_PATH);
              const size = file.size;
              if (size > currentOffset) {
                const content = readFileSync(TRACES_PATH, "utf8");
                const newContent = content.slice(currentOffset);
                const newLines = newContent.split("\n").filter(Boolean);
                for (const line of newLines) {
                  try {
                    const ev = JSON.parse(line) as TraceEvent;
                    if (ev.runId === runId) {
                      controller.enqueue(`data: ${line}\n\n`);
                    }
                  } catch {
                    // skip
                  }
                }
                currentOffset = size;
              }
            } catch {
              clearInterval(interval);
              controller.close();
            }
          }, 500);

          // Clean up after 5 minutes
          setTimeout(() => {
            clearInterval(interval);
            try { controller.close(); } catch { /* already closed */ }
          }, 5 * 60 * 1000);
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

    // POST /api/runs/:id/approve
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

    // Static files
    if (pathname.startsWith("/api")) {
      return json({ error: "not found" }, 404);
    }

    // Try to serve from dist/
    const staticPath = join(DIST_DIR, pathname === "/" ? "index.html" : pathname);
    if (existsSync(staticPath) && !staticPath.endsWith("/")) {
      return serveFile(staticPath);
    }

    // SPA fallback
    const indexPath = join(DIST_DIR, "index.html");
    if (existsSync(indexPath)) {
      return serveFile(indexPath);
    }

    return new Response("ProjectOS Web UI — run `bun run build` first or use `bun run dev`", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  },
});

console.log(`ProjectOS Web UI running on http://localhost:${PORT}`);
console.log(`DB: ${DB_PATH}`);
