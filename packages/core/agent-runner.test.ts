import { describe, it, expect } from "bun:test";
import { runAgent } from "./agent-runner";
import type { CreateMessageFn, MessageParam, ContentBlock } from "./agent-runner";
import { FsTools } from "@projectos/tools";
import { BashTool } from "@projectos/tools";
import { GitTools } from "@projectos/tools";
import { autoDeny } from "@projectos/policy";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";

const TMP = "/tmp/projectos-runner-test";

function makeFakeCtx() {
  mkdirSync(TMP, { recursive: true });
  const logPath = join(TMP, "tools.jsonl");
  return {
    fs: new FsTools({ logPath }),
    bash: new BashTool({ logPath, workspace: TMP }),
    git: new GitTools({ logPath, repoPath: TMP }),
    workspace: TMP,
  };
}

/** Scripted double: each call pops the next response from the queue */
function scriptedCreateMessage(responses: ContentBlock[][]): CreateMessageFn {
  const queue = [...responses];
  return async () => {
    const content = queue.shift() ?? [{ type: "text", text: "done" }];
    const hasToolUse = content.some((b) => b.type === "tool_use");
    return {
      content: content as ContentBlock[],
      stop_reason: hasToolUse ? "tool_use" : "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  };
}

describe("runAgent — basic", () => {
  it("returns immediately on end_turn with no tool calls", async () => {
    const ctx = makeFakeCtx();
    const result = await runAgent(
      [{ role: "user", content: "hello" }],
      {
        createMessage: scriptedCreateMessage([[{ type: "text", text: "Hi there!" }]]),
        model: "claude-sonnet-4-6",
        toolContext: ctx,
      }
    );
    expect(result.finalText).toBe("Hi there!");
    expect(result.turns).toBe(1);
    expect(result.stopReason).toBe("end_turn");
    rmSync(TMP, { recursive: true, force: true });
  });

  it("accumulates token usage across turns", async () => {
    const ctx = makeFakeCtx();
    const result = await runAgent(
      [{ role: "user", content: "hi" }],
      {
        createMessage: scriptedCreateMessage([
          [{ type: "text", text: "Done" }],
        ]),
        model: "claude-sonnet-4-6",
        toolContext: ctx,
      }
    );
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    rmSync(TMP, { recursive: true, force: true });
  });

  it("stops at maxIterations and returns stopReason=max_iterations", async () => {
    const ctx = makeFakeCtx();
    // always returns tool_use → infinite loop without maxIterations
    const create: CreateMessageFn = async () => ({
      content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const result = await runAgent(
      [{ role: "user", content: "loop forever" }],
      {
        createMessage: create,
        model: "claude-sonnet-4-6",
        toolContext: ctx,
        maxIterations: 3,
        approval: autoDeny,   // deny all tool calls so they return errors, not block
      }
    );
    expect(result.stopReason).toBe("max_iterations");
    expect(result.turns).toBe(3);
    rmSync(TMP, { recursive: true, force: true });
  });

  it("executes a tool call and continues the loop", async () => {
    mkdirSync(TMP, { recursive: true });
    const ctx = makeFakeCtx();
    const toolCalled: string[] = [];

    const create: CreateMessageFn = async (params) => {
      const lastMsg = params.messages[params.messages.length - 1];
      // second call: after tool result
      if (Array.isArray(lastMsg.content) && lastMsg.role === "user") {
        return {
          content: [{ type: "text", text: "all done" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 3 },
        };
      }
      // first call: use a tool
      return {
        content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    };

    const result = await runAgent(
      [{ role: "user", content: "do something" }],
      {
        createMessage: create,
        model: "claude-sonnet-4-6",
        toolContext: ctx,
        onTurn: (info) => toolCalled.push(...info.toolCalls),
      }
    );

    expect(result.finalText).toBe("all done");
    expect(result.turns).toBe(2);
    expect(toolCalled).toContain("bash");
    rmSync(TMP, { recursive: true, force: true });
  });

  it("permission deny blocks the tool and returns error to model", async () => {
    mkdirSync(TMP, { recursive: true });
    const ctx = makeFakeCtx();
    let toolResultSeen: string | null = null;

    const create: CreateMessageFn = async (params) => {
      const last = params.messages[params.messages.length - 1];
      if (Array.isArray(last.content) && last.role === "user") {
        const block = last.content[0] as { type: string; content: string };
        toolResultSeen = block.content;
        return {
          content: [{ type: "text", text: "understood" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 2, output_tokens: 2 },
        };
      }
      return {
        content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "rm -rf /" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
    };

    await runAgent(
      [{ role: "user", content: "destroy everything" }],
      {
        createMessage: create,
        model: "claude-sonnet-4-6",
        toolContext: ctx,
      }
    );

    expect(toolResultSeen ?? "").toContain("permission denied");
    rmSync(TMP, { recursive: true, force: true });
  });

  it("messages array includes all turns (user, assistant, tool results)", async () => {
    mkdirSync(TMP, { recursive: true });
    const ctx = makeFakeCtx();

    const create: CreateMessageFn = async (params) => {
      const last = params.messages[params.messages.length - 1];
      if (Array.isArray(last.content) && last.role === "user") {
        return {
          content: [{ type: "text", text: "finished" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }
      return {
        content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo test" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
    };

    const result = await runAgent(
      [{ role: "user", content: "go" }],
      {
        createMessage: create,
        model: "claude-sonnet-4-6",
        toolContext: ctx,
      }
    );

    // [user, assistant(tool_use), user(tool_result), assistant(text)]
    expect(result.messages.length).toBe(4);
    rmSync(TMP, { recursive: true, force: true });
  });
});

describe("runAgent — tool result truncation", () => {
  it("truncates oversized tool output, keeping head and tail", async () => {
    const ctx = makeFakeCtx();
    mkdirSync(TMP, { recursive: true });
    // A file larger than the truncation cap
    const big = "HEAD_MARKER\n" + "x".repeat(50000) + "\nTAIL_MARKER";
    const { writeFileSync } = require("fs");
    writeFileSync(join(TMP, "big.txt"), big, "utf8");

    let toolResultSeen = "";
    let call = 0;
    const create: CreateMessageFn = async (params) => {
      call++;
      if (call === 1) {
        return {
          content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: join(TMP, "big.txt") } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 5, output_tokens: 5 },
        };
      }
      const last = params.messages[params.messages.length - 1];
      if (Array.isArray(last.content)) {
        const tr = last.content.find((b) => b.type === "tool_result");
        if (tr && typeof (tr as { content?: string }).content === "string") {
          toolResultSeen = (tr as { content: string }).content;
        }
      }
      return {
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
    };

    await runAgent(
      [{ role: "user", content: "read the big file" }],
      { createMessage: create, model: "claude-sonnet-4-6", toolContext: ctx, maxToolResultChars: 1000 }
    );

    expect(toolResultSeen.length).toBeLessThan(1200);
    expect(toolResultSeen).toContain("HEAD_MARKER");
    expect(toolResultSeen).toContain("TAIL_MARKER");
    expect(toolResultSeen).toContain("characters truncated");
    rmSync(TMP, { recursive: true, force: true });
  });
});
