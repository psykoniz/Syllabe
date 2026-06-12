import type { CreateMessageFn, TextBlock } from "./agent-runner";
import type { State, RunContext } from "./state-machine";
import { appendSteering } from "./steering";

// ─── Auto-steering: lightweight LLM critic between state transitions ─────────
//
// After each state handler completes, a cheap model (haiku) evaluates whether
// the run is on track. If it detects scope creep, wrong conventions, or missed
// requirements, it injects a correction as a steering message consumed by the
// next state's prompt.
//
// Cost: ~200 tokens haiku per transition ≈ $0.0002 — negligible vs. the main
// agent calls that dominate spend.

export interface AutoSteeringOptions {
  createMessage: CreateMessageFn;
  /** Model for the critic (cheap tier recommended, default haiku) */
  model?: string;
  workspace: string;
  runId: string;
  task: string;
  /** States to skip (trivial pass-throughs that don't need review) */
  skipStates?: Set<State>;
}

const CRITIC_PROMPT = [
  "You are a quality control critic for an AI agent building a software project.",
  "You receive the current state, the task brief, and a summary of what happened.",
  "Your job: decide if the agent is on track or if it needs a course correction.",
  "",
  "Rules:",
  '- Reply "ON_TRACK" if everything looks fine — no correction needed.',
  '- Reply "CORRECTION: <instruction>" if you spot a problem. Be specific and concise.',
  "- Common issues: scope creep (adding features not in the task), wrong tech stack,",
  "  ignoring conventions, skipping tests, not following the blueprint.",
  "- Never suggest adding features not in the original task.",
  "- Keep your response under 100 words.",
].join("\n");

const SKIP_BY_DEFAULT = new Set<State>(["INTAKE", "COMPLETE", "ESCALATED", "LEARN"]);

export interface SteeringResult {
  onTrack: boolean;
  correction?: string;
}

/** Evaluate a state transition and optionally inject a correction.
 *  Best-effort: never throws, never blocks the run on failure. */
export async function evaluateTransition(
  fromState: State,
  toState: State,
  ctx: RunContext,
  lastAgentOutput: string,
  opts: AutoSteeringOptions,
): Promise<SteeringResult> {
  const skipStates = opts.skipStates ?? SKIP_BY_DEFAULT;
  if (skipStates.has(fromState)) return { onTrack: true };

  const model =
    opts.model ?? process.env.PROJECTOS_MODEL_OVERRIDE ?? "claude-haiku-4-5";

  try {
    const response = await opts.createMessage({
      model,
      max_tokens: 256,
      system: CRITIC_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            `Task: ${opts.task}`,
            `Transition: ${fromState} → ${toState}`,
            `Work unit: ${ctx.workUnitIndex + 1}/${ctx.workUnits.length || 1}`,
            `Repair count: ${ctx.repairCount}/${ctx.bounds.maxRepair}`,
            `Review cycles: ${ctx.reviewCycleCount}/${ctx.bounds.maxReview}`,
            `Last agent output (truncated):`,
            lastAgentOutput.slice(0, 1000),
          ].join("\n"),
        },
      ],
    });

    const text = response.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (text.startsWith("CORRECTION:")) {
      const correction = text.replace("CORRECTION:", "").trim();
      // Inject as a steering message consumed by the next state's prompt
      appendSteering(opts.workspace, opts.runId, `[auto-critic] ${correction}`);
      return { onTrack: false, correction };
    }

    return { onTrack: true };
  } catch {
    // Auto-steering is best-effort — never block the run
    return { onTrack: true };
  }
}
