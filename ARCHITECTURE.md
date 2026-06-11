# ProjectOS Agent — Architecture

## High-Level Structure

```
projectos-agent/
  apps/
    cli/                    # Commander-based CLI entry point
    web-ui/                 # Local Next.js approval/monitoring UI

  packages/
    core/                   # State machine, agent loop, task runner
    router/                 # Model and role routing
    memory/                 # Persistent memory, ADRs, lessons, skills
    tools/                  # All tool implementations
    policy/                 # Permissions, secrets redaction, approvals
    evals/                  # Benchmark runner, scoring, frontier tracking
    telemetry/              # Logging, cost tracking, run replay
    agents/                 # Agent role definitions and prompts
```

---

## Package Details

### `packages/core`

```
agent-loop.ts       # Main orchestration loop
state-machine.ts    # State definitions, transitions, exit criteria
task-runner.ts      # Executes a task within a state
session.ts          # Session ID, run metadata, start/stop
```

State machine types:

```ts
type State =
  | "INTAKE"
  | "CLARIFY"
  | "DESIGN"
  | "PLAN"
  | "IMPLEMENT"
  | "TEST"
  | "REPAIR"
  | "REVIEW"
  | "DOCUMENT"
  | "LEARN"
  | "COMPLETE"

interface StateConfig {
  agent: AgentRole
  modelTier: "fable" | "sonnet" | "haiku"
  tools: ToolName[]
  budgetTokens: number
  overflowPolicy: "summarize-and-continue" | "escalate" | "abort"
  exitWhen: ExitCondition[]
  abortWhen: AbortCondition[]
}
```

Execution model:

- PLAN produces an ordered list of **work units** ("local PRs"). The segment IMPLEMENT → TEST → REPAIR → REVIEW runs once **per work unit**, not once per project.
- TEST ⇄ REPAIR is a bounded loop: max 3 repair iterations per work unit, then escalate to the user.
- A REVIEW verdict with `mustFix` items returns to IMPLEMENT: max 2 cycles per work unit, then escalate.
- Budget overflow never routes to REPAIR and never silently continues — it applies the state's `overflowPolicy`.
- Every transition writes a checkpoint row to SQLite (state, work-unit index, context summary). `projectos resume` restarts from the last checkpoint.

### `packages/router`

```
model-router.ts     # Maps role + task complexity → model ID
role-router.ts      # Maps state → agent role
budget-router.ts    # Tracks spend per state, enforces limits
```

Model routing policy:

```ts
const modelMap: Record<AgentRole, ModelTier> = {
  "product-strategist": "fable",
  "architect":          "fable",
  "reviewer":           "fable",
  "implementer":        "sonnet",
  "test-engineer":      "sonnet",
  "memory-curator":     "haiku",
  "harness-optimizer":  "fable", // analysis phase; switches to sonnet for implementation
}
```

Failure policy: implementer, test-engineer, and memory-curator fall back one tier on model error. Architect, reviewer, and product-strategist **retry with backoff, then pause and notify** — a silent quality downgrade on a decision-making role is worse than waiting.

### `packages/memory`

```
project-memory.ts   # Per-project context pack loader/writer
user-memory.ts      # Cross-project user preferences
skill-store.ts      # Reusable workflow skills
lesson-curator.ts   # Failure → lesson extractor
adr-store.ts        # Architectural Decision Records
```

On-disk structure per project:

```
<project>/.agent/
  project.md
  architecture.md
  conventions.md
  commands.md
  decisions/
    ADR-001-*.md
    ADR-002-*.md
  lessons/
    lesson-001-*.md
  skills-used.md

~/.projectos/
  user-preferences.md
  skills/
    stripe-nextjs.md
    supabase-auth.md
  failed-runs/
  successful-patterns/
```

### `packages/tools`

```
filesystem/
  read.ts
  write.ts
  edit.ts
  glob.ts
  grep.ts

shell/
  bash.ts           # Sandboxed bash execution

git/
  status.ts
  diff.ts
  commit.ts
  push.ts           # Always requires approval

docker/
  run.ts
  compose.ts        # Requires approval

browser/
  playwright.ts

mcp/
  client.ts         # MCP tool bridge

database/
  read-only.ts      # Read-only DB queries only
```

### `packages/policy`

```
permissions.ts      # allow/ask/deny rule engine
approval-cli.ts     # Terminal approval prompt
approval-web.ts     # Web UI approval bridge
secret-redactor.ts  # Strip secrets from all model inputs
sandbox-rules.ts    # Shell sandboxing constraints
```

Permission rule format:

```yaml
deny:
  - pattern: "rm -rf"
  - pattern: "sudo"
  - pattern: "curl | sh"
  - pattern: "git reset --hard"
  - glob: "**/.env*"
  - glob: "**/*.pem"
  - glob: "**/*.key"
  - action: "git:push:main"
  - action: "deploy:production"

ask:
  - action: "package:install"
  - action: "git:push"
  - action: "file:delete"
  - action: "migration:create"
  - action: "docker:compose:up"
  - glob: "**/package.json"

allow:
  - action: "file:read"
  - action: "grep"
  - action: "glob"
  - action: "test:run"
  - action: "git:status"
  - action: "git:diff"
```

### `packages/evals`

```
benchmark-runner.ts    # Run a task against all candidate harnesses
scorers.ts             # Scoring functions
candidate-runner.ts    # Run a single candidate harness
baseline.ts            # Load/save baseline scores
frontier.ts            # Track best-ever scores per task
comparison.ts          # Diff baseline vs candidate
```

Scoring dimensions:

```ts
interface RunScore {
  success: boolean
  buildPassed: boolean
  testsPassed: boolean
  questionsAsked: number
  unnecessaryQuestions: number
  filesModified: number
  regressions: number
  timeToGreen: number    // seconds
  costUsd: number
  secretsLeaked: boolean
  unapprovedDestructive: boolean
}
```

### `packages/telemetry`

```
traces.ts           # OpenTelemetry-style span logging
cost-tracker.ts     # Per-model, per-state cost tracking
run-replay.ts       # Replay a run from JSONL transcript
reporter.ts         # Final delivery report generator
```

Run output structure:

```
.runs/<run-id>/
  transcript.jsonl    # All agent messages
  tool-calls.jsonl    # All tool invocations and results
  diffs/              # Git diffs per state
  test-output.log
  cost.json
  decisions.md
  final-report.md
```

---

## Workspace Layout

Generated projects never live inside the harness repository:

```
~/.projectos/workspace/<project-name>/    # each target project, its own git repo
```

The bash tool is cwd-locked to the active target project. Harness code, memory stores, and run logs are never writable by target-project tooling.

---

## Data Flow

```
User input
  → CLI
    → SessionManager (creates run-id, loads project memory)
      → StateMachine (INTAKE state)
        → AgentLoop
          → RoleRouter (selects agent role)
            → ModelRouter (selects model)
              → PolicyEngine (tool call approval)
                → ToolLayer (executes tool)
                  → SecretRedactor (strips secrets from output)
                    → Telemetry (logs everything)
                      → StateMachine (evaluates exit condition)
                        → next state...
```

---

## Local Web UI

Optional. Provides:
- Live state machine status
- Pending approval queue
- Run cost and token counters
- Question/answer interface
- Run history and replay
- Skill and lesson browser

Communication: local HTTP + Server-Sent Events. No external network required.

---

## Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript | Type safety, ecosystem |
| Runtime | Bun | Fast startup, built-in bundler |
| CLI framework | Commander | Mature, minimal |
| Local DB | SQLite via Bun | Zero-dependency persistence |
| Web UI | Next.js (local) | Familiar stack, no build server needed |
| Job queue | In-process async + SQLite | No Redis dependency for v1 |
| Browser automation | Playwright | Best-in-class, TS-native |
| Sandboxing | Docker (optional) | Isolate shell execution |
| Logging | JSONL files + SQLite | Replayable, no infra needed |

---

## Key Design Decisions

**ADR-000: Build on the Claude Agent SDK, not from scratch**
The execution kernel — agent loop, base tools, session resume, MCP, subagents, permission callbacks (`canUseTool`/hooks) — is the Claude Agent SDK. ProjectOS adds orchestration: the state machine, role/model routing, policy rules, memory, evals, and telemetry. Rationale: PRs 1–5 shrink dramatically; the kernel is battle-tested; all v1 models (Fable/Sonnet/Haiku) are Anthropic models, so multi-provider abstraction is not a v1 requirement. Tradeoff: less control over the inner loop. Revisit only if non-Anthropic models become a hard requirement.

**ADR-001: State machine over naive loop**
A deterministic state machine prevents the agent from cycling without progress. Each state has explicit exit conditions. A state that exceeds its token budget triggers REPAIR before advancing.

**ADR-002: Role-based model routing**
Fable is expensive. It is only used for architect, reviewer, and harness-optimizer analysis. All implementation work runs on Sonnet or cheaper. Memory curation runs on Haiku.

**ADR-003: Approval before any write to shared state**
git push, docker compose up, file delete, package install — all require explicit human approval. The harness is never fully autonomous on irreversible actions.

**ADR-004: Secrets never enter model context**
The secret redactor runs on every tool output before it is passed to any model prompt. Patterns: .env files, *.pem, *.key, AWS_*, API_KEY=*, TOKEN=*, PASSWORD=*.

**ADR-005: No code before blueprint**
The DESIGN state must produce a valid blueprint before the state machine can transition to PLAN or IMPLEMENT. The blueprint is a hard gate.

**ADR-006: Custom agentic loop over /v1/messages instead of Managed Agents**
The original design (ADR-000) relied on `client.beta.sessions` (Managed Agents), an Anthropic-hosted execution kernel. This was superseded when the deployment target switched to a third-party proxy (`ANTHROPIC_BASE_URL`) that exposes `/v1/messages` only. The new `agent-runner.ts` implements a bounded agentic loop: it calls `createMessage`, dispatches any `tool_use` blocks through the permission engine and tool dispatcher, feeds results back as `tool_result` content blocks, and loops until `stop_reason !== "tool_use"` or `maxIterations` is reached. The `createMessage` function is injected — in production it wraps `@anthropic-ai/sdk`, in tests it is a scripted double. Tradeoff: we own the loop (more control, easier testing) at the cost of losing Managed Agents features (server-side file mounts, Skills, MCP auto-wiring). Revisit if first-party Anthropic API access becomes available.