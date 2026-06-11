import { resolve } from "path";
import { dispatchTool, TOOL_DEFINITIONS } from "@projectos/tools";
import type { ToolContext, ToolDef } from "@projectos/tools";
import { PermissionEngine, redact, autoDeny } from "@projectos/policy";
import type { ApprovalHandler, ToolRequest } from "@projectos/policy";

// ─── Minimal structural types for the Messages API ──────────────────────────
// The runner is provider-agnostic: anything that speaks the /v1/messages shape
// (the real Anthropic client, a proxy, or a scripted test double) plugs in via
// `createMessage`.

export interface ChatUsage {
  input_tokens: number;
  output_tokens: number;
  /** Tokens served from the prompt cache (returned by the API when caching is active) */
  cache_read_input_tokens?: number;
  /** Tokens written to the prompt cache (returned by the API when caching is active) */
  cache_creation_input_tokens?: number;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ToolUseBlock;

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface MessageParam {
  role: "user" | "assistant";
  content: string | Array<ContentBlock | ToolResultBlock>;
}

export interface ChatResponse {
  content: ContentBlock[];
  stop_reason: string | null;
  usage: ChatUsage;
}

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface CreateMessageParams {
  model: string;
  max_tokens: number;
  /** String or content blocks — blocks allow cache_control on the prefix */
  system?: string | SystemBlock[];
  messages: MessageParam[];
  tools?: (ToolDef & { cache_control?: { type: "ephemeral" } })[];
}

export type CreateMessageFn = (params: CreateMessageParams) => Promise<ChatResponse>;

// ─── Runner ──────────────────────────────────────────────────────────────────

export interface TurnInfo {
  turn: number;
  stopReason: string | null;
  usage: ChatUsage;
  toolCalls: string[];
}

export interface CompactionOptions {
  /** Compact when the serialized `messages` exceed this many characters */
  maxChars: number;
  /** Number of trailing turns (assistant + tool-result pairs) kept intact */
  keepLastTurns: number;
}

/** ~80k tokens at 4 chars/token */
export const DEFAULT_COMPACTION: CompactionOptions = {
  maxChars: 320_000,
  keepLastTurns: 6,
};

export interface AgentRunnerOptions {
  createMessage: CreateMessageFn;
  model: string;
  toolContext: ToolContext;
  system?: string;
  tools?: ToolDef[];
  permissions?: PermissionEngine;
  approval?: ApprovalHandler;
  maxIterations?: number;
  /** Max characters of a single tool result fed back to the model (default 16000) */
  maxToolResultChars?: number;
  maxTokensPerTurn?: number;
  /** Context compaction policy. Defaults to DEFAULT_COMPACTION (~80k tokens). */
  compaction?: CompactionOptions;
  onTurn?: (info: TurnInfo) => void;
  /** Async tool dispatcher for extended tool sets (e.g. playwright).
   *  Called first; falls through to the default dispatchTool when it returns null. */
  extraDispatcher?: (
    toolName: string,
    input: Record<string, unknown>
  ) => Promise<{ content: string; isError: boolean } | null>;
}

export interface AgentRunResult {
  finalText: string;
  messages: MessageParam[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  turns: number;
  stopReason: "end_turn" | "max_iterations" | string;
}

/** Map an API tool call onto the permission engine's tool ids and args.
 *  Policy ids: fs:read, fs:write, bash, git:push, git:commit (see DEFAULT_RULES). */
function toPolicyRequest(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): ToolRequest {
  const insideWorkspace = (p: unknown): boolean => {
    const abs = resolve(ctx.workspace, String(p ?? ""));
    return abs === resolve(ctx.workspace) || abs.startsWith(resolve(ctx.workspace) + "/");
  };

  switch (toolName) {
    case "read_file":
      return { tool: "fs:read", args: { filePath: String(input.path ?? "") } };
    case "write_file":
    case "edit_file":
      return {
        tool: "fs:write",
        args: { filePath: String(input.path ?? ""), insideWorkspace: insideWorkspace(input.path) },
      };
    case "bash": {
      const command = String(input.command ?? "");
      // git push through bash is policy-wise a push, not a generic command
      if (/\bgit\b[^\n;|&]*\bpush\b/.test(command)) {
        return { tool: "git:push", args: { command } };
      }
      return { tool: "bash", args: { command } };
    }
    case "git_commit":
      return { tool: "git:commit", args: { branch: ctx.branch?.() ?? "" } };
    case "glob_files":
      return { tool: "fs:glob", args: {} };
    case "grep_files":
      return { tool: "fs:grep", args: {} };
    case "git_status":
      return { tool: "git:status", args: {} };
    case "git_diff":
      return { tool: "git:diff", args: {} };
    default:
      return { tool: toolName, args: input };
  }
}

async function executeToolUse(
  block: ToolUseBlock,
  opts: AgentRunnerOptions
): Promise<ToolResultBlock> {
  const engine = opts.permissions ?? new PermissionEngine();
  const approval = opts.approval ?? autoDeny;

  const policyReq = toPolicyRequest(block.name, block.input, opts.toolContext);
  const decision = engine.evaluate(policyReq);

  if (decision.decision === "deny") {
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: `permission denied: ${decision.reason}`,
      is_error: true,
    };
  }

  if (decision.decision === "ask") {
    const result = await approval({
      tool: policyReq.tool,
      reason: decision.reason,
      args: policyReq.args,
    });
    if (!result.approved) {
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: `permission denied: ${decision.reason} (user declined)`,
        is_error: true,
      };
    }
  }

  const extra = opts.extraDispatcher
    ? await opts.extraDispatcher(block.name, block.input)
    : null;
  const dispatched = extra ?? dispatchTool(block.name, block.input, opts.toolContext);
  return {
    type: "tool_result",
    tool_use_id: block.id,
    content: truncateResult(redact(dispatched.content), opts.maxToolResultChars),
    is_error: dispatched.isError || undefined,
  };
}

/** Cap tool output fed back into context — long test logs and file dumps
 *  dominate input-token spend otherwise. Head+tail keeps errors visible. */
function truncateResult(content: string, maxChars = 16000): string {
  if (content.length <= maxChars) return content;
  const half = Math.floor(maxChars / 2);
  const omitted = content.length - maxChars;
  return (
    content.slice(0, half) +
    `\n\n[... ${omitted} characters truncated ...]\n\n` +
    content.slice(-half)
  );
}

// ─── Context compaction ──────────────────────────────────────────────────────

const COMPACT_BLOCK_MAX_CHARS = 200;

/** Shrink an old message without breaking tool_use/tool_result pairing:
 *  every block keeps its position and ids — only content strings shrink. */
function compactMessage(msg: MessageParam): MessageParam {
  if (typeof msg.content === "string") {
    if (msg.role === "assistant" && msg.content.length > COMPACT_BLOCK_MAX_CHARS) {
      return { ...msg, content: msg.content.slice(0, COMPACT_BLOCK_MAX_CHARS) };
    }
    return msg;
  }
  const content = msg.content.map((block) => {
    if (block.type === "tool_result" && block.content.length > COMPACT_BLOCK_MAX_CHARS) {
      // Keep tool_use_id and position; only the content string is replaced.
      return { ...block, content: `[tool result omitted: ${block.content.length} chars]` };
    }
    if (block.type === "text" && block.text.length > COMPACT_BLOCK_MAX_CHARS) {
      return { ...block, text: block.text.slice(0, COMPACT_BLOCK_MAX_CHARS) };
    }
    return block;
  });
  return { ...msg, content };
}

/** If the serialized history exceeds maxChars, shrink older messages:
 *  - messages[0] (the task) stays intact
 *  - the last keepLastTurns*2 messages stay intact
 *  - in between, long tool results become one-line summaries and long
 *    text blocks are truncated; tool_use/tool_result pairing is preserved. */
export function compactMessages(
  messages: MessageParam[],
  opts: CompactionOptions
): MessageParam[] {
  if (JSON.stringify(messages).length <= opts.maxChars) return messages;
  const keepTail = opts.keepLastTurns * 2;
  const tailStart = Math.max(1, messages.length - keepTail);
  return messages.map((msg, i) =>
    i === 0 || i >= tailStart ? msg : compactMessage(msg)
  );
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Bounded agentic loop over /v1/messages with tool use.
 *  Replaces the Managed Agents session loop (see ADR-006). */
export async function runAgent(
  initialMessages: MessageParam[],
  opts: AgentRunnerOptions
): Promise<AgentRunResult> {
  const messages: MessageParam[] = [...initialMessages];
  const maxIterations = opts.maxIterations ?? 50;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let finalText = "";

  // Prompt caching: mark the static prefix (tools + system) as cacheable so
  // repeated turns bill the prefix at cache-read rates instead of full price.
  const tools = [...(opts.tools ?? TOOL_DEFINITIONS)] as (ToolDef & {
    cache_control?: { type: "ephemeral" };
  })[];
  if (tools.length > 0) {
    tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: "ephemeral" } };
  }
  const system: SystemBlock[] | undefined = opts.system
    ? [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }]
    : undefined;

  const compaction = opts.compaction ?? DEFAULT_COMPACTION;

  for (let turn = 1; turn <= maxIterations; turn++) {
    const compacted = compactMessages(messages, compaction);
    if (compacted !== messages) {
      messages.splice(0, messages.length, ...compacted);
    }

    const response = await opts.createMessage({
      model: opts.model,
      max_tokens: opts.maxTokensPerTurn ?? 8192,
      system,
      messages,
      tools,
    });

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
    cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use"
    );

    opts.onTurn?.({
      turn,
      stopReason: response.stop_reason,
      usage: response.usage,
      toolCalls: toolUses.map((t) => t.name),
    });

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      finalText = textOf(response.content);
      return {
        finalText,
        messages,
        usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
        turns: turn,
        stopReason: response.stop_reason ?? "end_turn",
      };
    }

    const results: ToolResultBlock[] = [];
    for (const block of toolUses) {
      results.push(await executeToolUse(block, opts));
    }
    messages.push({ role: "user", content: results });
  }

  return {
    finalText,
    messages,
    usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
    turns: maxIterations,
    stopReason: "max_iterations",
  };
}
