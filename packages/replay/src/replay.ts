import { readFileSync } from "fs";

export interface ReplayEvent {
  index: number;
  ts: string;
  phase: string;
  role: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  cumulativeCostUsd: number;
  meta?: Record<string, unknown>;
}

export interface ReplaySummary {
  runId: string;
  totalEvents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalDurationMs: number;
  phases: string[];
  startedAt: string;
  endedAt: string;
  events: ReplayEvent[];
}

// Cost per 1M tokens in USD
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates = MODEL_COSTS[model] ?? { input: 3, output: 15 };
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}

interface RawTrace {
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

export class RunReplay {
  constructor(private tracePath: string) {}

  private readTraces(runId: string): RawTrace[] {
    let content: string;
    try {
      content = readFileSync(this.tracePath, "utf8");
    } catch {
      return [];
    }
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as RawTrace;
        } catch {
          return null;
        }
      })
      .filter((t): t is RawTrace => t !== null && t.runId === runId);
  }

  private buildEvents(rawTraces: RawTrace[]): ReplayEvent[] {
    let cumInput = 0;
    let cumOutput = 0;
    let cumCost = 0;
    return rawTraces.map((t, i) => {
      cumInput += t.inputTokens;
      cumOutput += t.outputTokens;
      cumCost += calcCost(t.model, t.inputTokens, t.outputTokens);
      return {
        index: i,
        ts: t.ts,
        phase: t.phase,
        role: t.role,
        model: t.model,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        durationMs: t.durationMs,
        cumulativeInputTokens: cumInput,
        cumulativeOutputTokens: cumOutput,
        cumulativeCostUsd: cumCost,
        meta: t.meta,
      };
    });
  }

  load(runId: string): ReplaySummary {
    const rawTraces = this.readTraces(runId);
    const events = this.buildEvents(rawTraces);

    const phases: string[] = [];
    const seenPhases = new Set<string>();
    for (const e of events) {
      if (!seenPhases.has(e.phase)) {
        seenPhases.add(e.phase);
        phases.push(e.phase);
      }
    }

    const totalInputTokens = events.reduce((s, e) => s + e.inputTokens, 0);
    const totalOutputTokens = events.reduce((s, e) => s + e.outputTokens, 0);
    const totalCostUsd = events.length > 0 ? events[events.length - 1].cumulativeCostUsd : 0;
    const totalDurationMs = events.reduce((s, e) => s + e.durationMs, 0);
    const startedAt = events.length > 0 ? events[0].ts : new Date(0).toISOString();
    const endedAt = events.length > 0 ? events[events.length - 1].ts : new Date(0).toISOString();

    return {
      runId,
      totalEvents: events.length,
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd,
      totalDurationMs,
      phases,
      startedAt,
      endedAt,
      events,
    };
  }

  events(runId: string): ReplayEvent[] {
    return this.buildEvents(this.readTraces(runId));
  }

  stepTo(runId: string, index: number): ReplayEvent | null {
    const evts = this.events(runId);
    if (index < 0 || index >= evts.length) return null;
    return evts[index];
  }
}
