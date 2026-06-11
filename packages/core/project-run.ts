import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { runAgentLoop } from "./agent-loop";
import { makeContext } from "./state-machine";
import { runWorkUnitsParallel } from "./parallel-runner";
import type { TaskExecutor } from "./task-runner";
import type { AgentHandler, LoopResult } from "./agent-loop";
import type { RunContext, MachineEvent, State, WorkUnit, LoopBounds } from "./state-machine";
import { buildSystemPrompt } from "./system-prompt";
import { appendTrace } from "@projectos/telemetry";
import { FsTools, BashTool, GitTools, TOOL_DEFINITIONS } from "@projectos/tools";
import type { ToolContext } from "@projectos/tools";
import { DockerSandbox, SandboxedBash } from "@projectos/sandbox";
import { BrowserSession, dispatchPlaywrightTool, PLAYWRIGHT_TOOL_DEFINITIONS } from "@projectos/playwright-tools";
import { PermissionEngine } from "@projectos/policy";
import type { ApprovalHandler } from "@projectos/policy";
import { resolveModel } from "@projectos/router";
import type { Role } from "@projectos/router";
import { InterviewSession, DEFAULT_QUESTIONS, BlueprintSession } from "@projectos/agents";
import { runAgent } from "./agent-runner";
import type { CreateMessageFn, EffortLevel } from "./agent-runner";
import { spawnSync } from "child_process";

export interface ProjectRunConfig {
  runId: string;
  task: string;
  workspace: string;
  db: Database;
  tracePath: string;
  createMessage: CreateMessageFn;
  approval?: ApprovalHandler;
  /** Apply all interview defaults without prompting */
  autoYes?: boolean;
  maxIterationsPerState?: number;
  /** Force all role calls to use this model (useful when fable is unavailable) */
  modelOverride?: string;
  /** Override state machine loop bounds (e.g. from a promoted candidate config) */
  loopBounds?: LoopBounds;
  /** Per-role system prompt overrides (candidate config scope). Keyed by role
   *  name (e.g. "reviewer"); replaces the generated prompt for that role. */
  systemPromptOverrides?: Record<string, string>;
  /** Route bash tool calls through a Docker sandbox for isolation.
   *  Requires Docker to be available on the host. */
  sandbox?: boolean;
  /** Docker image to use when sandbox is enabled (default: node:20-alpine) */
  sandboxImage?: string;
  /** Enable Playwright browser tools (navigate, click, fill, extract, screenshot, eval) */
  browserTools?: boolean;
  /** Run work units concurrently with this concurrency (≥2 enables parallel
   *  mode; each unit runs its own implement→test⇄repair→review pipeline). */
  parallelWorkUnits?: number;
}

/** Reasoning effort per role: max only where deep reflection pays off.
 *  CLARIFY (product-strategist) is mostly mechanical — high is enough. */
const ROLE_EFFORT: Partial<Record<Role, EffortLevel>> = {
  "architect": "max",
  "reviewer":  "max",
  "product-strategist": "high",
};

/** State → role mapping */
const STATE_ROLE: Partial<Record<State, Role>> = {
  INTAKE:    "product-strategist",
  CLARIFY:   "product-strategist",
  DESIGN:    "architect",
  PLAN:      "architect",
  IMPLEMENT: "implementer",
  TEST:      "test-engineer",
  REPAIR:    "implementer",
  REVIEW:    "reviewer",
  DOCUMENT:  "implementer",
  LEARN:     "memory-curator",
};

export class ProjectRun implements AgentHandler {
  private agentDir: string;
  private toolContext: ToolContext;
  private browserSession: BrowserSession | null = null;

  constructor(private cfg: ProjectRunConfig) {
    this.agentDir = join(cfg.workspace, ".agent");
    mkdirSync(this.agentDir, { recursive: true });

    const logPath = join(cfg.workspace, ".projectos", "tool-calls.jsonl");
    let bashTool;
    if (cfg.sandbox) {
      if (DockerSandbox.isAvailable()) {
        bashTool = new SandboxedBash({ logPath, workspace: cfg.workspace, sandboxImage: cfg.sandboxImage });
      } else {
        console.warn("sandbox requested but Docker is not available — falling back to host bash");
        bashTool = new BashTool({ logPath, workspace: cfg.workspace });
      }
    } else {
      bashTool = new BashTool({ logPath, workspace: cfg.workspace });
    }
    this.toolContext = {
      fs: new FsTools({ logPath }),
      bash: bashTool,
      git: new GitTools({ logPath, repoPath: cfg.workspace }),
      workspace: cfg.workspace,
      branch: () => {
        const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: cfg.workspace, encoding: "utf8",
        });
        return (r.stdout ?? "").trim();
      },
    };
  }

  // ─── AgentHandler ──────────────────────────────────────────────────────────

  async onState(state: State, ctx: RunContext): Promise<MachineEvent> {
    switch (state) {
      case "INTAKE":    return this.handleIntake();
      case "CLARIFY":   return this.handleClarify();
      case "DESIGN":    return this.handleDesign(ctx);
      case "PLAN":      return this.handlePlan(ctx);
      case "IMPLEMENT": return this.handleImplement(ctx);
      case "TEST":      return this.handleTest(ctx);
      case "REPAIR":    return this.handleRepair(ctx);
      case "REVIEW":    return this.handleReview(ctx);
      case "DOCUMENT":  return this.handleDocument();
      case "LEARN":     return this.handleLearn();
      default:          return { type: "ESCALATE", reason: `unhandled state: ${state}` };
    }
  }

  // ─── State handlers ────────────────────────────────────────────────────────

  private async handleIntake(): Promise<MachineEvent> {
    // INTAKE is a pass-through: record the task and move to CLARIFY
    writeFileSync(join(this.agentDir, "task.md"), `# Task\n\n${this.cfg.task}\n`, "utf8");
    return { type: "CLARIFY_DONE" };
  }

  private async handleClarify(): Promise<MachineEvent> {
    const interviewFile = join(this.agentDir, "interview.md");
    const session = new InterviewSession(DEFAULT_QUESTIONS, {
      autoYes: this.cfg.autoYes,
    });

    if (!this.cfg.autoYes) {
      // Ask the model (product-strategist) to answer questions on behalf of the task
      const prompt = buildStatePrompt("CLARIFY", this.cfg.task, {
        instructions: [
          "You are reviewing the task brief above.",
          "Answer each question below based on what can be inferred from the brief.",
          "If the brief is silent on a question, say SKIP to accept the default.",
          "Reply with one line per question: <question-id>: <answer or SKIP>",
          "",
          "Questions:",
          ...DEFAULT_QUESTIONS.map((q) => `${q.id}: ${q.text} (default: ${q.default})`),
        ],
      });

      const result = await this.callAgent("product-strategist", prompt);

      for (const q of DEFAULT_QUESTIONS) {
        const match = new RegExp(`^${q.id}:\\s*(.+)$`, "m").exec(result.finalText);
        const answer = match?.[1]?.trim();
        if (!answer || answer.toUpperCase() === "SKIP") {
          session.skip(q.id);
        } else {
          session.answer(q.id, answer);
        }
      }
    }

    session.save(interviewFile);
    return { type: "DESIGN_DONE" };
  }

  private async handleDesign(ctx: RunContext): Promise<MachineEvent> {
    const bp = new BlueprintSession({ interviewFile: join(this.agentDir, "interview.md") });
    const interviewContent = existsSync(join(this.agentDir, "interview.md"))
      ? bp.loadInterview(join(this.agentDir, "interview.md"))
      : "";

    const prompt = buildStatePrompt("DESIGN", this.cfg.task, {
      context: interviewContent,
      instructions: [
        "SCOPE RULE — the task description above is the single source of truth for scope.",
        "The interview answers are generic defaults: apply them ONLY where the task actually",
        "needs them. Do NOT add authentication, databases, deployment targets, or any feature",
        "the task does not explicitly require. A trivial task gets a trivial design with 1-2",
        "work units; never pad the plan to look more complete.",
        "",
        "Generate 4 blueprint files for this project. For each file, call write_file with the exact path shown:",
        `  ${this.agentDir}/product.md          — product vision, users, problems solved, success metrics`,
        `  ${this.agentDir}/architecture.md     — system design, tech stack, key components`,
        `  ${this.agentDir}/implementation-plan.md — ordered list of work units (tasks to implement)`,
        `  ${this.agentDir}/test-plan.md        — testing strategy and acceptance criteria`,
        "",
        "Also write an ADR file:",
        `  ${this.agentDir}/decisions/ADR-001-<slug>.md — one key architectural decision`,
        "",
        "Each file must be non-empty. Use write_file for all of them.",
      ],
    });

    await this.callAgent("architect", prompt);

    const { valid, missing } = bp.validate(this.agentDir);
    return {
      type: "PLAN_DONE",
      workUnits: valid ? await this.extractWorkUnits() : [],
      blueprintValidated: valid,
    };
  }

  private async handlePlan(ctx: RunContext): Promise<MachineEvent> {
    // Work units were already extracted by the architect during DESIGN and live
    // in ctx.workUnits — a second architect call here would re-derive the same
    // list and its output couldn't update the context anyway (IMPLEMENT_DONE
    // carries no work units). Persist them for traceability and move on.
    writeFileSync(
      join(this.agentDir, "work-units.json"),
      JSON.stringify(ctx.workUnits, null, 2),
      "utf8"
    );

    // Parallel mode: run every unit's full pipeline here, then skip the
    // sequential IMPLEMENT/TEST/REVIEW states entirely.
    const concurrency = this.cfg.parallelWorkUnits ?? 0;
    if (concurrency >= 2 && ctx.workUnits.length > 1) {
      const bounds = this.cfg.loopBounds ?? { maxRepair: 3, maxReview: 2 };
      const { results, allSucceeded } = await runWorkUnitsParallel(
        ctx.workUnits,
        this.makeParallelExecutor(ctx.workUnits.length),
        { ...bounds, concurrency }
      );
      writeFileSync(
        join(this.agentDir, "parallel-results.json"),
        JSON.stringify(results, null, 2),
        "utf8"
      );
      if (!allSucceeded) {
        const failed = results.filter((r) => !r.success);
        return {
          type: "ESCALATE",
          reason: `parallel execution: ${failed.length}/${results.length} unit(s) failed — ` +
            failed.map((f) => `${f.workUnitId}: ${f.escalationReason}`).join("; "),
        };
      }
      return { type: "IMPLEMENT_DONE", allUnitsComplete: true };
    }

    return { type: "IMPLEMENT_DONE" };
  }

  /** TaskExecutor backed by the same role prompts as the sequential states. */
  private makeParallelExecutor(totalUnits: number): TaskExecutor {
    const task = this.cfg.task;
    return {
      implement: async (wu) => {
        const prompt = buildStatePrompt("IMPLEMENT", task, {
          instructions: [
            `Work unit (parallel, 1 of ${totalUnits}): **${wu.description}**`,
            "",
            "Implement this work unit completely:",
            "- Write all necessary source files using write_file",
            "- Follow the architecture.md and implementation-plan.md in .agent/",
            "- Only touch files this unit owns — other units run concurrently",
            "- When done, summarise what you created",
          ],
        });
        await this.callAgent("implementer", prompt);
        return { success: true };
      },
      test: async (wu) => {
        const prompt = buildStatePrompt("TEST", task, {
          instructions: [
            `Work unit: **${wu.description}**`,
            "",
            "Write tests using bun:test for THIS unit's files and run them with `bun test <file>`.",
            "- If tests pass, reply with VERDICT: PASS",
            "- If tests fail and you cannot fix them in one attempt, reply with VERDICT: FAIL",
          ],
        });
        const result = await this.callAgent("test-engineer", prompt);
        return { passed: /VERDICT:\s*PASS/i.test(result.finalText) };
      },
      repair: async (wu, attempt) => {
        const prompt = buildStatePrompt("REPAIR", task, {
          instructions: [
            `Work unit: **${wu.description}** — repair attempt ${attempt}`,
            "",
            "Run this unit's tests with `bun test <file>` to see the failures.",
            "Fix the source code (not the tests) to make them pass.",
            "Confirm with another test run.",
          ],
        });
        await this.callAgent("implementer", prompt);
      },
      review: async (wu) => {
        const prompt = buildStatePrompt("REVIEW", task, {
          instructions: [
            `Work unit: **${wu.description}**`,
            "",
            "Review this unit's implementation:",
            "- Use glob_files and read_file to inspect the code",
            "- Run this unit's tests to confirm they pass",
            "- Reply with VERDICT: APPROVE if the work is acceptable",
            "- Reply with VERDICT: MUST_FIX and list issues if it needs rework",
          ],
        });
        const result = await this.callAgent("reviewer", prompt);
        const approved = /VERDICT:\s*APPROVE/i.test(result.finalText);
        return { approved, mustFix: approved ? [] : [result.finalText.slice(0, 500)] };
      },
    };
  }

  private async handleImplement(ctx: RunContext): Promise<MachineEvent> {
    const wu = ctx.workUnits[ctx.workUnitIndex];
    if (!wu) return { type: "IMPLEMENT_DONE" };

    const prompt = buildStatePrompt("IMPLEMENT", this.cfg.task, {
      instructions: [
        `Work unit ${ctx.workUnitIndex + 1}/${ctx.workUnits.length}: **${wu.description}**`,
        "",
        "Implement this work unit completely:",
        "- Write all necessary source files using write_file",
        "- Follow the architecture.md and implementation-plan.md in .agent/",
        "- Do not write tests yet — that happens in the TEST state",
        "- When done, summarise what you created",
      ],
    });

    await this.callAgent("implementer", prompt);
    return { type: "IMPLEMENT_DONE" };
  }

  private async handleTest(ctx: RunContext): Promise<MachineEvent> {
    const wu = ctx.workUnits[ctx.workUnitIndex];

    const prompt = buildStatePrompt("TEST", this.cfg.task, {
      instructions: [
        `Work unit: **${wu?.description ?? "current"}**`,
        "",
        "Write tests using bun:test and run them with `bun test`.",
        "- If tests pass, reply with VERDICT: PASS",
        "- If tests fail and you cannot fix them in one attempt, reply with VERDICT: FAIL",
      ],
    });

    const result = await this.callAgent("test-engineer", prompt);
    const passed = /VERDICT:\s*PASS/i.test(result.finalText);
    return passed ? { type: "TESTS_PASS" } : { type: "TESTS_FAIL" };
  }

  private async handleRepair(ctx: RunContext): Promise<MachineEvent> {
    const wu = ctx.workUnits[ctx.workUnitIndex];

    const prompt = buildStatePrompt("REPAIR", this.cfg.task, {
      instructions: [
        `Work unit: **${wu?.description ?? "current"}** — repair attempt ${ctx.repairCount}`,
        "",
        "Run the tests with `bun test` to see the current failures.",
        "Fix the source code (not the tests) to make them pass.",
        "Confirm with another `bun test` run.",
      ],
    });

    await this.callAgent("implementer", prompt);
    return { type: "REPAIR_DONE" };
  }

  private async handleReview(ctx: RunContext): Promise<MachineEvent> {
    const wu = ctx.workUnits[ctx.workUnitIndex];

    const prompt = buildStatePrompt("REVIEW", this.cfg.task, {
      instructions: [
        `Work unit: **${wu?.description ?? "current"}**`,
        "",
        "Review the implementation:",
        "- Use glob_files and read_file to inspect the code",
        "- Run `bun test` to confirm tests pass",
        "- Reply with VERDICT: APPROVE if the work is acceptable",
        "- Reply with VERDICT: MUST_FIX and list issues if it needs rework",
      ],
    });

    const result = await this.callAgent("reviewer", prompt);
    const approved = /VERDICT:\s*APPROVE/i.test(result.finalText);
    return approved
      ? { type: "REVIEW_APPROVE", verdictProvided: true }
      : { type: "REVIEW_MUST_FIX" };
  }

  private async handleDocument(): Promise<MachineEvent> {
    const prompt = buildStatePrompt("DOCUMENT", this.cfg.task, {
      instructions: [
        "Write a README.md in the workspace root covering:",
        "- What was built and why",
        "- How to run it (`bun run ...`)",
        "- How to run the tests (`bun test`)",
        "Then git commit all remaining uncommitted files.",
      ],
    });

    await this.callAgent("implementer", prompt);
    return { type: "DOCUMENT_DONE" };
  }

  private async handleLearn(): Promise<MachineEvent> {
    // Memory-curator writes lessons — lightweight, haiku-tier
    const prompt = buildStatePrompt("LEARN", this.cfg.task, {
      instructions: [
        "Reflect on this run. Write a file .agent/lessons.json with 1–3 lessons learned.",
        'Format: [{"trigger":"<keyword>","content":"<one sentence lesson>","runId":"' + this.cfg.runId + '","approved":true}]',
        "Keep it concise.",
      ],
    });

    await this.callAgent("memory-curator", prompt);
    return { type: "LEARN_DONE" };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async callAgent(role: Role, prompt: string) {
    // modelOverride exists to substitute unavailable premium models (fable);
    // it must never upgrade the cost of roles already on a cheaper tier (haiku).
    const resolved = resolveModel(role);
    const model =
      this.cfg.modelOverride && resolved.includes("fable")
        ? this.cfg.modelOverride
        : resolved;
    const system =
      this.cfg.systemPromptOverrides?.[role] ??
      buildSystemPrompt({
        workspace: this.cfg.workspace,
        branch: this.toolContext.branch?.(),
        role: role === "implementer" || role === "test-engineer" ? "implementer"
            : role === "architect" ? "architect"
            : role === "reviewer" ? "reviewer"
            : "product-strategist",
      });

    const start = Date.now();

    // Lazy-init browser session when browser tools are enabled
    if (this.cfg.browserTools && !this.browserSession) {
      const logPath = join(this.cfg.workspace, ".projectos", "tool-calls.jsonl");
      this.browserSession = new BrowserSession({ logPath });
    }

    const extraTools = this.cfg.browserTools ? PLAYWRIGHT_TOOL_DEFINITIONS : [];
    const extraDispatcher = this.cfg.browserTools && this.browserSession
      ? (name: string, input: Record<string, unknown>) =>
          dispatchPlaywrightTool(name, input, this.browserSession!)
      : undefined;

    const result = await runAgent(
      [{ role: "user", content: prompt }],
      {
        createMessage: this.cfg.createMessage,
        model,
        system,
        toolContext: this.toolContext,
        tools: extraTools.length > 0 ? [...TOOL_DEFINITIONS, ...extraTools] : undefined,
        approval: this.cfg.approval,
        maxIterations: this.cfg.maxIterationsPerState ?? 20,
        effort: ROLE_EFFORT[role],
        extraDispatcher,
      }
    );

    appendTrace(this.cfg.tracePath, {
      ts: new Date().toISOString(),
      runId: this.cfg.runId,
      phase: role.toUpperCase(),
      role,
      model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      durationMs: Date.now() - start,
    });

    return result;
  }

  private async extractWorkUnits(): Promise<WorkUnit[]> {
    // Parse work units from implementation-plan.md
    const planPath = join(this.agentDir, "implementation-plan.md");
    if (!existsSync(planPath)) return [{ id: "wu-1", description: this.cfg.task }];

    const prompt = [
      "Read the implementation plan below and extract an ordered list of work units.",
      "Reply with JSON only — an array of objects with id (string) and description (string).",
      "Example: [{\"id\":\"wu-1\",\"description\":\"Set up project structure\"}]",
      "",
      "Use read_file to load: " + planPath,
    ].join("\n");

    const result = await this.callAgent("architect", prompt);
    return parseWorkUnits(result.finalText, this.cfg.task);
  }

  // ─── Entry point ───────────────────────────────────────────────────────────

  async run(): Promise<LoopResult> {
    const ctx = makeContext([], this.cfg.loopBounds);
    try {
      return await runAgentLoop(ctx, {
        runId: this.cfg.runId,
        db: this.cfg.db,
        handler: this,
      });
    } finally {
      await this.browserSession?.close();
      this.browserSession = null;
    }
  }
}

function parseWorkUnits(text: string, fallbackTask: string): WorkUnit[] {
  try {
    const match = /\[[\s\S]*?\]/.exec(text);
    if (match) {
      const parsed = JSON.parse(match[0]) as unknown[];
      const units = parsed.filter(
        (u): u is WorkUnit =>
          typeof u === "object" && u !== null &&
          typeof (u as WorkUnit).id === "string" &&
          typeof (u as WorkUnit).description === "string"
      );
      if (units.length > 0) return units.slice(0, 8);
    }
  } catch {
    // fall through to fallback
  }
  return [{ id: "wu-1", description: fallbackTask }];
}

function buildStatePrompt(
  state: State,
  task: string,
  opts: { context?: string; instructions: string[] }
): string {
  return [
    `## State: ${state}`,
    "",
    "### Task brief",
    task,
    ...(opts.context ? ["", "### Context", opts.context] : []),
    "",
    "### Instructions",
    ...opts.instructions,
  ].join("\n");
}
