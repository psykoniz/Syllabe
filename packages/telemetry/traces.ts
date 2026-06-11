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
  /** Tokens served from the prompt cache (billed at ~0.1× input price) */
  cacheReadTokens?: number;
  /** Tokens written to the prompt cache (billed at ~1.25× input price) */
  cacheWriteTokens?: number;
  durationMs: number;
  meta?: Record<string, unknown>;
}

export function appendTrace(filePath: string, event: TraceEvent): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(event) + "\n", "utf8");
}
