import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface ToolCallEntry {
  ts: string;
  tool: string;
  args: Record<string, unknown>;
  result: "ok" | "error";
  durationMs: number;
  error?: string;
}

export function logToolCall(logPath: string, entry: ToolCallEntry): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf8");
}
