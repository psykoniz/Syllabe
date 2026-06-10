import { Database } from "bun:sqlite";
import {
  transition,
  type RunContext,
  type MachineEvent,
  type State,
} from "./state-machine";
import { writeCheckpoint, ensureCheckpointTable } from "./checkpoint";

export interface AgentHandler {
  onState(state: State, ctx: RunContext): Promise<MachineEvent>;
}

export interface AgentLoopOptions {
  runId: string;
  db: Database;
  handler: AgentHandler;
  maxSteps?: number;
}

export interface LoopResult {
  finalContext: RunContext;
  steps: number;
}

export async function runAgentLoop(
  initialCtx: RunContext,
  opts: AgentLoopOptions
): Promise<LoopResult> {
  const { runId, db, handler, maxSteps = 200 } = opts;

  ensureCheckpointTable(db);

  let ctx = initialCtx;
  let seq = 0;
  let steps = 0;

  writeCheckpoint(db, runId, seq++, ctx);

  while (ctx.state !== "COMPLETE" && ctx.state !== "ESCALATED" && steps < maxSteps) {
    const event = await handler.onState(ctx.state, ctx);
    const next = transition(ctx, event);

    if (next.state !== ctx.state) {
      writeCheckpoint(db, runId, seq++, next);
    }

    ctx = next;
    steps++;
  }

  return { finalContext: ctx, steps };
}
