import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { appendSteering, readPendingSteering, markConsumed } from "./steering";

describe("steering", () => {
  let ws: string;
  const RUN = "run-1";

  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "steer-")); });
  afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

  it("appends and reads pending messages in order", () => {
    appendSteering(ws, RUN, "first");
    appendSteering(ws, RUN, "second");
    const pending = readPendingSteering(ws, RUN);
    expect(pending.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("markConsumed removes messages from pending, idempotently", () => {
    const a = appendSteering(ws, RUN, "do x");
    appendSteering(ws, RUN, "do y");
    markConsumed(ws, RUN, [a.id]);
    markConsumed(ws, RUN, [a.id]); // idempotent
    const pending = readPendingSteering(ws, RUN);
    expect(pending).toHaveLength(1);
    expect(pending[0].text).toBe("do y");
  });

  it("isolates runs", () => {
    appendSteering(ws, "other-run", "not for you");
    expect(readPendingSteering(ws, RUN)).toHaveLength(0);
  });

  it("skips malformed lines", () => {
    appendSteering(ws, RUN, "ok");
    appendFileSync(join(ws, ".projectos", "steering", `${RUN}.jsonl`), "{broken\n");
    expect(readPendingSteering(ws, RUN)).toHaveLength(1);
  });

  it("returns empty when no file", () => {
    expect(readPendingSteering(ws, "ghost")).toEqual([]);
  });
});

describe("steering injection via ProjectRun", () => {
  it("injects pending instructions exactly once into the next prompt", async () => {
    const { Database } = await import("bun:sqlite");
    const ws = mkdtempSync(join(tmpdir(), "steerrun-"));
    try {
      const prompts: string[] = [];
      const stub = async (params: { messages: Array<{ content: unknown }> }) => {
        prompts.push(String(params.messages[0].content));
        return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
      };
      const { ProjectRun } = await import("./project-run");
      const run = new ProjectRun({
        runId: "steer-run",
        task: "t",
        workspace: ws,
        db: new Database(":memory:"),
        tracePath: join(ws, "traces.jsonl"),
        createMessage: stub as never,
        autoYes: true,
      });
      appendSteering(ws, "steer-run", "use tabs not spaces");
      const call = (run as never as { callAgent: (r: string, p: string) => Promise<unknown> }).callAgent.bind(run);
      await call("implementer", "implement it");
      await call("implementer", "continue");
      expect(prompts[0]).toContain("Operator instructions");
      expect(prompts[0]).toContain("use tabs not spaces");
      expect(prompts[1]).not.toContain("Operator instructions");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
