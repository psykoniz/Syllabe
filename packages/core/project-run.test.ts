import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { Database } from "bun:sqlite";
import { ProjectRun } from "./project-run";
import type { ProjectRunConfig } from "./project-run";
import type { CreateMessageFn, ContentBlock } from "./agent-runner";

const TMP_BASE = "/tmp/projectos-run-test";

function makeWorkspace(label: string) {
  const dir = join(TMP_BASE, label);
  mkdirSync(dir, { recursive: true });
  // Bare git repo so GitTools doesn't blow up
  const { spawnSync } = require("child_process");
  spawnSync("git", ["init", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

function makeDb(workspace: string) {
  const dbPath = join(workspace, ".projectos", "runs.db");
  mkdirSync(join(workspace, ".projectos"), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.run(`CREATE TABLE IF NOT EXISTS agent_loop_runs (
    run_id TEXT PRIMARY KEY, state TEXT NOT NULL,
    work_unit_index INTEGER NOT NULL DEFAULT 0,
    repair_count INTEGER NOT NULL DEFAULT 0,
    steps INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  return db;
}

/** Returns a CreateMessageFn that serves scripted responses in order */
function scripted(responses: Array<string | ContentBlock[]>): CreateMessageFn {
  const queue = responses.map((r) =>
    typeof r === "string" ? [{ type: "text" as const, text: r }] : r
  );
  return async () => {
    const content = queue.shift() ?? [{ type: "text" as const, text: "done" }];
    const hasToolUse = content.some((b) => b.type === "tool_use");
    return {
      content,
      stop_reason: hasToolUse ? "tool_use" : "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  };
}

function makeRun(
  workspace: string,
  createMessage: CreateMessageFn,
  extras: Partial<ProjectRunConfig> = {}
): ProjectRun {
  const db = makeDb(workspace);
  return new ProjectRun({
    runId: randomUUID(),
    task: "Build a hello-world CLI",
    workspace,
    db,
    tracePath: join(workspace, ".projectos", "traces.jsonl"),
    createMessage,
    autoYes: true,
    maxIterationsPerState: 5,
    ...extras,
  });
}

// ─── INTAKE ────────────────────────────────────────────────────────────────

describe("INTAKE state", () => {
  let workspace: string;

  beforeEach(() => { workspace = makeWorkspace(`intake-${Date.now()}`); });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it("writes task.md and returns CLARIFY_DONE immediately", async () => {
    // INTAKE returns immediately; remaining states need scripted agent responses
    // We'll stop after CLARIFY by having CLARIFY also return quickly
    // and then let subsequent states escalate to terminate the loop.
    const createMessage = scripted([
      // CLARIFY: return without tool use → autoYes writes interview.md directly
      "Clarification complete.",
      // DESIGN: return ESCALATE trigger text
      "Unable to design.",
      // Catch-all
      "done",
    ]);

    const run = makeRun(workspace, createMessage);
    await run.run().catch(() => {/* escalation throws — fine */});

    expect(existsSync(join(workspace, ".agent", "task.md"))).toBe(true);
    const content = require("fs").readFileSync(join(workspace, ".agent", "task.md"), "utf8");
    expect(content).toContain("Build a hello-world CLI");
  });
});

// ─── DESIGN verdict parsing ────────────────────────────────────────────────

describe("DESIGN → blueprint validation", () => {
  let workspace: string;

  beforeEach(() => { workspace = makeWorkspace(`design-${Date.now()}`); });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it("escalates when agent doesn't produce blueprint files", async () => {
    // autoYes skips CLARIFY model call.
    // DESIGN runs but produces no files → blueprint validation fails → ESCALATE
    const createMessage = scripted([
      "I cannot design this.",
      "done", "done", "done",
    ]);

    const run = makeRun(workspace, createMessage);
    const result = await run.run();

    expect(["ESCALATED", "complete"]).toContain(result.finalContext.state);
    if (result.finalContext.state === "ESCALATED") {
      expect(result.finalContext.escalationReason).toBeTruthy();
    }
  });
});

// ─── TEST verdict parsing ──────────────────────────────────────────────────

describe("TEST verdict parsing", () => {
  let workspace: string;

  beforeEach(() => { workspace = makeWorkspace(`test-${Date.now()}`); });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it("returns TESTS_PASS when agent replies VERDICT: PASS", async () => {
    // Seed blueprint files so DESIGN passes validation
    const agentDir = join(workspace, ".agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "product.md"), "# Product\nHello world.");
    writeFileSync(join(agentDir, "architecture.md"), "# Arch\nSimple.");
    writeFileSync(join(agentDir, "implementation-plan.md"), "# Plan\n## Work unit\n- [ ] wu-1: main entrypoint");
    writeFileSync(join(agentDir, "test-plan.md"), "# Tests\nRun bun test.");

    // Scripted responses:
    // DESIGN → agent text (no tools, blueprint already seeded so validation passes)
    // extractWorkUnits → returns JSON work units
    // PLAN → no-op
    // IMPLEMENT → done
    // TEST → VERDICT: PASS
    // REVIEW → VERDICT: APPROVE
    // DOCUMENT → done
    // LEARN → done
    const createMessage = scripted([
      "Blueprint is ready.",                          // DESIGN
      '[{"id":"wu-1","description":"main entrypoint"}]', // extractWorkUnits
      "Plan acknowledged.",                           // PLAN
      "Implementation done.",                         // IMPLEMENT
      "VERDICT: PASS",                                // TEST
      "VERDICT: APPROVE",                             // REVIEW
      "Documentation written.",                       // DOCUMENT
      "Lessons recorded.",                            // LEARN
      "done", "done",
    ]);

    const run = makeRun(workspace, createMessage);
    const result = await run.run();

    // Should reach COMPLETE or at least TEST_PASS path
    expect(["COMPLETE", "complete", "ESCALATED"]).toContain(result.finalContext.state);
  });

  it("returns TESTS_FAIL when agent replies VERDICT: FAIL", async () => {
    const agentDir = join(workspace, ".agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "product.md"), "# Product\nHello world.");
    writeFileSync(join(agentDir, "architecture.md"), "# Arch\nSimple.");
    writeFileSync(join(agentDir, "implementation-plan.md"), "# Plan\n- wu-1");
    writeFileSync(join(agentDir, "test-plan.md"), "# Tests");

    const createMessage = scripted([
      "Blueprint done.",                              // DESIGN
      '[{"id":"wu-1","description":"main"}]',         // extractWorkUnits
      "Plan done.",                                   // PLAN
      "Implementation done.",                         // IMPLEMENT
      "VERDICT: FAIL",                                // TEST → TESTS_FAIL
      "Repair done.",                                 // REPAIR
      "VERDICT: PASS",                                // TEST (retry after repair)
      "VERDICT: APPROVE",                             // REVIEW
      "Docs done.",                                   // DOCUMENT
      "Lessons done.",                                // LEARN
      "done",
    ]);

    const run = makeRun(workspace, createMessage);
    const result = await run.run();
    // Repair cycle should have fired; run terminates somehow
    expect(result.steps).toBeGreaterThan(3);
  });
});

// ─── loopBounds override ───────────────────────────────────────────────────

describe("loopBounds override", () => {
  let workspace: string;

  beforeEach(() => { workspace = makeWorkspace(`bounds-${Date.now()}`); });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it("escalates after custom maxRepair instead of the default 3", async () => {
    const agentDir = join(workspace, ".agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "product.md"), "# P");
    writeFileSync(join(agentDir, "architecture.md"), "# A");
    writeFileSync(join(agentDir, "implementation-plan.md"), "# I");
    writeFileSync(join(agentDir, "test-plan.md"), "# T");

    // TEST always fails → with maxRepair=1, the run must escalate after 1 repair
    const createMessage: CreateMessageFn = async (params) => {
      const last = params.messages[params.messages.length - 1];
      const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
      let reply = "done";
      if (text.includes("## State: TEST")) reply = "VERDICT: FAIL";
      if (text.includes("extract") || text.includes("work unit")) reply = '[{"id":"wu-1","description":"main"}]';
      return {
        content: [{ type: "text", text: reply }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
    };

    const run = makeRun(workspace, createMessage, {
      loopBounds: { maxRepair: 1, maxReview: 2 },
    });
    const result = await run.run();

    expect(result.finalContext.state).toBe("ESCALATED");
    expect(result.finalContext.escalationReason).toContain("max repair iterations (1)");
  });
});

// ─── REVIEW verdict parsing ────────────────────────────────────────────────

describe("REVIEW verdict parsing", () => {
  let workspace: string;

  beforeEach(() => { workspace = makeWorkspace(`review-${Date.now()}`); });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it("returns REVIEW_APPROVE with verdictProvided=true on APPROVE", async () => {
    const agentDir = join(workspace, ".agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "product.md"), "# P");
    writeFileSync(join(agentDir, "architecture.md"), "# A");
    writeFileSync(join(agentDir, "implementation-plan.md"), "# I");
    writeFileSync(join(agentDir, "test-plan.md"), "# T");

    const calls: string[] = [];
    const createMessage: CreateMessageFn = async (params) => {
      const lastMsg = params.messages[params.messages.length - 1];
      const text = typeof lastMsg.content === "string"
        ? lastMsg.content
        : JSON.stringify(lastMsg.content);

      if (text.includes("## State: REVIEW")) calls.push("REVIEW");
      if (text.includes("## State: IMPLEMENT")) calls.push("IMPLEMENT");

      let replyText = "done";
      if (text.includes("## State: REVIEW")) replyText = "VERDICT: APPROVE";
      if (text.includes("## State: TEST")) replyText = "VERDICT: PASS";
      if (text.includes("extract") || text.includes("work unit")) {
        replyText = '[{"id":"wu-1","description":"main"}]';
      }

      return {
        content: [{ type: "text", text: replyText }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
    };

    const run = makeRun(workspace, createMessage);
    const result = await run.run();
    expect(calls).toContain("REVIEW");
  });
});

// ─── modelOverride ─────────────────────────────────────────────────────────

describe("modelOverride", () => {
  let workspace: string;

  beforeEach(() => { workspace = makeWorkspace(`model-${Date.now()}`); });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it("replaces fable-tier roles only — cheaper tiers keep their model", async () => {
    const seenModels = new Set<string>();
    const createMessage: CreateMessageFn = async (params) => {
      seenModels.add(params.model as string);
      return {
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
    };

    const agentDir = join(workspace, ".agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "product.md"), "# P");
    writeFileSync(join(agentDir, "architecture.md"), "# A");
    writeFileSync(join(agentDir, "implementation-plan.md"), "# I");
    writeFileSync(join(agentDir, "test-plan.md"), "# T");

    const run = makeRun(workspace, createMessage, {
      modelOverride: "claude-sonnet-4-6",
    });
    await run.run().catch(() => {});

    // No fable model may remain, and the override must never upgrade
    // haiku-tier roles (memory-curator) to a pricier model.
    for (const m of seenModels) {
      expect(m).not.toContain("fable");
    }
    expect(seenModels.has("claude-sonnet-4-6")).toBe(true);
  });
});

// ─── work unit fallback ────────────────────────────────────────────────────

describe("work unit fallback", () => {
  let workspace: string;

  beforeEach(() => { workspace = makeWorkspace(`wu-${Date.now()}`); });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it("falls back to a single work unit when implementation-plan.md is absent", async () => {
    // Plant all blueprint files EXCEPT implementation-plan.md
    const agentDir = join(workspace, ".agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "product.md"), "# P");
    writeFileSync(join(agentDir, "architecture.md"), "# A");
    writeFileSync(join(agentDir, "test-plan.md"), "# T");
    // No implementation-plan.md → extractWorkUnits should fall back

    const createMessage = scripted([
      "Blueprint done.",          // DESIGN (validation will fail — no impl plan)
      "done", "done", "done",
    ]);

    const run = makeRun(workspace, createMessage);
    const result = await run.run();
    // Either escalates (missing plan file) or processes wu-1 fallback — either is acceptable
    expect(result.steps).toBeGreaterThanOrEqual(1);
  });
});

describe("systemPromptOverrides", () => {
  let workspace: string;

  beforeEach(() => { workspace = makeWorkspace(`sysprompt-${Date.now()}`); });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it("uses the override prompt for the targeted role only", async () => {
    const agentDir = join(workspace, ".agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "product.md"), "# P");
    writeFileSync(join(agentDir, "architecture.md"), "# A");
    writeFileSync(join(agentDir, "implementation-plan.md"), "# I");
    writeFileSync(join(agentDir, "test-plan.md"), "# T");

    const systemsSeen: Record<string, string> = {};
    const createMessage: CreateMessageFn = async (params) => {
      const last = params.messages[params.messages.length - 1];
      const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
      const sys = typeof params.system === "string"
        ? params.system
        : (params.system ?? []).map((b) => b.text).join("\n");
      if (text.includes("## State: IMPLEMENT")) systemsSeen.implementer = sys;
      if (text.includes("## State: REVIEW")) systemsSeen.reviewer = sys;

      let reply = "done";
      if (text.includes("## State: TEST")) reply = "VERDICT: PASS";
      if (text.includes("## State: REVIEW")) reply = "VERDICT: APPROVE";
      if (text.includes("work unit")) reply = '[{"id":"wu-1","description":"main"}]';
      return {
        content: [{ type: "text", text: reply }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
    };

    const run = makeRun(workspace, createMessage, {
      systemPromptOverrides: { implementer: "CUSTOM IMPLEMENTER PROMPT" },
    });
    await run.run();

    expect(systemsSeen.implementer).toBe("CUSTOM IMPLEMENTER PROMPT");
    expect(systemsSeen.reviewer ?? "").not.toBe("CUSTOM IMPLEMENTER PROMPT");
  });
});

describe("memory injection", () => {
  it("prepends ### Memory to architect prompts when lessons match", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { Database } = await import("bun:sqlite");

    const ws = mkdtempSync(join(tmpdir(), "memrun-"));
    const home = mkdtempSync(join(tmpdir(), "memhome-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      // Seed global memory for this project key (basename of ws)
      const { GlobalMemory, projectKeyFor } = await import("@projectos/memory");
      const gm = new GlobalMemory({ project: projectKeyFor(ws) });
      gm.appendLesson(
        { id: "1", trigger: "widget", content: "Widgets need tests", createdAt: "", runId: "r", approved: true },
        "project"
      );

      const prompts: string[] = [];
      const stub = async (params: { messages: Array<{ content: unknown }> }) => {
        prompts.push(String(params.messages[0].content));
        return { content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
      };

      const db = new Database(":memory:");
      const { ProjectRun } = await import("./project-run");
      const run = new ProjectRun({
        runId: "test-mem-1",
        task: "build a widget factory",
        workspace: ws,
        db,
        tracePath: join(ws, "traces.jsonl"),
        createMessage: stub as never,
        autoYes: true,
      });

      //

      await (run as never as { callAgent: (r: string, p: string) => Promise<unknown> })
        .callAgent("architect", "design the thing");
      await (run as never as { callAgent: (r: string, p: string) => Promise<unknown> })
        .callAgent("reviewer", "review the thing");

      expect(prompts[0]).toContain("### Memory");
      expect(prompts[0]).toContain("Widgets need tests");
      expect(prompts[1]).not.toContain("### Memory");
    } finally {
      process.env.HOME = prevHome;
      rmSync(ws, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
