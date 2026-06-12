import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
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
import { UserMemory, LessonCurator, GlobalMemory, projectKeyFor, SkillStore } from "@projectos/memory";
import { readPendingSteering, markConsumed } from "./steering";
import { EXPLORE_TOOL, createExploreDispatcher, chainDispatchers, ExtraDispatcher } from "./explorer-tool";
import type { Lesson } from "@projectos/memory";
import { buildRepoContext, buildRepoTree, buildSmartRepoContext } from "./repo-context";
import { ensureRunMetaTable, setRunMeta } from "./session-db";
import { runAgent } from "./agent-runner";
import type { CreateMessageFn, EffortLevel } from "./agent-runner";
import {
  ensureNodeModules,
  runWorkspaceTests,
  parseTestFailures,
  getChangedFiles,
  failuresOutsideScope,
  changedFileStats,
  buildRepairDiagnostic,
  buildStructuredDiagnostic,
} from "./workspace-runner";
import type { TestFailure } from "./workspace-runner";
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
  /** Existing repository to work on (URL or local path). When set, the run
   *  clones it into the workspace and works on a dedicated branch. */
  gitUrl?: string;
  /** Base branch to clone from (default "main") */
  baseBranch?: string;
  /** Branch the run works on (default `projectos/run-<runId8>`) */
  workBranch?: string;
  /** Enable the lightweight LLM critic between state transitions (haiku by
   *  default, ~$0.0002/transition). Corrections are injected as steering
   *  messages consumed by the next state's prompt. */
  autoSteering?: boolean;
}

/** Framing prepended to the repo context so it never expands the task scope. */
const REPO_CONTEXT_FRAMING =
  "### Existing codebase\n" +
  "You are MODIFYING an existing repository, not creating a new project. The repo below is " +
  "context only — it does NOT expand the task scope. Implement exactly what the task brief " +
  "asks, following this codebase's existing conventions, file layout, and tooling. Do not " +
  "refactor, rewrite, or 'improve' unrelated code. Blueprint files still go in the .agent/ " +
  "directory as instructed.";

const EXISTING_REPO_INSTRUCTION =
  "This is an existing repository — locate the right files with the file tree above and " +
  "modify in place; run the project's own test command.";

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
  private repoContext: string | null = null;
  private repoTree: string | null = null;
  private memoryBlock: string | null = null;
  /** Structured failures from the last failing TEST run, for REPAIR. */
  private lastTestFailures: TestFailure[] = [];
  /** Final text of the most recent agent call, fed to the auto-steering critic. */
  private lastAgentText = "";

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

  // ─── Existing-repo setup ───────────────────────────────────────────────────

  /** Clone the configured repository into the workspace, record the base SHA
   *  and switch to the dedicated work branch. No-op when gitUrl is unset. */
  private setupRepo(): void {
    if (!this.cfg.gitUrl) return;

    const baseBranch = this.cfg.baseBranch ?? "main";
    const workBranch =
      this.cfg.workBranch ?? `projectos/run-${this.cfg.runId.slice(0, 8)}`;

    GitTools.clone(this.cfg.gitUrl, this.cfg.workspace, baseBranch);

    // Ensure commits made by the agent have an identity in this clone
    const hasIdentity = spawnSync("git", ["config", "user.email"], {
      cwd: this.cfg.workspace, encoding: "utf8",
    }).status === 0;
    if (!hasIdentity) {
      spawnSync("git", ["config", "user.email", "agent@projectos"], { cwd: this.cfg.workspace });
      spawnSync("git", ["config", "user.name", "ProjectOS Agent"], { cwd: this.cfg.workspace });
    }

    const baseSha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: this.cfg.workspace, encoding: "utf8",
    }).stdout?.trim() ?? "";

    writeFileSync(
      join(this.agentDir, "repo.json"),
      JSON.stringify({ base_sha: baseSha, base_branch: baseBranch, work_branch: workBranch }, null, 2),
      "utf8"
    );
    try {
      ensureRunMetaTable(this.cfg.db);
      setRunMeta(this.cfg.db, this.cfg.runId, "base_sha", baseSha);
    } catch {
      // run_meta is best-effort — .agent/repo.json is the source of truth
    }

    new GitTools({
      logPath: join(this.cfg.workspace, ".projectos", "tool-calls.jsonl"),
      repoPath: this.cfg.workspace,
    }).createBranch(workBranch);

    this.repoContext = buildSmartRepoContext(this.cfg.workspace, this.cfg.task);
    this.repoTree = buildRepoTree(this.cfg.workspace);
  }

  /** Full repo context (tree + README + conventions) with scope framing. */
  private framedRepoContext(): string | null {
    if (!this.repoContext) return null;
    return `${REPO_CONTEXT_FRAMING}\n\n${this.repoContext}`;
  }

  /** Tree-only repo context with a one-line instruction, for PLAN/IMPLEMENT. */
  private framedRepoTree(): string | null {
    if (!this.repoTree) return null;
    return `### Existing codebase\n${this.repoTree}\n\n${EXISTING_REPO_INSTRUCTION}`;
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
      context: [interviewContent, this.framedRepoContext()].filter(Boolean).join("\n\n"),
      instructions: [
        "SCOPE RULE — the task description above is the single source of truth for scope.",
        "The interview answers are generic defaults: apply them ONLY where the task actually",
        "needs them. Do NOT add authentication, databases, deployment targets, or any feature",
        "the task does not explicitly require. A trivial task gets a trivial design with 1-2",
        "work units; never pad the plan to look more complete.",
        "",
        "WORK UNIT RULES for implementation-plan.md:",
        "- Each work unit must produce a deliverable: a new or modified file, or a passing test.",
        "- Exploration steps (read, inspect, grep) are NOT work units — fold them into the unit that uses the findings.",
        "- Target 1-3 work units for simple tasks, 3-5 for medium, never more than 6 for any task.",
        "- Bad: 'Inspect CLI wiring' (no deliverable). Good: 'Add stats.ts and wire into index.ts' (one deliverable).",
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
          context: this.framedRepoTree() ?? undefined,
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
      context: this.framedRepoTree() ?? undefined,
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

    // Fix 1: guarantee a usable workspace before any `bun test` run —
    // isolated clones often lack node_modules, and missing dependencies
    // produce failures that have nothing to do with the task.
    const install = ensureNodeModules(this.cfg.workspace);
    if (install.attempted) {
      this.traceSystem("TEST", { install: install.detail, ok: install.ok });
    }

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
    if (passed) {
      this.lastTestFailures = [];
      return { type: "TESTS_PASS" };
    }

    // Fix 2: before entering REPAIR, run `bun test` deterministically and
    // check whether every failure lives in files the agent never touched.
    // Out-of-scope failures (e.g. a pre-existing broken test elsewhere in
    // the monorepo) must not trap the run in a REPAIR loop.
    const testRun = runWorkspaceTests(this.cfg.workspace);
    if (testRun.exitCode === 0) {
      // Tests actually pass — the agent's verdict was wrong.
      this.lastTestFailures = [];
      return { type: "TESTS_PASS" };
    }
    const failures = parseTestFailures(testRun.output);
    const failedFiles = [...new Set(failures.map((f) => f.file))];
    const changed = getChangedFiles(this.cfg.workspace);
    if (failuresOutsideScope(failedFiles, changed)) {
      this.traceSystem("TEST", {
        decision: "test failures outside task scope — skipping repair",
        failedFiles,
        changedFiles: changed,
      });
      this.lastTestFailures = [];
      return { type: "TESTS_PASS" };
    }
    this.lastTestFailures = failures;
    return { type: "TESTS_FAIL" };
  }

  private async handleRepair(ctx: RunContext): Promise<MachineEvent> {
    const wu = ctx.workUnits[ctx.workUnitIndex];

    // Fix 3+: structured JSON diagnostic — file:line, test name, error message
    // and surrounding code context for each failure, plus the run's diff stats.
    // LLMs handle structured JSON more reliably than free-form markdown.
    const diagnostic = buildStructuredDiagnostic(
      this.lastTestFailures,
      changedFileStats(this.cfg.workspace),
      this.cfg.workspace,
    );

    const prompt = buildStatePrompt("REPAIR", this.cfg.task, {
      context: diagnostic,
      instructions: [
        `Work unit: **${wu?.description ?? "current"}** — repair attempt ${ctx.repairCount}`,
        "",
        "The test failures are provided as structured JSON in the context above.",
        "Each failure includes the file, line, error message, and surrounding code.",
        "Fix ONLY the source code files listed in changedFiles — never modify test files.",
        "After fixing, run `bun test` on the affected files to confirm.",
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

    // Persist lessons beyond this workspace (Hermes-style global memory):
    // fresh clones would otherwise lose everything written to .agent/.
    try {
      const lessonsPath = join(this.agentDir, "lessons.json");
      if (existsSync(lessonsPath)) {
        const lessons = JSON.parse(readFileSync(lessonsPath, "utf8")) as Lesson[];
        const globalMem = new GlobalMemory({ project: projectKeyFor(this.cfg.workspace) });
        for (const l of lessons.filter((l) => l.approved && l.trigger && l.content)) {
          globalMem.appendLesson(l, "project");
        }
      }
    } catch {
      // global memory is best-effort
    }

    // Persist skills from successful runs — extract the workflow pattern
    // (architecture + plan) so future runs can reuse proven approaches.
    try {
      const planPath = join(this.agentDir, "implementation-plan.md");
      const archPath = join(this.agentDir, "architecture.md");
      if (existsSync(planPath)) {
        const plan = readFileSync(planPath, "utf8");
        const arch = existsSync(archPath) ? readFileSync(archPath, "utf8") : "";
        const tags = this.cfg.task
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 3)
          .slice(0, 5);

        // Local skill store
        const localSkills = new SkillStore(join(this.agentDir, "skills.json"));
        localSkills.add(
          `run-${this.cfg.runId.slice(0, 8)}`,
          `Workflow for: ${this.cfg.task.slice(0, 100)}`,
          [
            "## Architecture pattern",
            arch.slice(0, 500),
            "",
            "## Implementation plan",
            plan.slice(0, 500),
          ].join("\n"),
          tags,
        );

        // Global skill store (survives fresh clones)
        const home = process.env.HOME ?? "~";
        const globalSkillPath = join(
          home, ".projectos", "skills",
          projectKeyFor(this.cfg.workspace), "skills.json"
        );
        const globalSkills = new SkillStore(globalSkillPath);
        globalSkills.add(
          `run-${this.cfg.runId.slice(0, 8)}`,
          `Workflow for: ${this.cfg.task.slice(0, 100)}`,
          plan.slice(0, 500),
          tags,
        );
      }
    } catch {
      // skill extraction is best-effort
    }

    return { type: "LEARN_DONE" };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Trace a non-agent (orchestrator) event, e.g. workspace install or
   *  scope decisions around REPAIR. */
  private traceSystem(phase: string, meta: Record<string, unknown>): void {
    try {
      appendTrace(this.cfg.tracePath, {
        ts: new Date().toISOString(),
        runId: this.cfg.runId,
        phase,
        role: "system",
        model: "-",
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        meta,
      });
    } catch {
      // tracing is best-effort
    }
  }

  /** Roles whose prompts benefit from past lessons and preferences. */
  private static MEMORY_ROLES = new Set<Role>(["architect", "implementer"]);

  /** Hermes-style memory block: user prefs + global/project lessons + skills
   *  matched against the task. Built once per run, capped at ~3k chars.
   *  Lessons use semantic search when embeddings are configured
   *  (PROJECTOS_EMBEDDINGS_API_KEY), substring matching otherwise. */
  private async buildMemoryBlock(): Promise<string> {
    if (this.memoryBlock !== null) return this.memoryBlock;
    try {
      const home = process.env.HOME ?? "~";
      const userMem = new UserMemory(join(home, ".projectos", "preferences.json"));
      const globalMem = new GlobalMemory({ project: projectKeyFor(this.cfg.workspace) });
      const localLessons = new LessonCurator(join(this.agentDir, "lessons.json"));
      const globalSkillPath = join(
        home, ".projectos", "skills",
        projectKeyFor(this.cfg.workspace), "skills.json"
      );
      const skillStore = new SkillStore(globalSkillPath);

      const parts = [
        userMem.toContextBlock(),
        await globalMem.toSemanticContextBlock(this.cfg.task),
        localLessons.toContextBlock(this.cfg.task),
        skillStore.toContextBlock(),
      ].filter(Boolean);

      this.memoryBlock = parts.length > 0
        ? ("### Memory\n" + parts.join("\n")).slice(0, 3000)
        : "";
    } catch {
      this.memoryBlock = "";
    }
    return this.memoryBlock;
  }

  private async callAgent(role: Role, prompt: string) {
    // modelOverride exists to substitute unavailable premium models (fable);
    // it must never upgrade the cost of roles already on a cheaper tier (haiku).
    // With a non-Anthropic provider, the router's claude-* ids don't exist —
    // the override applies to every role.
    const resolved = resolveModel(role);
    const nonAnthropicProvider = process.env.PROJECTOS_PROVIDER === "openai";
    const model =
      this.cfg.modelOverride && (nonAnthropicProvider || resolved.includes("fable"))
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

    const extraTools = [...(this.cfg.browserTools ? PLAYWRIGHT_TOOL_DEFINITIONS : [])];
    const playwrightDispatcher = this.cfg.browserTools && this.browserSession
      ? (name: string, input: Record<string, unknown>) =>
          dispatchPlaywrightTool(name, input, this.browserSession!)
      : undefined;

    // Architect and implementer can fan out read-only research sub-agents
    let exploreDispatcher: ExtraDispatcher | undefined;
    if (ProjectRun.MEMORY_ROLES.has(role)) {
      extraTools.push(EXPLORE_TOOL);
      exploreDispatcher = createExploreDispatcher({
        createMessage: this.cfg.createMessage,
        toolContext: this.toolContext,
      });
    }
    const extraDispatcher =
      playwrightDispatcher || exploreDispatcher
        ? async (name: string, input: Record<string, unknown>) => {
            const res = await chainDispatchers(playwrightDispatcher, exploreDispatcher)(name, input);
            return res ?? null;
          }
        : undefined;

    const memory = ProjectRun.MEMORY_ROLES.has(role) ? await this.buildMemoryBlock() : "";

    // Mid-run operator steering: inject pending instructions exactly once
    let steeringBlock = "";
    const pending = readPendingSteering(this.cfg.workspace, this.cfg.runId);
    if (pending.length > 0) {
      steeringBlock =
        "### Operator instructions (mid-run)\n" +
        pending.map((m) => `- ${m.text}`).join("\n");
      markConsumed(this.cfg.workspace, this.cfg.runId, pending.map((m) => m.id));
    }

    const finalPrompt = [steeringBlock, memory, prompt].filter(Boolean).join("\n\n");

    const result = await runAgent(
      [{ role: "user", content: finalPrompt }],
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

    this.lastAgentText = result.finalText;
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
    this.setupRepo();
    const ctx = makeContext([], this.cfg.loopBounds);
    try {
      return await runAgentLoop(ctx, {
        runId: this.cfg.runId,
        db: this.cfg.db,
        handler: this,
        ...(this.cfg.autoSteering
          ? {
              autoSteering: {
                createMessage: this.cfg.createMessage,
                model: this.cfg.modelOverride,
                workspace: this.cfg.workspace,
                runId: this.cfg.runId,
                task: this.cfg.task,
                getLastOutput: () => this.lastAgentText,
              },
            }
          : {}),
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
