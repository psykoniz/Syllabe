import { readFileSync, existsSync } from "fs";
import type { TraceEvent } from "./traces";
import { computeCost } from "./cost-tracker";
import type { CostSummary } from "./cost-tracker";

export interface ToolCallEvent {
  ts: string;
  tool: string;
  args: Record<string, unknown>;
  result: "ok" | "error";
  durationMs: number;
  error?: string;
}

export interface ReplayStep {
  ts: string;
  kind: "trace" | "tool";
  /** Phase/state for traces, tool name for tool calls */
  label: string;
  detail: string;
  durationMs: number;
}

export interface ReplaySession {
  runId: string;
  steps: ReplayStep[];
  phases: string[];
  cost: CostSummary;
  totalDurationMs: number;
  startedAt?: string;
  endedAt?: string;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

/** List distinct run IDs found in a traces.jsonl, most recent first */
export function listRunIds(tracePath: string): string[] {
  const events = readJsonl<TraceEvent>(tracePath);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const e of events) {
    if (e.runId && !seen.has(e.runId)) {
      seen.add(e.runId);
      ids.push(e.runId);
    }
  }
  return ids.reverse();
}

/**
 * Reconstruct a full session timeline for one run from the JSONL transcripts.
 * Merges trace events (LLM calls per phase) with tool calls, ordered by
 * timestamp. Tool calls are not tagged with a runId, so they are included
 * only when they fall inside the run's trace time window.
 */
export function replayRun(
  tracePath: string,
  runId: string,
  toolCallsPath?: string,
): ReplaySession | null {
  const traces = readJsonl<TraceEvent>(tracePath).filter((e) => e.runId === runId);
  if (traces.length === 0) return null;

  const startedAt = traces[0].ts;
  const endedAt = traces[traces.length - 1].ts;
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(endedAt) + (traces[traces.length - 1].durationMs ?? 0);

  const steps: ReplayStep[] = traces.map((e) => ({
    ts: e.ts,
    kind: "trace" as const,
    label: e.phase,
    detail: `${e.role} → ${e.model} (${e.inputTokens} in / ${e.outputTokens} out)` +
      (e.meta?.escalationReason ? ` — escalation: ${e.meta.escalationReason}` : ""),
    durationMs: e.durationMs,
  }));

  if (toolCallsPath) {
    const toolCalls = readJsonl<ToolCallEvent>(toolCallsPath).filter((t) => {
      const ms = Date.parse(t.ts);
      return ms >= startMs && ms <= endMs;
    });
    for (const t of toolCalls) {
      const argPreview = JSON.stringify(t.args).slice(0, 120);
      steps.push({
        ts: t.ts,
        kind: "tool",
        label: t.tool,
        detail: `${t.result}${t.error ? ` (${t.error})` : ""} ${argPreview}`,
        durationMs: t.durationMs,
      });
    }
  }

  steps.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const phases: string[] = [];
  for (const e of traces) {
    if (phases[phases.length - 1] !== e.phase) phases.push(e.phase);
  }

  const cost = computeCost(
    traces.map((e) => ({ model: e.model, inputTokens: e.inputTokens, outputTokens: e.outputTokens })),
  );

  return {
    runId,
    steps,
    phases,
    cost,
    totalDurationMs: steps.reduce((sum, s) => sum + (s.durationMs || 0), 0),
    startedAt,
    endedAt,
  };
}
