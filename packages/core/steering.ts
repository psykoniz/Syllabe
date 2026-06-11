import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";

/** Operator instruction injected into a running build ("steering"). The web
 *  server appends; the run loop reads pending entries and marks them
 *  consumed after injecting them into the next role prompt. */
export interface SteeringMessage {
  id: string;
  ts: string;
  text: string;
  consumedAt?: string;
}

function steeringPath(workspace: string, runId: string): string {
  return join(workspace, ".projectos", "steering", `${runId}.jsonl`);
}

export function appendSteering(workspace: string, runId: string, text: string): SteeringMessage {
  const msg: SteeringMessage = { id: randomUUID(), ts: new Date().toISOString(), text };
  const p = steeringPath(workspace, runId);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(msg) + "\n", "utf8");
  return msg;
}

function readAll(workspace: string, runId: string): SteeringMessage[] {
  const p = steeringPath(workspace, runId);
  if (!existsSync(p)) return [];
  const out: SteeringMessage[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SteeringMessage);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

export function readPendingSteering(workspace: string, runId: string): SteeringMessage[] {
  return readAll(workspace, runId).filter((m) => !m.consumedAt);
}

export function markConsumed(workspace: string, runId: string, ids: string[]): void {
  if (ids.length === 0) return;
  const p = steeringPath(workspace, runId);
  if (!existsSync(p)) return;
  const idSet = new Set(ids);
  const now = new Date().toISOString();
  const all = readAll(workspace, runId).map((m) =>
    idSet.has(m.id) && !m.consumedAt ? { ...m, consumedAt: now } : m
  );
  writeFileSync(p, all.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf8");
}
