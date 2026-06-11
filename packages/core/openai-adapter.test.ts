import { describe, it, expect } from "bun:test";
import { toOpenAiRequest, fromOpenAiResponse, openAiCreateMessage } from "./openai-adapter";
import type { CreateMessageParams } from "./agent-runner";

describe("toOpenAiRequest", () => {
  it("maps system + user text", () => {
    const req = toOpenAiRequest({
      model: "gpt-4o",
      max_tokens: 100,
      system: "be helpful",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(req.messages[0]).toEqual({ role: "system", content: "be helpful" });
    expect(req.messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("maps system blocks (cache_control stripped)", () => {
    const req = toOpenAiRequest({
      model: "gpt-4o",
      max_tokens: 100,
      system: [{ type: "text", text: "rules", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "x" }],
    });
    expect(req.messages[0].content).toBe("rules");
  });

  it("maps assistant tool_use blocks to tool_calls", () => {
    const req = toOpenAiRequest({
      model: "gpt-4o",
      max_tokens: 100,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } },
          ],
        },
      ],
    });
    const m = req.messages[0];
    expect(m.role).toBe("assistant");
    expect(m.content).toBe("let me check");
    expect(m.tool_calls).toHaveLength(1);
    expect(m.tool_calls![0]).toEqual({
      id: "t1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"a.ts"}' },
    });
  });

  it("maps tool_result blocks to role:tool messages", () => {
    const req = toOpenAiRequest({
      model: "gpt-4o",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }],
        },
      ],
    });
    expect(req.messages[0]).toEqual({ role: "tool", content: "file contents", tool_call_id: "t1" });
  });

  it("maps tool definitions and strips anthropic-only params", () => {
    const params: CreateMessageParams = {
      model: "gpt-4o",
      max_tokens: 100,
      messages: [{ role: "user", content: "x" }],
      tools: [
        {
          name: "bash",
          description: "run a command",
          input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
          cache_control: { type: "ephemeral" },
        },
      ],
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
    };
    const req = toOpenAiRequest(params);
    expect(req.tools![0].function.name).toBe("bash");
    expect((req as unknown as Record<string, unknown>).thinking).toBeUndefined();
    expect((req as unknown as Record<string, unknown>).output_config).toBeUndefined();
    expect((req.tools![0] as unknown as Record<string, unknown>).cache_control).toBeUndefined();
  });
});

describe("fromOpenAiResponse", () => {
  it("maps text response", () => {
    const r = fromOpenAiResponse({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(r.content).toEqual([{ type: "text", text: "hi" }]);
    expect(r.stop_reason).toBe("end_turn");
    expect(r.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("maps tool_calls to tool_use blocks", () => {
    const r = fromOpenAiResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(r.stop_reason).toBe("tool_use");
    expect(r.content[0]).toEqual({ type: "tool_use", id: "c1", name: "bash", input: { command: "ls" } });
  });

  it("survives malformed tool arguments", () => {
    const r = fromOpenAiResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{broken" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const block = r.content[0] as { input: Record<string, unknown> };
    expect(block.input._raw).toBe("{broken");
  });
});

describe("openAiCreateMessage", () => {
  it("round-trips through a fake fetch", async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), body: String(init?.body) });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "done" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const create = openAiCreateMessage({ apiKey: "sk-test", baseUrl: "https://example.com", fetchFn: fakeFetch });
    const res = await create({ model: "gpt-4o", max_tokens: 50, messages: [{ role: "user", content: "hi" }] });

    expect(seen[0].url).toBe("https://example.com/v1/chat/completions");
    expect(JSON.parse(seen[0].body).model).toBe("gpt-4o");
    expect(res.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("retries on 429 then succeeds", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const create = openAiCreateMessage({ apiKey: "sk-test", fetchFn: fakeFetch, maxRetries: 3 });
    const res = await create({ model: "gpt-4o", max_tokens: 10, messages: [{ role: "user", content: "x" }] });
    expect(calls).toBe(2);
    expect(res.content[0]).toEqual({ type: "text", text: "ok" });
  });

  it("throws without an api key", () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => openAiCreateMessage()).toThrow(/OPENAI_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });
});
