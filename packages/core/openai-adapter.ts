/**
 * OpenAI adapter — makes any OpenAI-compatible endpoint usable as a
 * CreateMessageFn. The whole harness speaks the /v1/messages shape
 * (ADR-006); this translates to/from /v1/chat/completions.
 *
 * Env: OPENAI_API_KEY (required), OPENAI_BASE_URL (default api.openai.com).
 * Select with PROJECTOS_PROVIDER=openai or createMessage injection.
 */
import type {
  CreateMessageFn,
  CreateMessageParams,
  ChatResponse,
  ContentBlock,
  MessageParam,
  ToolResultBlock,
  ToolUseBlock,
  TextBlock,
} from "./agent-runner";

type FetchFn = typeof fetch;

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

interface OpenAiRequest {
  model: string;
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: "low" | "medium" | "high";
  messages: OpenAiMessage[];
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: unknown };
  }>;
}

interface OpenAiResponse {
  choices: Array<{
    message: { content: string | null; tool_calls?: OpenAiToolCall[] };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message: string };
}

/** /v1/messages params → /v1/chat/completions body */
export function toOpenAiRequest(params: CreateMessageParams): OpenAiRequest {
  const messages: OpenAiMessage[] = [];

  if (params.system) {
    const text =
      typeof params.system === "string"
        ? params.system
        : params.system.map((b) => b.text).join("\n");
    messages.push({ role: "system", content: text });
  }

  for (const m of params.messages) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }

    if (m.role === "assistant") {
      const text = m.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const toolCalls = m.content
        .filter((b): b is ToolUseBlock => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));
      messages.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // user message: tool_result blocks become role:"tool" messages;
    // plain text blocks stay a user message
    const results = m.content.filter(
      (b): b is ToolResultBlock => b.type === "tool_result"
    );
    for (const r of results) {
      messages.push({ role: "tool", content: r.content, tool_call_id: r.tool_use_id });
    }
    const text = m.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text) messages.push({ role: "user", content: text });
  }

  const isReasoning =
    params.model.includes("gpt-5") ||
    params.model.includes("o1") ||
    params.model.includes("o3") ||
    params.model.includes("codex");

  const req: OpenAiRequest = {
    model: params.model,
    messages,
    ...(params.tools && params.tools.length > 0
      ? {
          tools: params.tools.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.input_schema,
            },
          })),
        }
      : {}),
  };

  if (isReasoning) {
    req.max_completion_tokens = params.max_tokens;
    if (params.output_config?.effort) {
      const effort = params.output_config.effort;
      req.reasoning_effort = effort === "max" ? "high" : effort;
    }
  } else {
    req.max_tokens = params.max_tokens;
  }

  return req;
}

/** /v1/chat/completions response → /v1/messages shape */
export function fromOpenAiResponse(res: OpenAiResponse): ChatResponse {
  const choice = res.choices?.[0];
  if (!choice) throw new Error(`openai: empty choices (${JSON.stringify(res).slice(0, 200)})`);

  const content: ContentBlock[] = [];
  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  for (const tc of choice.message.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(tc.function.arguments || "{}");
    } catch {
      input = { _raw: tc.function.arguments };
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
  }

  const stopReason =
    choice.finish_reason === "tool_calls" ? "tool_use"
    : choice.finish_reason === "length" ? "max_tokens"
    : "end_turn";

  return {
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
      // OpenAI reports automatically-cached prefix tokens here; surface them so
      // traces show whether the proxy is caching (cacheRead was always 0 before).
      cache_read_input_tokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
}

export interface OpenAiAdapterOptions {
  apiKey?: string;       // default: OPENAI_API_KEY
  baseUrl?: string;      // default: OPENAI_BASE_URL or https://api.openai.com
  fetchFn?: FetchFn;     // injectable for tests
  maxRetries?: number;   // default 5 (429/5xx with backoff)
}

export function openAiCreateMessage(opts: OpenAiAdapterOptions = {}): CreateMessageFn {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  const baseUrl = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com")
    .replace(/\/$/, "");
  const doFetch = opts.fetchFn ?? fetch;
  const maxRetries = opts.maxRetries ?? 5;
  if (!apiKey) throw new Error("openAiCreateMessage: OPENAI_API_KEY is not set");

  return async (params) => {
    const body = JSON.stringify(toOpenAiRequest(params));
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90000); // 90 seconds timeout
      try {
        const res = await doFetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          return fromOpenAiResponse((await res.json()) as OpenAiResponse);
        }

        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt === maxRetries - 1) {
          const text = await res.text().catch(() => "");
          throw new Error(`openai: HTTP ${res.status} ${text.slice(0, 200)}`);
        }
        const delay = Math.min(2000 * 2 ** attempt, 30000);
        console.error(`[openai retry ${attempt + 1}/${maxRetries}] HTTP ${res.status} — waiting ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      } catch (err) {
        clearTimeout(timeoutId);
        if (attempt === maxRetries - 1) {
          throw err;
        }
        const delay = Math.min(2000 * 2 ** attempt, 30000);
        console.error(`[openai retry ${attempt + 1}/${maxRetries}] Network/Timeout Error: ${(err as Error).message} — waiting ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error("unreachable");
  };
}
