import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EXPLORE_TOOL, createExploreDispatcher, chainDispatchers } from "./explorer-tool";
import { FsTools, BashTool, GitTools } from "@projectos/tools";
import type { ChatResponse } from "./agent-runner";

function makeCtx(ws: string) {
  const logPath = join(ws, "log.jsonl");
  return {
    fs: new FsTools({ logPath }),
    bash: new BashTool({ logPath, workspace: ws }),
    git: new GitTools({ logPath, repoPath: ws }),
    workspace: ws,
  };
}

describe("createExploreDispatcher", () => {
  it("ignores other tool names", async () => {
    const ws = mkdtempSync(join(tmpdir(), "exp-"));
    try {
      const d = createExploreDispatcher({
        createMessage: async () => ({ content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } }) as ChatResponse,
        toolContext: makeCtx(ws),
      });
      expect(await d("bash", {})).toBeUndefined();
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it("runs a read-only sub-agent and returns its answer", async () => {
    const ws = mkdtempSync(join(tmpdir(), "exp2-"));
    try {
      writeFileSync(join(ws, "main.ts"), "export const answer = 42;\n");
      let toolNamesSeen: string[] = [];
      const stub = async (params: { tools?: Array<{ name: string }> }): Promise<ChatResponse> => {
        toolNamesSeen = (params.tools ?? []).map((t) => t.name);
        return {
          content: [{ type: "text", text: "answer is in main.ts:1" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      };
      const d = createExploreDispatcher({ createMessage: stub as never, toolContext: makeCtx(ws) });
      const r = await d("explore", { question: "where is the answer?" });
      expect(r?.isError).toBe(false);
      expect(r?.content).toContain("main.ts:1");
      // sub-agent only gets read-only tools
      expect(toolNamesSeen.sort()).toEqual(["glob_files", "grep_files", "read_file"]);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it("requires a question", async () => {
    const ws = mkdtempSync(join(tmpdir(), "exp3-"));
    try {
      const d = createExploreDispatcher({
        createMessage: (async () => ({ content: [], stop_reason: "end_turn" })) as never,
        toolContext: makeCtx(ws),
      });
      const r = await d("explore", {});
      expect(r?.isError).toBe(true);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it("caps concurrency", async () => {
    const ws = mkdtempSync(join(tmpdir(), "exp4-"));
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((res) => { release = res; });
      const slow = async (): Promise<ChatResponse> => {
        await gate;
        return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
      };
      const d = createExploreDispatcher({
        createMessage: slow as never, toolContext: makeCtx(ws), maxConcurrent: 1,
      });
      const p1 = d("explore", { question: "q1" });
      const r2 = await d("explore", { question: "q2" });
      expect(r2?.isError).toBe(true);
      expect(r2?.content).toContain("concurrent");
      release();
      const r1 = await p1;
      expect(r1?.isError).toBe(false);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });
});

describe("chainDispatchers", () => {
  it("first non-undefined result wins, in order", async () => {
    const a = (n: string) => (n === "a" ? { content: "from a", isError: false } : undefined);
    const b = (n: string) => (n === "a" || n === "b" ? { content: "from b", isError: false } : undefined);
    const chained = chainDispatchers(a, b);
    expect((await chained("a", {}))?.content).toBe("from a");
    expect((await chained("b", {}))?.content).toBe("from b");
    expect(await chained("c", {})).toBeUndefined();
  });
});
