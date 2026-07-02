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
  /** Adaptive thinking — the only on-mode for fable/opus 4.7+ */
  thinking?: { type: "adaptive" };
  /** Effort control; "max" = deepest reasoning (fable/opus/sonnet-4.6) */
  output_config?: { effort: "low" | "medium" | "high" | "max" };
}

export type EffortLevel = "low" | "medium" | "high" | "max";

/** Premium reasoning models get adaptive thinking; effort defaults to "high"
 *  and can be raised to "max" per call for genuinely hard phases — paying
 *  for maximum reflection on every call (incl. trivial ones) is waste. */
export function reasoningParams(
  model: string,
  effort?: EffortLevel
): Pick<CreateMessageParams, "thinking" | "output_config"> {
  if (
    model.includes("fable") ||
    model.includes("opus") ||
    model.includes("gpt-5") ||
    model.includes("codex")
  ) {
    return { thinking: { type: "adaptive" }, output_config: { effort: effort ?? "high" } };
  }
  return {};
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
  /** Model-based summarizer for the middle of the conversation. When set,
   *  compaction replaces the middle with a summary message instead of
   *  truncating; falls back to truncation if it throws. */
  summarizeFn?: (messages: MessageParam[]) => Promise<string>;
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
  /** Reasoning effort for premium models (default "high"; use "max" only
   *  for genuinely hard phases — design, review) */
  effort?: EffortLevel;
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

  // Never let a dispatcher throw escape: an uncaught error here would leave the
  // assistant's tool_use block in the history with no matching tool_result,
  // corrupting the conversation for any subsequent turn. Surface it as an error
  // result instead so the pairing always stays intact.
  try {
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
  } catch (err) {
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: `tool execution failed: ${(err as Error).message}`,
      is_error: true,
    };
  }
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

/** Return a shallow copy of the history with a cache_control breakpoint on the
 *  last block of the final message. Combined with the static system+tools
 *  breakpoints, this makes Anthropic bill the whole accumulating prefix at
 *  cache-read rates on every turn (the dominant cost in long agentic loops).
 *  The extra field is ignored by providers that don't support it (e.g. OpenAI),
 *  so it's safe on every path. The stored `messages` array is left untouched. */
export function withHistoryCacheBreakpoint(messages: MessageParam[]): MessageParam[] {
  // On the first turn there is no accumulated prefix to read from cache yet, so
  // skip — this also keeps the initial string prompt as a string for providers
  // and callers that distinguish it from tool-result (block) messages.
  if (messages.length <= 1) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  const blocks =
    typeof last.content === "string"
      ? [{ type: "text" as const, text: last.content }]
      : last.content.map((b) => ({ ...b }));
  if (blocks.length === 0) return messages;
  blocks[blocks.length - 1] = {
    ...blocks[blocks.length - 1],
    cache_control: { type: "ephemeral" },
  } as (typeof blocks)[number];
  out[out.length - 1] = { ...last, content: blocks };
  return out;
}

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
    if (block.type === "tool_use") {
      // A large tool_use input (e.g. a multi-KB bash script or write_file body)
      // survives compaction otherwise; shrink it while keeping id/name/position
      // so the tool_use/tool_result pairing stays intact.
      const serialized = JSON.stringify(block.input);
      if (serialized.length > COMPACT_BLOCK_MAX_CHARS) {
        return { ...block, input: { _omitted: `tool input omitted: ${serialized.length} chars` } };
      }
    }
    return block;
  });
  return { ...msg, content };
}

/** Fast char-count estimate: avoids a full JSON.stringify(messages) on every
 *  compaction check — that call is O(n) per turn, costing O(n²) per run on
 *  long conversations. We still re-serialize in tests for exact assertions. */
export function estimateMessagesChars(messages: MessageParam[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      total += m.content.length + 20; // role + punctuation overhead
    } else {
      for (const b of m.content) {
        if (b.type === "text") total += b.text.length + 15;
        else if (b.type === "tool_result") total += b.content.length + 30;
        else if (b.type === "tool_use") total += JSON.stringify(b.input).length + 40;
      }
    }
  }
  return total;
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
  if (estimateMessagesChars(messages) <= opts.maxChars) return messages;
  const keepTail = opts.keepLastTurns * 2;
  const tailStart = Math.max(1, messages.length - keepTail);
  return messages.map((msg, i) =>
    i === 0 || i >= tailStart ? msg : compactMessage(msg)
  );
}

/** Model-based compaction: keep messages[0] and the trailing turns verbatim,
 *  replace everything in between with one summary message produced by
 *  opts.summarizeFn. Falls back to compactMessages (truncation) when no
 *  summarizer is configured or the summary call fails. */
export async function compactMessagesSmart(
  messages: MessageParam[],
  opts: CompactionOptions
): Promise<MessageParam[]> {
  if (estimateMessagesChars(messages) <= opts.maxChars) return messages;
  if (!opts.summarizeFn) return compactMessages(messages, opts);

  const keepTail = opts.keepLastTurns * 2;
  const tailStart = Math.max(1, messages.length - keepTail);
  // Nothing in the middle to summarize — truncation handles edge cases better
  if (tailStart <= 1) return compactMessages(messages, opts);

  const middle = messages.slice(1, tailStart);
  try {
    const summary = await opts.summarizeFn(middle);
    return [
      messages[0],
      { role: "user", content: `[conversation summary: ${summary}]` },
      ...messages.slice(tailStart),
    ];
  } catch {
    return compactMessages(messages, opts);
  }
}

/** Cheap model used for the default conversation summarizer. */
export const COMPACTION_MODEL = "claude-haiku-4-5";

/** Prompt used by the default summarizer built from createMessage. */
export const COMPACTION_SUMMARY_PROMPT =
  "Summarize this agent conversation so work can continue seamlessly: decisions made, " +
  "files created or modified, errors hit and how they were resolved, and the current " +
  "objective. Be specific about file paths. 400 words maximum.";

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Extract an HTTP status from a thrown error, however the provider shaped it. */
function errorStatus(err: unknown): number | undefined {
  const e = err as { status?: number; statusCode?: number; response?: { status?: number } };
  return e?.status ?? e?.statusCode ?? e?.response?.status;
}

/** A transient error is worth retrying: 429, any 5xx, or a network-level
 *  failure (no HTTP status at all — connection reset, timeout, DNS, …).
 *  Deterministic 4xx (bad request, auth) are NOT retried. */
function isTransient(err: unknown): boolean {
  const status = errorStatus(err);
  if (status === undefined) return true; // network/abort — no response received
  return status === 429 || status >= 500;
}

/** Call createMessage with bounded exponential backoff on transient failures.
 *  The OpenAI adapter already retries 429 internally; this guards every
 *  provider (incl. the real Anthropic client) against 5xx and network resets,
 *  which previously crashed the whole agentic loop on the first blip. */
async function createMessageWithRetry(
  createMessage: CreateMessageFn,
  params: CreateMessageParams,
  maxRetries = 3
): Promise<ChatResponse> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await createMessage(params);
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries || !isTransient(err)) throw err;
      const delayMs = 2000 * 2 ** attempt; // 2s, 4s, 8s
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/** Bounded agentic loop over /v1/messages with tool use.
 *  Replaces the Managed Agents session loop (see ADR-006). */
export async function runAgent(
  initialMessages: MessageParam[],
  opts: AgentRunnerOptions
): Promise<AgentRunResult> {
  const messages: MessageParam[] = [...initialMessages];
  const maxIterations = opts.maxIterations ?? 50;
  // Track consecutive identical failing tool calls so a model that keeps
  // retrying the same broken command (the astropy-14182 298k-token spiral)
  // is told to change approach instead of looping until budget exhaustion.
  const failureCounts = new Map<string, number>();
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

  const compaction = { ...(opts.compaction ?? DEFAULT_COMPACTION) };
  if (!compaction.summarizeFn) {
    // Default summarizer: one cheap model call over the middle of the history
    compaction.summarizeFn = async (middle) => {
      const res = await opts.createMessage({
        // Honor a global override (e.g. OpenAI provider runs) — the haiku id
        // only exists on Anthropic-compatible endpoints.
        model: process.env.PROJECTOS_MODEL_OVERRIDE ?? COMPACTION_MODEL,
        max_tokens: 1024,
        system: COMPACTION_SUMMARY_PROMPT,
        messages: [
          ...middle,
          { role: "user", content: "Now write the summary described in the system prompt." },
        ],
      });
      const text = textOf(res.content).trim();
      if (!text) throw new Error("empty summary");
      return text;
    };
  }

  for (let turn = 1; turn <= maxIterations; turn++) {
    const compacted = await compactMessagesSmart(messages, compaction);
    if (compacted !== messages) {
      messages.splice(0, messages.length, ...compacted);
    }

    const response = await createMessageWithRetry(opts.createMessage, {
      model: opts.model,
      max_tokens: opts.maxTokensPerTurn ?? 8192,
      system,
      messages: withHistoryCacheBreakpoint(messages),
      tools,
      ...reasoningParams(opts.model, opts.effort),
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

    // The model hit the per-turn token ceiling mid-response: rather than return
    // a truncated answer, prompt it to continue exactly where it left off.
    // Only do this when there is budget left and no tool call is pending.
    if (response.stop_reason === "max_tokens" && toolUses.length === 0 && turn < maxIterations) {
      finalText = textOf(response.content);
      messages.push({
        role: "user",
        content:
          "Your previous response was cut off at the token limit. Continue exactly where you " +
          "left off — do not repeat what you already wrote.",
      });
      continue;
    }

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

    // Keep the latest assistant prose as finalText so a run that exhausts its
    // iteration budget mid-tool-loop still returns the model's last words
    // instead of an empty string.
    const latestText = textOf(response.content);
    if (latestText) finalText = latestText;

    // Run all tool calls concurrently — read-only calls (read_file, glob_files,
    // grep_files, git_status, git_diff) are embarrassingly parallel; write calls
    // are typically alone in a turn so there is no practical conflict risk.
    const settled = await Promise.all(toolUses.map((block) => executeToolUse(block, opts)));

    const results: ToolResultBlock[] = [];
    for (let i = 0; i < toolUses.length; i++) {
      const block = toolUses[i];
      const result = settled[i];
      const sig = `${block.name}:${JSON.stringify(block.input)}`;
      if (result.is_error) {
        const n = (failureCounts.get(sig) ?? 0) + 1;
        failureCounts.set(sig, n);
        // Third identical failure in a row → stop the model from looping.
        if (n >= 3) {
          result.content +=
            `\n\n[loop guard: this exact ${block.name} call has now failed ${n} times. ` +
            `Do NOT retry it unchanged — diagnose the root cause from the error above and ` +
            `try a fundamentally different approach, or move on.]`;
        }
      } else {
        failureCounts.delete(sig); // recovered — reset the counter
      }
      results.push(result);
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
