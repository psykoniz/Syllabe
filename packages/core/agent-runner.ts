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

export interface CreateMessageParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: MessageParam[];
  tools?: ToolDef[];
}

export type CreateMessageFn = (params: CreateMessageParams) => Promise<ChatResponse>;

// ─── Runner ──────────────────────────────────────────────────────────────────

export interface TurnInfo {
  turn: number;
  stopReason: string | null;
  usage: ChatUsage;
  toolCalls: string[];
}

export interface AgentRunnerOptions {
  createMessage: CreateMessageFn;
  model: string;
  toolContext: ToolContext;
  system?: string;
  tools?: ToolDef[];
  permissions?: PermissionEngine;
  approval?: ApprovalHandler;
  maxIterations?: number;
  maxTokensPerTurn?: number;
  onTurn?: (info: TurnInfo) => void;
}

export interface AgentRunResult {
  finalText: string;
  messages: MessageParam[];
  usage: { inputTokens: number; outputTokens: number };
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

  const dispatched = dispatchTool(block.name, block.input, opts.toolContext);
  return {
    type: "tool_result",
    tool_use_id: block.id,
    content: redact(dispatched.content),
    is_error: dispatched.isError || undefined,
  };
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
  let finalText = "";

  for (let turn = 1; turn <= maxIterations; turn++) {
    const response = await opts.createMessage({
      model: opts.model,
      max_tokens: opts.maxTokensPerTurn ?? 8192,
      system: opts.system,
      messages,
      tools: opts.tools ?? TOOL_DEFINITIONS,
    });

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
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
        usage: { inputTokens, outputTokens },
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
    usage: { inputTokens, outputTokens },
    turns: maxIterations,
    stopReason: "max_iterations",
  };
}
