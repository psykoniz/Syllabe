import { Database } from "bun:sqlite";
import {
  transition,
  type RunContext,
  type MachineEvent,
  type State,
} from "./state-machine";
import { writeCheckpoint, ensureCheckpointTable } from "./checkpoint";
import { evaluateTransition } from "./auto-steering";
import type { AutoSteeringOptions } from "./auto-steering";

export interface AgentHandler {
  onState(state: State, ctx: RunContext): Promise<MachineEvent>;
}

export interface AgentLoopOptions {
  runId: string;
  db: Database;
  handler: AgentHandler;
  maxSteps?: number;
  /** Enable lightweight LLM critic between state transitions.
   *  When set, a cheap model evaluates each transition and can inject
   *  steering corrections consumed by the next state's prompt. */
  autoSteering?: AutoSteeringOptions;
  /** Called after each auto-steering evaluation (for tracing/logging) */
  onSteeringResult?: (from: State, to: State, result: { onTrack: boolean; correction?: string }) => void;
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
    const prevState = ctx.state;
    const event = await handler.onState(ctx.state, ctx);
    const next = transition(ctx, event);

    // Auto-steering: lightweight critic evaluates the transition
    if (opts.autoSteering && next.state !== prevState) {
      const result = await evaluateTransition(
        prevState,
        next.state,
        next,
        "",  // lastAgentOutput — will be enriched when the handler exposes it
        opts.autoSteering,
      );
      opts.onSteeringResult?.(prevState, next.state, result);
    }

    if (next.state !== ctx.state) {
      writeCheckpoint(db, runId, seq++, next);
    }

    ctx = next;
    steps++;
  }

  return { finalContext: ctx, steps };
}

