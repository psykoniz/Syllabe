import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

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

export function appendTrace(filePath: string, event: TraceEvent): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(event) + "\n", "utf8");
}
