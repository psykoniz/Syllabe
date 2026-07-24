import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
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
  detectTestCommand,
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
  /** Hard cap on total tokens for the run (default 3M). A run that blows past
   *  this is stuck in a loop — escalating early with a clear reason costs 10×
   *  less than letting review/repair cycles burn until their iteration caps. */
  tokenBudget?: number;
}

/** Default per-run token budget (~$15-30 depending on model). */
const DEFAULT_TOKEN_BUDGET = 3_000_000;

/** Cap an inter-state handoff at ~600 tokens so it informs without bloating. */
export function capHandoff(text: string, maxChars = 2400): string {
  const t = text.trim();
  return t.length <= maxChars ? t : t.slice(0, maxChars) + "\n[... handoff truncated ...]";
}

/** Build a lesson from an escalated run WITHOUT any LLM call — the reason and
 *  state are already known deterministically. Costs zero tokens now, and the
 *  next run on the same project sees it in its memory block (e.g. "previous
 *  run burned its budget in review cycles" steers the architect to smaller
 *  work units). Exported for unit testing. */
export function escalationLesson(
  task: string,
  runId: string,
  reason: string,
  state: string
): Lesson {
  const trigger = task
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3)
    .slice(0, 3)
    .join(" ");
  return {
    trigger: trigger || "escalation",
    content: `A previous run on this task escalated at ${state}: ${reason.slice(0, 300)}. ` +
      `Structure the work to avoid repeating this failure.`,
    runId,
    approved: true,
  };
}

/** Parse a VERDICT from agent output. Tries the strict `VERDICT: X` form
 *  first, then falls back to a bare keyword scan of the final 500 chars
 *  ("the tests pass, so my verdict is APPROVE" must not read as a rejection).
 *  Returns null when neither keyword appears — the caller decides the default. */
export function parseVerdict(text: string, positive: string, negative: string): boolean | null {
  const strict = new RegExp(`VERDICT:\\s*(${positive}|${negative.replace("_", "[_ ]")})`, "i").exec(text);
  if (strict) {
    return strict[1].toUpperCase().replace(" ", "_") === positive.toUpperCase();
  }
  const tail = text.slice(-500).toUpperCase();
  const posIdx = tail.lastIndexOf(positive.toUpperCase());
  const negIdx = Math.max(
    tail.lastIndexOf(negative.toUpperCase()),
    tail.lastIndexOf(negative.toUpperCase().replace("_", " "))
  );
  if (posIdx === -1 && negIdx === -1) return null;
  return posIdx > negIdx;
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

/** Per-role token ceiling per turn. Architect and implementer need long context
 *  windows for multi-file diffs and blueprints; simpler roles cap lower to
 *  reduce cost and output sprawl. */
const ROLE_MAX_TOKENS: Record<Role, number> = {
  "architect":          16384,
  "implementer":        16384,
  "reviewer":           8192,
  "product-strategist": 4096,
  "test-engineer":      8192,
  "memory-curator":     2048,
  "harness-optimizer":  4096,
};

/** Reasoning effort per role: high for design, review, clarify and implementation
 *  (the implementer writes the scored patch); low for testing, memory-curating and
 *  harness optimizing. */
const ROLE_EFFORT: Record<Role, EffortLevel> = {
  "architect":          "high",
  "reviewer":           "high",
  "product-strategist": "high",
  "implementer":        "high",
  "test-engineer":      "low",
  "memory-curator":     "low",
  "harness-optimizer":  "low",
};

/** State → role mapping */
const STATE_ROLE: Partial<Record<State, Role>> = {
  INTAKE:     "product-strategist",
  CLARIFY:    "product-strategist",
  DESIGN:     "architect",
  PLAN:       "architect",
  REPRODUCE:  "test-engineer",
  IMPLEMENT:  "implementer",
  TEST:       "test-engineer",
  REPAIR:     "implementer",
  REVIEW:     "reviewer",
  DOCUMENT:   "implementer",
  LEARN:      "memory-curator",
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
  /** Inter-state handoff: what the previous state concluded, injected into the
   *  next state's prompt so cycles carry their WHY (a rejected review otherwise
   *  re-prompts IMPLEMENT with zero memory of what the reviewer objected to). */
  private handoff: { from: State; content: string } | null = null;
  /** Cumulative token spend across every agent call in this run. */
  private totalTokens = 0;

  constructor(private cfg: ProjectRunConfig) {
    this.agentDir = join(cfg.workspace, ".agent");
    mkdirSync(this.agentDir, { recursive: true });
    // Pre-create the ADR directory so the architect never needs a `mkdir` shell
    // call (heredoc/mkdir via bash fails on some Windows shells and sends the
    // agent into a debugging spiral instead of writing the blueprints).
    mkdirSync(join(this.agentDir, "decisions"), { recursive: true });

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
    if (!this.cfg.gitUrl) {
      // Pre-populated workspace (e.g. an external clone checked out at a
      // specific commit): still build repo context so the agent can see the
      // existing codebase rather than working blind.
      if (existsSync(join(this.cfg.workspace, ".git"))) {
        this.repoContext = buildSmartRepoContext(this.cfg.workspace, this.cfg.task);
        this.repoTree = buildRepoTree(this.cfg.workspace);
        // Record HEAD as the base SHA here too. Without it workspaceDiff()
        // falls back to `git diff HEAD`, which goes blank as soon as the agent
        // commits — so REVIEW/DOCUMENT would silently get an empty diff on
        // exactly the harnesses that pre-populate a workspace (SWE-bench).
        try {
          const head = spawnSync("git", ["rev-parse", "HEAD"], {
            cwd: this.cfg.workspace, encoding: "utf8",
          }).stdout?.trim();
          if (head) {
            writeFileSync(
              join(this.agentDir, "repo.json"),
              JSON.stringify({ base_sha: head, base_branch: null, work_branch: null }, null, 2),
              "utf8"
            );
          }
        } catch {
          // best-effort — workspaceDiff degrades to `git diff HEAD`
        }
      }
      return;
    }

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

  /** Architecture + implementation plan, inlined for IMPLEMENT so the agent
   *  does not burn turns reading them back. Capped to keep input cost bounded. */
  private framedBlueprint(): string | null {
    const cap = 6000;
    const sections: string[] = [];
    for (const [label, file] of [
      ["Architecture", "architecture.md"],
      ["Implementation plan", "implementation-plan.md"],
    ] as const) {
      const p = join(this.agentDir, file);
      if (!existsSync(p)) continue;
      let body = readFileSync(p, "utf8").trim();
      if (!body) continue;
      if (body.length > cap) body = body.slice(0, cap) + "\n[... truncated; read the full file if needed]";
      sections.push(`### ${label} (.agent/${file})\n${body}`);
    }
    return sections.length > 0 ? sections.join("\n\n") : null;
  }

  /** Full diff of the run's changes (committed + working tree), for REVIEW.
   *  Reviewing without the diff forces the reviewer to rediscover the changes
   *  with glob/read calls — slower, costlier, and it misses deletions. */
  private workspaceDiff(cap = 8000): string | null {
    try {
      let base: string | null = null;
      const repoJson = join(this.agentDir, "repo.json");
      if (existsSync(repoJson)) {
        base = (JSON.parse(readFileSync(repoJson, "utf8")) as { base_sha?: string }).base_sha ?? null;
      }
      // Intent-to-add registers untracked files in the index without staging
      // their content, so brand-new files the agent wrote show up as additions
      // in the diff below. Without this the reviewer never sees new files.
      spawnSync("git", ["add", "-N", "--", "."], { cwd: this.cfg.workspace, encoding: "utf8" });
      const args = base ? ["diff", base] : ["diff", "HEAD"];
      const r = spawnSync("git", args, {
        cwd: this.cfg.workspace, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      });
      if (r.status !== 0) return null;
      let d = (r.stdout ?? "").trim();
      if (!d) return null;
      if (d.length > cap) d = d.slice(0, cap) + "\n[... diff truncated — use git_diff for the rest ...]";
      return "### Diff of all changes in this run\n```diff\n" + d + "\n```";
    } catch {
      return null;
    }
  }

  /** Render the pending handoff as a prompt section, or null. */
  private handoffBlock(...accept: State[]): string | null {
    if (!this.handoff || !accept.includes(this.handoff.from)) return null;
    const label = this.handoff.from === "REVIEW"
      ? "Reviewer feedback from the REJECTED review — fix ALL of these points"
      : `Summary from the previous ${this.handoff.from} state`;
    return `### ${label}\n${this.handoff.content}`;
  }

  // ─── AgentHandler ──────────────────────────────────────────────────────────

  async onState(state: State, ctx: RunContext): Promise<MachineEvent> {
    // Hard token budget: a run past this ceiling is looping, not progressing.
    // Let the cheap finishing states (DOCUMENT/LEARN) complete regardless so a
    // budget hit during review cycles still produces artifacts and lessons.
    const budget = this.cfg.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    if (this.totalTokens > budget && !["DOCUMENT", "LEARN"].includes(state)) {
      return {
        type: "ESCALATE",
        reason: `token budget exceeded (${this.totalTokens.toLocaleString()}/${budget.toLocaleString()} tokens) at ${state} — ` +
          `the run was likely stuck in a loop; see the trace timeline for where the spend concentrated`,
      };
    }

    switch (state) {
      case "INTAKE":     return this.handleIntake();
      case "CLARIFY":    return this.handleClarify();
      case "DESIGN":     return this.handleDesign(ctx);
      case "PLAN":       return this.handlePlan(ctx);
      case "REPRODUCE":  return this.handleReproduce(ctx);
      case "IMPLEMENT":  return this.handleImplement(ctx);
      case "TEST":       return this.handleTest(ctx);
      case "REPAIR":     return this.handleRepair(ctx);
      case "REVIEW":     return this.handleReview(ctx);
      case "DOCUMENT":   return this.handleDocument();
      case "LEARN":      return this.handleLearn();
      default:           return { type: "ESCALATE", reason: `unhandled state: ${state}` };
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

    let { valid, missing } = bp.validate(this.agentDir);

    // The architect occasionally writes blueprints via `bash` heredoc instead
    // of write_file; on some shells that fails and leaves files missing/empty.
    // Give it one corrective retry naming the exact gaps before escalating —
    // an empty design phase otherwise yields an empty patch with no recovery.
    if (!valid) {
      // Remove empty leftovers so write_file (which refuses to overwrite) succeeds.
      for (const f of missing) {
        const p = join(this.agentDir, f);
        if (existsSync(p)) rmSync(p, { force: true });
      }
      const retryPrompt = buildStatePrompt("DESIGN", this.cfg.task, {
        context: [interviewContent, this.framedRepoContext()].filter(Boolean).join("\n\n"),
        instructions: [
          "Your previous attempt left required blueprint files missing or empty.",
          `Missing or empty: ${missing.join(", ")}.`,
          "",
          "Write ONLY the missing files now. For each, call the write_file tool with the",
          "exact path and non-empty content. Do NOT use bash, cat, heredoc, or mkdir —",
          "those fail on some shells. write_file creates parent directories itself.",
          ...missing.map((f) => `  ${this.agentDir}/${f}`),
        ],
      });
      await this.callAgent("architect", retryPrompt);
      ({ valid, missing } = bp.validate(this.agentDir));
    }

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
            `Write tests with this project's framework (${detectTestCommand(this.cfg.workspace).framework}) for THIS unit's files and run \`${detectTestCommand(this.cfg.workspace).display}\`.`,
            "- If tests pass, reply with VERDICT: PASS",
            "- If tests fail and you cannot fix them in one attempt, reply with VERDICT: FAIL",
          ],
        });
        const result = await this.callAgent("test-engineer", prompt);
        return { passed: parseVerdict(result.finalText, "PASS", "FAIL") === true };
      },
      repair: async (wu, attempt) => {
        const prompt = buildStatePrompt("REPAIR", task, {
          instructions: [
            `Work unit: **${wu.description}** — repair attempt ${attempt}`,
            "",
            `Run this unit's tests with \`${detectTestCommand(this.cfg.workspace).display}\` to see the failures.`,
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
        const approved = parseVerdict(result.finalText, "APPROVE", "MUST_FIX") === true;
        return { approved, mustFix: approved ? [] : [result.finalText.slice(0, 500)] };
      },
    };
  }

  private async handleReproduce(ctx: RunContext): Promise<MachineEvent> {
    // Skip REPRODUCE when there is no existing repo — brand-new projects have no
    // failing baseline to reproduce against — or when the task is pure creation
    // ("add a feature", "build X"): a repro test only pays for itself when there
    // is broken behaviour to pin down first.
    const hasExistingRepo = existsSync(join(this.cfg.workspace, ".git"));
    if (!hasExistingRepo || !isBugFixTask(this.cfg.task)) {
      this.traceSystem("REPRODUCE", {
        decision: "skipped",
        reason: hasExistingRepo ? "task is not a bug fix" : "no existing repo",
      });
      return { type: "REPRODUCE_SKIP" };
    }

    const wu = ctx.workUnits[0];
    const codebase = this.framedRepoTree() ?? "";

    const prompt = buildStatePrompt("REPRODUCE", this.cfg.task, {
      context: codebase || undefined,
      instructions: [
        "Before implementing the fix, write a minimal test that REPRODUCES the bug or missing",
        "behaviour described in the task. The test must:",
        "  1. Fail on the CURRENT codebase (before any changes)",
        "  2. Be located in a new file named `repro_test.<ext>` in the project root",
        "  3. Use the project's existing test framework (bun:test, pytest, go test, etc.)",
        "",
        "Steps:",
        "  a. Write the repro test with write_file",
        "  b. Run it with bash — confirm it FAILS (exit code ≠ 0 means it fails as expected)",
        "  c. Reply with REPRO: CONFIRMED if the test fails, or REPRO: SKIP if you cannot",
        "     write a meaningful failing test for this task",
        "",
        wu ? `First work unit to fix: ${wu.description}` : "",
      ].filter(Boolean),
    });

    const result = await this.callAgent("test-engineer", prompt);
    const confirmed = /REPRO:\s*CONFIRMED/i.test(result.finalText);
    // Either outcome lets IMPLEMENT proceed; CONFIRMED means the agent has a
    // concrete red-test to guide the fix (and TEST will pick it up too).
    return confirmed ? { type: "REPRODUCE_DONE" } : { type: "REPRODUCE_SKIP" };
  }

  private async handleImplement(ctx: RunContext): Promise<MachineEvent> {
    const wu = ctx.workUnits[ctx.workUnitIndex];
    if (!wu) return { type: "IMPLEMENT_DONE" };

    // Inject the blueprint content directly rather than only naming the files:
    // otherwise the implementer must spend extra turns reading them back from
    // disk (and may hit the token ceiling mid-read on a large plan).
    const blueprint = this.framedBlueprint();

    // Give the implementer the task-guided context (relevant file paths +
    // excerpts) rather than a bare tree: it edits files it has actually seen,
    // instead of burning turns on read_file or failing edit_file on unseen code.
    const codebase = this.framedRepoContext() ?? this.framedRepoTree();

    // A rejected review re-enters IMPLEMENT: without the reviewer's objections
    // in the prompt, the implementer redoes the same work and the cycle spins
    // until maxReview escalates (the 4.2M-token / $43 failure mode).
    const reviewFeedback = this.handoffBlock("REVIEW");

    const prompt = buildStatePrompt("IMPLEMENT", this.cfg.task, {
      context: [reviewFeedback, blueprint, codebase].filter(Boolean).join("\n\n") || undefined,
      instructions: [
        `Work unit ${ctx.workUnitIndex + 1}/${ctx.workUnits.length}: **${wu.description}**`,
        "",
        ...(reviewFeedback
          ? ["A reviewer REJECTED the previous attempt — address every point in the",
             "reviewer feedback above before anything else.", ""]
          : []),
        "Implement this work unit completely:",
        "- Write all necessary source files using write_file",
        "- Follow the architecture and implementation plan included above",
        "- Do not write tests yet — that happens in the TEST state",
        "- When done, summarise what you created",
      ],
    });

    // After a review rejection the redo must be smarter, not just retried:
    // it now has the reviewer's objections AND deepest reasoning. Normal
    // first-pass implements stay at the default effort.
    const result = await this.callAgent("implementer", prompt, {
      effort: ctx.reviewCycleCount >= 1 ? "max" : undefined,
    });
    this.handoff = { from: "IMPLEMENT", content: capHandoff(result.finalText) };
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

    // Use the project's OWN test tooling. Telling the agent to run `bun test`
    // on a Python repo guarantees failure and burns the repair budget.
    const tc = detectTestCommand(this.cfg.workspace);

    const prompt = buildStatePrompt("TEST", this.cfg.task, {
      context: this.handoffBlock("IMPLEMENT", "REPAIR") ?? undefined,
      instructions: [
        `Work unit: **${wu?.description ?? "current"}**`,
        "",
        `This project's test framework is ${tc.framework}. Write tests with it and run \`${tc.display}\`.`,
        "Prefer running only the tests covering your change — the full suite may be slow.",
        "- If tests pass, reply with VERDICT: PASS",
        "- If tests fail and you cannot fix them in one attempt, reply with VERDICT: FAIL",
      ],
    });

    const result = await this.callAgent("test-engineer", prompt);
    // Robust parsing: strict `VERDICT: PASS` first, then keyword fallback. A
    // missed/false verdict is recovered below by the deterministic test run.
    const passed = parseVerdict(result.finalText, "PASS", "FAIL") === true;
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
    // The runner itself could not start (missing interpreter/toolchain). No
    // amount of source repair fixes that, so do not spend the REPAIR budget.
    if (testRun.unavailable) {
      this.traceSystem("TEST", { decision: "test runner unavailable — skipping repair", output: testRun.output });
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
        `After fixing, run \`${detectTestCommand(this.cfg.workspace).display}\` on the affected tests to confirm.`,
      ],
    });

    // Adaptive escalation: the first repair runs at the role's default effort;
    // a second failure has PROVEN the bug is hard, so pay for deepest reasoning
    // only then. Cheaper than a third blind attempt at normal effort.
    const result = await this.callAgent("implementer", prompt, {
      effort: ctx.repairCount >= 2 ? "max" : undefined,
    });
    this.handoff = { from: "REPAIR", content: capHandoff(result.finalText) };
    return { type: "REPAIR_DONE" };
  }

  private async handleReview(ctx: RunContext): Promise<MachineEvent> {
    const wu = ctx.workUnits[ctx.workUnitIndex];

    // Give the reviewer the actual diff and the implementer's summary up front:
    // judging blind forces it to rediscover the changes tool-call by tool-call,
    // and it never sees deletions at all.
    const diff = this.workspaceDiff();
    const implSummary = this.handoffBlock("IMPLEMENT", "REPAIR");

    const prompt = buildStatePrompt("REVIEW", this.cfg.task, {
      context: [implSummary, diff].filter(Boolean).join("\n\n") || undefined,
      instructions: [
        `Work unit: **${wu?.description ?? "current"}**`,
        "",
        "Review the implementation:",
        ...(diff
          ? ["- The full diff of the run's changes is provided above — review it first",
             "- Use read_file only where you need more context around a change"]
          : ["- Use glob_files and read_file to inspect the code"]),
        `- Run \`${detectTestCommand(this.cfg.workspace).display}\` to confirm tests pass`,
        "- Reply with VERDICT: APPROVE if the work is acceptable",
        "- Reply with VERDICT: MUST_FIX and list issues if it needs rework",
      ],
    });

    const result = await this.callAgent("reviewer", prompt);
    const approved = parseVerdict(result.finalText, "APPROVE", "MUST_FIX") === true;
    if (approved) {
      this.handoff = null;
      return { type: "REVIEW_APPROVE", verdictProvided: true };
    }
    // Carry the reviewer's objections into the next IMPLEMENT prompt.
    this.handoff = { from: "REVIEW", content: capHandoff(result.finalText) };
    return { type: "REVIEW_MUST_FIX" };
  }

  private async handleDocument(): Promise<MachineEvent> {
    const prompt = buildStatePrompt("DOCUMENT", this.cfg.task, {
      context: this.workspaceDiff(4000) ?? undefined,
      instructions: [
        "Write a README.md in the workspace root covering:",
        "- What was built and why",
        "- How to run it (`bun run ...`)",
        `- How to run the tests (\`${detectTestCommand(this.cfg.workspace).display}\`)`,
        "Then git commit all remaining uncommitted files.",
      ],
    });

    // Writing a README from a provided diff needs no deep reasoning — "low"
    // saves thinking tokens on every single run.
    await this.callAgent("implementer", prompt, { effort: "low" });
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

  private async callAgent(role: Role, prompt: string, opts: { effort?: EffortLevel } = {}) {
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
        effort: opts.effort ?? ROLE_EFFORT[role],
        maxTokensPerTurn: ROLE_MAX_TOKENS[role],
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
    this.totalTokens += result.usage.inputTokens + result.usage.outputTokens;
    return result;
  }

  private async extractWorkUnits(): Promise<WorkUnit[]> {
    // Pure-code parsing — eliminates a full architect LLM call per run.
    // The architect writes a predictable markdown format (numbered list,
    // ## headers, or bullet points); any of the three is handled below.
    const planPath = join(this.agentDir, "implementation-plan.md");
    if (!existsSync(planPath)) return [{ id: "wu-1", description: this.cfg.task }];
    const content = readFileSync(planPath, "utf8");
    return parseImplementationPlan(content, this.cfg.task);
  }

  // ─── Entry point ───────────────────────────────────────────────────────────

  async run(): Promise<LoopResult> {
    this.setupRepo();
    const ctx = makeContext([], this.cfg.loopBounds);
    try {
      const result = await runAgentLoop(ctx, {
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

      // Escalated runs are the most informative ones — record WHY, at zero
      // token cost, so the next run on this project starts warned.
      if (result.finalContext.state === "ESCALATED" && result.finalContext.escalationReason) {
        try {
          const globalMem = new GlobalMemory({ project: projectKeyFor(this.cfg.workspace) });
          globalMem.appendLesson(
            escalationLesson(
              this.cfg.task,
              this.cfg.runId,
              result.finalContext.escalationReason,
              // last checkpoint before ESCALATED is the state that failed
              "ESCALATED"
            ),
            "project"
          );
        } catch {
          // memory is best-effort
        }
      }

      return result;
    } finally {
      await this.browserSession?.close();
      this.browserSession = null;
    }
  }
}

/** Classify a task as a bug fix (something is currently broken and can be
 *  reproduced) vs pure creation (nothing to reproduce yet). SWE-bench issues
 *  are overwhelmingly bug reports — they name broken behaviour explicitly.
 *  Exported for unit testing. */
export function isBugFixTask(task: string): boolean {
  const t = task.toLowerCase();
  const bugSignals =
    /\b(bug|fix|fixes|broken|breaks?|crash(es|ed)?|error|exception|traceback|fail(s|ed|ing|ure)?|incorrect|wrong(ly)?|unexpected|regression|does not work|doesn't work|not working|should (not|be)|instead of)\b/;
  const pureCreationSignals =
    /^\s*(add|create|build|implement|write|set up|setup|generate|make)\b/;
  if (bugSignals.test(t)) return true;
  if (pureCreationSignals.test(t)) return false;
  // Ambiguous — default to reproducing: a wasted repro attempt costs one cheap
  // test-engineer call; a skipped repro on a real bug costs the whole run.
  return true;
}

/** Parse work units from implementation-plan.md without an LLM call.
 *  Handles the three formats the architect naturally produces:
 *    1. Numbered list  "1. Description" / "1) Description"
 *    2. Markdown headers  "## Work Unit 2: Do X" / "### Step 3"
 *    3. Bold bullet  "- **Title**: description" / "- **Title**"
 *  Picks the pattern with the most matches. Exported for unit testing. */
export function parseImplementationPlan(content: string, fallbackTask: string): WorkUnit[] {
  function extractMatches(re: RegExp, src: string): string[] {
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const text = (m[1] ?? "").replace(/\*{1,2}/g, "").trim();
      if (text.length > 5 && !/^(implementation|test|work unit|step|phase|overview|summary|note|introduction)/i.test(text)) {
        out.push(text);
      }
    }
    return out;
  }

  const candidates = [
    extractMatches(/^(?:\d+[.)]\s+)(.+)/gm, content),
    extractMatches(/^#{2,3}\s+(?:Work Unit\s*\d*:?\s*|\d+[.)]\s*)?(.+)/gm, content),
    extractMatches(/^[-*]\s+(?:\*{1,2})?(.+?)(?:\*{1,2})?(?::.*)?$/gm, content),
  ].filter((c) => c.length >= 1);

  const best = candidates.sort((a, b) => b.length - a.length)[0] ?? [];
  const units: WorkUnit[] = best
    .slice(0, 8)
    .map((desc, i) => ({ id: `wu-${i + 1}`, description: desc }));

  return units.length > 0 ? units : [{ id: "wu-1", description: fallbackTask }];
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
