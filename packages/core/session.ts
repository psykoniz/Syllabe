import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { appendTrace } from "@projectos/telemetry";
import { FsTools, BashTool, GitTools } from "@projectos/tools";
import type { ToolContext } from "@projectos/tools";
import { setHarnessApiKey } from "@projectos/policy";
import type { ApprovalHandler } from "@projectos/policy";
import { runAgent } from "./agent-runner";
import type { CreateMessageFn, MessageParam, AgentRunResult } from "./agent-runner";
import { proxyFetch } from "./proxy-fetch";
import { buildSmartRepoContext } from "./repo-context";
import { detectTestCommand } from "./workspace-runner";
import { GlobalMemory, projectKeyFor } from "@projectos/memory";
import { buildSystemPrompt } from "./system-prompt";
import type { SystemPromptOptions } from "./system-prompt";
import {
  AdrStore,
  UserMemory,
  LessonCurator,
  SkillStore,
  ProjectMemory,
  assembleContext,
} from "@projectos/memory";

export interface MemoryPaths {
  /** ~/.projectos/preferences.json — user-level prefs */
  userPrefs?: string;
  /** <workspace>/.agent/decisions/ — ADR files */
  decisionsDir?: string;
  /** <workspace>/.agent/lessons.json */
  lessons?: string;
  /** <workspace>/.agent/skills.json */
  skills?: string;
  /** <workspace>/.agent/project-memory.json */
  projectMemory?: string;
}

export interface SessionConfig {
  model: string;
  workspace: string;
  dbPath: string;
  tracePath: string;
  toolLogPath?: string;       // default: <dir of dbPath>/tool-calls.jsonl
  sessionsDir?: string;       // default: <dir of dbPath>/sessions
  /** Override the auto-generated system prompt entirely */
  system?: string;
  /** Passed to buildSystemPrompt if system is not overridden */
  role?: SystemPromptOptions["role"];
  /** Explicit memory context string — if omitted, auto-loaded from memoryPaths */
  memoryContext?: string;
  /** Paths for memory layer — defaults derived from workspace/.agent/ */
  memoryPaths?: MemoryPaths;
  /** Topic hint for lesson matching (e.g. the user prompt) */
  memoryTopic?: string;
  approval?: ApprovalHandler;
  maxIterations?: number;
  /** Injectable for tests; defaults to the real Anthropic client.
   *  Reads ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL from env. */
  createMessage?: CreateMessageFn;
  /** Hard ceiling on total tokens for the session (default 1M ≈ a few dollars).
   *  Set 0 to disable. */
  tokenBudget?: number;
  /** Skip the task-guided repository map (on by default when the workspace is
   *  a git repo — it is the single most useful context for real codebases). */
  noRepoContext?: boolean;
}

/** ~1M tokens: a few dollars at premium rates. Generous for an interactive
 *  session, but bounded — an unguarded loop on a real repo has no ceiling. */
const DEFAULT_SESSION_TOKEN_BUDGET = 1_000_000;

export interface RunRecord {
  runId: string;
  model: string;
  status: "running" | "complete" | "failed";
  createdAt: string;
  updatedAt: string;
}

function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.run(`CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY, model TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  return db;
}

export async function defaultCreateMessage(): Promise<CreateMessageFn> {
  // PROJECTOS_PROVIDER=openai (or having only an OpenAI key) routes every
  // model call through the OpenAI-compatible adapter instead of Anthropic.
  const wantsOpenAi =
    process.env.PROJECTOS_PROVIDER === "openai" ||
    (!!process.env.OPENAI_API_KEY &&
      !process.env.ANTHROPIC_API_KEY &&
      !process.env.ANTHROPIC_AUTH_TOKEN);
  if (wantsOpenAi) {
    const { openAiCreateMessage } = await import("./openai-adapter");
    return openAiCreateMessage();
  }

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  // Pass proxy-aware fetch so Bun routes through HTTPS_PROXY when set.
  const client = new Anthropic({ fetch: proxyFetch as typeof globalThis.fetch });
  return async (params) => {
    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // The SDK response is passed through structurally — `usage` keeps
        // cache_read_input_tokens / cache_creation_input_tokens when the
        // provider returns them (see ChatUsage in agent-runner.ts).
        return await client.messages.create(params as never) as unknown as ReturnType<CreateMessageFn>;
      } catch (e: unknown) {
        const status = (e as { status?: number }).status;
        const retryable = status === 429 || status === 503 || status === 502 || status === 504;
        if (!retryable || attempt === maxRetries - 1) throw e;
        const delay = Math.min(2000 * 2 ** attempt, 30000);
        console.error(`[retry ${attempt + 1}/${maxRetries}] HTTP ${status} — waiting ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error("unreachable");
  };
}

export class ProjectSession {
  private db: Database;
  readonly runId: string;

  constructor(private config: SessionConfig) {
    this.db = openDb(config.dbPath);
    this.runId = randomUUID();

    // The harness's own credential must never appear in any tool output.
    const harnessKey = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
    if (harnessKey) setHarnessApiKey(harnessKey);
  }

  private now(): string {
    return new Date().toISOString();
  }

  private toolLogPath(): string {
    return this.config.toolLogPath ?? join(dirname(this.config.dbPath), "tool-calls.jsonl");
  }

  private sessionsDir(): string {
    return this.config.sessionsDir ?? join(dirname(this.config.dbPath), "sessions");
  }

  private messagesPath(runId: string): string {
    return join(this.sessionsDir(), `${runId}.json`);
  }

  private saveMessages(runId: string, messages: MessageParam[]): void {
    mkdirSync(this.sessionsDir(), { recursive: true });
    writeFileSync(this.messagesPath(runId), JSON.stringify(messages, null, 2), "utf8");
  }

  private loadMessages(runId: string): MessageParam[] {
    const p = this.messagesPath(runId);
    if (!existsSync(p)) throw new Error(`No saved conversation for run: ${runId}`);
    return JSON.parse(readFileSync(p, "utf8"));
  }

  private loadMemoryContext(topic: string): string {
    if (this.config.memoryContext !== undefined) return this.config.memoryContext;

    const agentDir = join(this.config.workspace, ".agent");
    const mp = this.config.memoryPaths ?? {};

    const userPrefsPath = mp.userPrefs ?? join(process.env.HOME ?? "~", ".projectos", "preferences.json");
    const decisionsDir  = mp.decisionsDir  ?? join(agentDir, "decisions");
    const lessonsPath   = mp.lessons       ?? join(agentDir, "lessons.json");
    const skillsPath    = mp.skills        ?? join(agentDir, "skills.json");
    const projectMemPath = mp.projectMemory ?? join(agentDir, "project-memory.json");

    const userMem   = new UserMemory(userPrefsPath);
    const adrStore  = new AdrStore(decisionsDir);
    const lessons   = new LessonCurator(lessonsPath);
    const skills    = new SkillStore(skillsPath);
    const projMem   = new ProjectMemory(projectMemPath);

    // Global (cross-run, per-project) lessons on top of the workspace-local
    // ones: these survive fresh clones and are the whole point of the memory
    // layer when the same repositories are worked on repeatedly.
    let globalLessons = "";
    try {
      globalLessons = new GlobalMemory({
        project: projectKeyFor(this.config.workspace),
      }).toContextBlock(topic);
    } catch {
      // global memory is best-effort
    }

    return assembleContext({
      prefs:    userMem.toContextBlock(),
      commands: projMem.toContextBlock(),
      adrs:     adrStore.toContextBlock(),
      lessons:  [globalLessons, lessons.toContextBlock(topic)].filter(Boolean).join("\n"),
      skills:   skills.toContextBlock(),
    });
  }

  /** Task-guided repository map: keyword-matched files ranked by import-graph
   *  PageRank, with symbol signatures and excerpts. Only for git workspaces —
   *  this is the highest-value context when working on an existing codebase,
   *  and it was previously available only through the full state machine. */
  private loadRepoContext(topic: string): string {
    if (this.config.noRepoContext) return "";
    if (!existsSync(join(this.config.workspace, ".git"))) return "";
    try {
      return buildSmartRepoContext(this.config.workspace, topic);
    } catch {
      return "";
    }
  }

  private buildToolContext(): ToolContext {
    const logPath = this.toolLogPath();
    const workspace = this.config.workspace;
    return {
      fs: new FsTools({ logPath }),
      bash: new BashTool({ logPath, workspace }),
      git: new GitTools({ logPath, repoPath: workspace }),
      workspace,
      branch: () => {
        const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: workspace,
          encoding: "utf8",
        });
        return (r.stdout ?? "").trim();
      },
    };
  }

  private async getCreateMessage(): Promise<CreateMessageFn> {
    return this.config.createMessage ?? (await defaultCreateMessage());
  }

  private async runTurns(
    runId: string,
    messages: MessageParam[],
    phase: "SESSION" | "RESUME"
  ): Promise<AgentRunResult> {
    const start = Date.now();
    const createMessage = await this.getCreateMessage();

    const toolContext = this.buildToolContext();
    const topic = typeof messages[0]?.content === "string"
      ? messages[0].content
      : (this.config.memoryTopic ?? "");
    const memoryContext = this.loadMemoryContext(topic);
    const system =
      this.config.system ??
      buildSystemPrompt({
        workspace: this.config.workspace,
        branch: toolContext.branch?.(),
        role: this.config.role,
        memoryContext: memoryContext || undefined,
        repoContext: this.loadRepoContext(topic) || undefined,
        testCommand: detectTestCommand(this.config.workspace).display,
      });

    const result = await runAgent(messages, {
      createMessage,
      model: this.config.model,
      system,
      toolContext: toolContext,
      approval: this.config.approval,
      maxIterations: this.config.maxIterations,
      // Default ceiling so a session on a real repository cannot run away;
      // 0 disables it explicitly.
      tokenBudget: this.config.tokenBudget ?? DEFAULT_SESSION_TOKEN_BUDGET,
    });

    this.saveMessages(runId, result.messages);

    appendTrace(this.config.tracePath, {
      ts: this.now(),
      runId,
      phase,
      role: "core",
      model: this.config.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      durationMs: Date.now() - start,
    });

    return result;
  }

  async start(userPrompt: string): Promise<AgentRunResult> {
    const now = this.now();
    this.db.run(
      `INSERT INTO runs (run_id, model, status, created_at, updated_at)
       VALUES (?, ?, 'running', ?, ?)`,
      [this.runId, this.config.model, now, now]
    );

    try {
      const result = await this.runTurns(
        this.runId,
        [{ role: "user", content: userPrompt }],
        "SESSION"
      );
      this.db.run(`UPDATE runs SET status = 'complete', updated_at = ? WHERE run_id = ?`, [
        this.now(),
        this.runId,
      ]);
      return result;
    } catch (e) {
      this.db.run(`UPDATE runs SET status = 'failed', updated_at = ? WHERE run_id = ?`, [
        this.now(),
        this.runId,
      ]);
      throw e;
    }
  }

  /** Resume a prior run by id: loads its saved conversation and continues it. */
  async resume(runId: string, message: string): Promise<AgentRunResult> {
    const messages = this.loadMessages(runId);
    messages.push({ role: "user", content: message });

    const result = await this.runTurns(runId, messages, "RESUME");

    this.db.run(`UPDATE runs SET status = 'complete', updated_at = ? WHERE run_id = ?`, [
      this.now(),
      runId,
    ]);
    return result;
  }

  getRecord(runId: string = this.runId): RunRecord | null {
    return (
      this.db
        .query<RunRecord, string>(
          `SELECT run_id as runId, model, status, created_at as createdAt, updated_at as updatedAt
           FROM runs WHERE run_id = ?`
        )
        .get(runId) ?? null
    );
  }

  listRuns(): RunRecord[] {
    return this.db
      .query<RunRecord, []>(
        `SELECT run_id as runId, model, status, created_at as createdAt, updated_at as updatedAt
         FROM runs ORDER BY created_at DESC`
      )
      .all();
  }

  close(): void {
    this.db.close();
  }
}
