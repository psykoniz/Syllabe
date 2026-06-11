import { TOOL_DEFINITIONS } from "@projectos/tools";
import type { ToolContext, ToolDispatchResult } from "@projectos/tools";
import { runAgent } from "./agent-runner";
import type { CreateMessageFn } from "./agent-runner";

/** Read-only research sub-agent tool. The main agent can fan out questions
 *  about the codebase without polluting its own context with file dumps. */
export const EXPLORE_TOOL = {
  name: "explore",
  description:
    "Spawn a read-only research sub-agent to answer a question about the codebase " +
    "(e.g. 'where is X implemented?', 'what conventions do tests follow?'). " +
    "Returns a concise answer with file paths. Use this instead of reading many files yourself.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: { type: "string", description: "The question to investigate" },
      scope: { type: "string", description: "Optional directory or area to focus on" },
    },
    required: ["question"],
  },
};

const READ_ONLY_TOOLS = new Set(["read_file", "glob_files", "grep_files"]);

const EXPLORER_SYSTEM =
  "You are a read-only research sub-agent. Investigate the workspace with the " +
  "available tools and answer the question concisely. Always cite concrete file " +
  "paths (and line numbers when relevant). Do not propose changes — just report findings.";

export interface ExploreDispatcherOptions {
  createMessage: CreateMessageFn;
  toolContext: ToolContext;
  /** Model for the sub-agent (cheap tier recommended) */
  model?: string;
  maxConcurrent?: number;
  maxIterations?: number;
}

/** Returns a dispatcher handling the "explore" tool; undefined for others
 *  (so it can be chained with other extra dispatchers). */
export function createExploreDispatcher(opts: ExploreDispatcherOptions) {
  const model =
    opts.model ?? process.env.PROJECTOS_MODEL_OVERRIDE ?? "claude-haiku-4-5";
  const maxConcurrent = opts.maxConcurrent ?? 3;
  const maxIterations = opts.maxIterations ?? 8;
  const tools = TOOL_DEFINITIONS.filter((t) => READ_ONLY_TOOLS.has(t.name));
  let running = 0;

  return async (
    name: string,
    input: Record<string, unknown>
  ): Promise<ToolDispatchResult | undefined> => {
    if (name !== "explore") return undefined;
    if (running >= maxConcurrent) {
      return {
        content: `error: too many concurrent explore calls (max ${maxConcurrent}) — wait for one to finish`,
        isError: true,
      };
    }
    const question = String(input.question ?? "").trim();
    if (!question) return { content: "error: question is required", isError: true };
    const scope = input.scope ? `\nFocus on: ${String(input.scope)}` : "";

    running++;
    try {
      const result = await runAgent(
        [{ role: "user", content: `${question}${scope}` }],
        {
          createMessage: opts.createMessage,
          model,
          system: EXPLORER_SYSTEM,
          toolContext: opts.toolContext,
          tools,
          maxIterations,
        }
      );
      return { content: result.finalText || "(no findings)", isError: false };
    } catch (e) {
      return { content: `error: explore failed: ${(e as Error).message}`, isError: true };
    } finally {
      running--;
    }
  };
}

type ExtraDispatcher = (
  name: string,
  input: Record<string, unknown>
) => Promise<ToolDispatchResult | undefined> | ToolDispatchResult | undefined;

/** Try dispatchers in order; first non-undefined result wins. */
export function chainDispatchers(...fns: Array<ExtraDispatcher | undefined>): ExtraDispatcher {
  const active = fns.filter((f): f is ExtraDispatcher => !!f);
  return async (name, input) => {
    for (const fn of active) {
      const r = await fn(name, input);
      if (r !== undefined) return r;
    }
    return undefined;
  };
}
