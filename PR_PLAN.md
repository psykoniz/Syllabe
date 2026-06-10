# ProjectOS Agent — PR Plan

> Per ADR-000 (see ARCHITECTURE.md), PRs 1–5 build **on top of the Claude Agent SDK** — they wire and constrain an existing execution kernel, they do not reimplement one. Scope estimates assume this.

> Test tiers: **[unit]** = deterministic, runs in CI on every commit. **[eval]** = depends on model behavior, non-deterministic, runs in the eval suite and is scored, not asserted.

---

## PR-01: CLI + Session Core

**Goal:** `projectos run "task"` works, creates a session, logs JSONL.

**Scope:**
- `apps/cli/` — Commander CLI with `run`, `resume`, `report` commands
- `packages/core/session.ts` — wraps an Agent SDK session; adds run-id, metadata, checkpoint table (SQLite)
- `packages/telemetry/traces.ts` — JSONL append logger

**Files created:**
```
apps/cli/index.ts
apps/cli/commands/run.ts
packages/core/session.ts
packages/telemetry/traces.ts
packages/telemetry/cost-tracker.ts
.runs/.gitkeep
```

**Tests:**
- [unit] CLI `run` command creates a `.runs/<id>/` directory
- [unit] `transcript.jsonl` is created and appended to
- [unit] Session metadata (start time, run-id, input) is written correctly
- [unit] `resume` command loads an existing session by ID from its last checkpoint

**Exit criteria:** `projectos run "hello"` produces a `.runs/<id>/transcript.jsonl` with at least one entry.

---

## PR-02: State Machine

**Goal:** States transition correctly; bounded loops enforced; transitions checkpointed.

**Scope:**
- `packages/core/state-machine.ts` — state definitions, transitions, bounded loops
- `packages/core/agent-loop.ts` — drives the machine over SDK sessions
- `packages/core/task-runner.ts` — executes a task within a state

**State definitions:**
```
INTAKE → CLARIFY → DESIGN → PLAN → [per work unit: IMPLEMENT → TEST ⇄ REPAIR → REVIEW] → DOCUMENT → LEARN → COMPLETE
```

PLAN produces an ordered list of work units ("local PRs"). The IMPLEMENT→REVIEW segment runs once **per work unit**, not once per project.

**Loop bounds (hard):**
- TEST ⇄ REPAIR: max 3 repair iterations per work unit, then escalate to user
- REVIEW `mustFix` → IMPLEMENT: max 2 cycles per work unit, then escalate
- Budget overflow applies the state's `overflowPolicy` (`summarize-and-continue` | `escalate` | `abort`) — it never routes to REPAIR and never silently continues

**Tests:**
- [unit] State machine starts at INTAKE
- [unit] Transitions fire on exit condition being met
- [unit] TEST ⇄ REPAIR stops after 3 iterations and emits an escalation event
- [unit] REVIEW rejection loops back to IMPLEMENT at most twice
- [unit] Budget overflow triggers the configured overflowPolicy
- [unit] Every transition writes a checkpoint row (state, work-unit index, context summary)
- [unit] `resume` restarts mid-run from the last checkpoint
- [unit] COMPLETE terminates the loop; full traversal works with mocked agents

**Exit criteria:** With mocked agents, a 2-work-unit plan traverses INTAKE → COMPLETE, including one forced repair loop and one forced review rejection, without errors.

---

## PR-03: Model Router

**Goal:** Each role maps to the correct model; budget enforced per state; sane failure behavior.

**Scope:**
- `packages/router/model-router.ts`
- `packages/router/role-router.ts`
- `packages/router/budget-router.ts`

**Role → Model mapping:**
```
product-strategist → fable
architect          → fable
reviewer           → fable
implementer        → sonnet
test-engineer      → sonnet
memory-curator     → haiku
harness-optimizer  → fable (analysis phase) / sonnet (implementation phase)
```

**Failure policy:**
- implementer / test-engineer / memory-curator: fall back one tier on model error
- architect / reviewer / product-strategist: retry with backoff, then **pause and notify** — never silently downgrade a decision-making role

**Tests:**
- [unit] Each role resolves to correct model ID
- [unit] harness-optimizer routes per phase (fable analysis, sonnet implementation)
- [unit] Budget exceeded for a state triggers the overflow event
- [unit] implementer failure falls back to cheaper tier; architect failure escalates instead
- [unit] Cost is tracked per model per state; `cost.json` written at end of run (price table per model included)

**Exit criteria:** Router correctly routes all 7 roles; a simulated fable outage escalates for architect but falls back for implementer.

---

## PR-04: Tool Layer

**Goal:** Core tools functional, sandboxed, and logged. SDK base tools are reused; this PR adds wrappers and constraints.

**Scope:**
- `packages/tools/filesystem/` — wraps SDK read/write/edit/glob/grep with policy hooks
- `packages/tools/shell/bash.ts` — bash with cwd lock + scrubbed environment
- `packages/tools/git/` — status, diff, commit

**Bash constraints (pre-Docker):**
- CWD locked to the active target project in the workspace
- Environment allowlist: `PATH`, `HOME`, `LANG`, `NODE_ENV` + explicit additions. The harness's own API keys are never present
- 30s default timeout

**Tests:**
- [unit] `read` returns file content; errors on missing file
- [unit] `write` creates file; refuses to overwrite without flag
- [unit] `edit` replaces exact string; errors if string not found or not unique
- [unit] `bash` executes in target project; cannot `cd` out of the workspace
- [unit] `bash` env is scrubbed: `echo $ANTHROPIC_API_KEY` prints empty
- [unit] `git:commit` stages and commits provided files
- [unit] All tool calls are logged to `tool-calls.jsonl`

**Exit criteria:** Agent can create a file, edit it, run a test command, and commit — all logged; env scrub verified.

---

## PR-05: Permission Layer

**Goal:** allow/ask/deny rules enforced via the SDK's permission callback; secrets never read or logged.

**Scope:**
- `packages/policy/permissions.ts` — rule engine plugged into SDK `canUseTool`
- `packages/policy/approval-cli.ts`
- `packages/policy/secret-redactor.ts`

**Key policy decisions (see SECURITY_POLICY.md):**
- `git commit` on agent-created branches: **allowed** (logged), to avoid approval fatigue on the per-work-unit flow
- File writes **inside the active project workspace**: allowed; writes outside it: ask
- `.env*`, `*.pem`, `*.key` reads: denied, no override

**Tests:**
- [unit] Reading `.env` returns permission denied (no approval possible)
- [unit] Reading `*.pem` returns permission denied
- [unit] `git push` triggers approval prompt; denied if user answers no
- [unit] `git commit` on an agent-created branch proceeds without prompt and is logged
- [unit] `rm -rf` pattern blocked at bash level
- [unit] Secret redactor strips `API_KEY=...`, `TOKEN=...`, `PASSWORD=...` from all tool outputs
- [unit] The harness's own API key literal is always redacted wherever it appears
- [unit] Write outside workspace prompts; write inside workspace does not
- [unit] Approved action logged as approved; denied action logged as denied; deny rules cannot be overridden by agent text

**Exit criteria:** `.env` read attempt is blocked; `git push` is intercepted and prompts; commit on agent branch flows freely.

---

## PR-06: Design Interview

**Goal:** Product strategist asks structured questions before any blueprint; questions classified by impact; defaults recommended. (Interview precedes blueprint in the flow — so it precedes it in the build order too.)

**Scope:**
- `packages/agents/product-strategist.ts`
- Interview question schema
- CLARIFY state wired to interview completion
- Answers persisted to `<project>/.agent/interview.md` (plain file write; the memory framework formalizes loading in PR-08)

**Interview question schema:**
```ts
interface InterviewQuestion {
  id: string
  text: string
  impact: "critical" | "important" | "optional"
  default: string
  defaultRationale: string
  options?: string[]
}
```

**Tests:**
- [unit] CLARIFY cannot exit until all critical questions are answered or explicitly defaulted
- [unit] Skipping a question applies the default and logs it
- [unit] Answers are written to `.agent/interview.md`
- [unit] Non-interactive mode (`--yes`) applies all defaults and logs each
- [eval] At least 3 critical questions asked for a vague SaaS brief
- [eval] Each question includes a sensible default recommendation

**Exit criteria:** Running a new project idea produces a structured Q&A session with defaults before any files are created.

---

## PR-07: Project Blueprint

**Goal:** No code before a minimal blueprint; DESIGN is a hard gate fed by the interview output.

**Scope:**
- `packages/agents/architect.ts`
- Blueprint generation prompts (consume `.agent/interview.md`)
- DESIGN state exit condition wired to blueprint validation

**Blueprint files generated:**
```
<project>/.agent/product.md
<project>/.agent/architecture.md
<project>/.agent/implementation-plan.md
<project>/.agent/test-plan.md
```

**Tests:**
- [unit] State machine cannot transition from DESIGN to PLAN without all 4 blueprint files existing and non-empty
- [unit] ADR file is created in `.agent/decisions/ADR-001-*.md` during DESIGN
- [eval] Blueprint content reflects interview answers (spot-checked in eval suite)

**Exit criteria:** Running a task produces 4 blueprint files before any code is written.

---

## PR-08: Memory Layer

**Goal:** ADRs, lessons, and skills persist and load across runs; user preferences remembered; interview answers from prior runs not re-asked.

**Scope:**
- `packages/memory/project-memory.ts`
- `packages/memory/user-memory.ts`
- `packages/memory/skill-store.ts`
- `packages/memory/lesson-curator.ts`
- `packages/memory/adr-store.ts`

**Tests:**
- [unit] ADR written in run 1 is loaded into context in run 2
- [unit] Lesson created in run 1 is loaded in run 2 when trigger matches
- [unit] User preference (e.g., preferred stack) persists across sessions
- [unit] Interview questions already answered in a prior run are not re-asked
- [unit] Memory loaded at session start before any agent call; truncation follows the priority order (prefs > commands > ADRs > lessons > skills)
- [unit] Proposed lessons require approval in interactive mode; `--yes` auto-accepts
- [eval] Memory curator deduplicates near-identical lessons

**Exit criteria:** A decision made in run 1 is automatically referenced in run 2 context without re-asking.

---

## PR-09: Review Agent

**Goal:** Mandatory reviewer pass before COMPLETE; reviewer produces a structured verdict.

**Scope:**
- `packages/agents/reviewer.ts`
- REVIEW state config
- Reviewer verdict schema

**Reviewer verdict schema:**
```ts
interface ReviewVerdict {
  approved: boolean
  risks: Risk[]
  mustFix: string[]
  shouldFix: string[]
  architectureNotes: string
  testCoverageAssessment: string
}
```

**Tests:**
- [unit] State machine cannot transition to DOCUMENT without a verdict object
- [unit] `mustFix` items route back to IMPLEMENT (bounded, per PR-02)
- [unit] `shouldFix` items are logged but do not block
- [unit] Verdict is written to `final-report.md`
- [unit] Reviewer receives diffs from `.runs/<id>/diffs/` as input
- [eval] Reviewer flags a risk when the diff touches auth or billing logic

**Exit criteria:** No run reaches COMPLETE without a reviewer verdict in `transcript.jsonl`.

---

## PR-10: Eval Suite

**Goal:** 6 benchmark tasks (incl. smoke) defined; scoring functional; baseline stored and comparable; cost-capped.

**Scope:**
- `packages/evals/benchmark-runner.ts`
- `packages/evals/scorers.ts`
- `packages/evals/baseline.ts`
- `evals/tasks/` — 6 benchmark task definitions
- `evals/fixtures/` — hermetic fixtures (local Postgres, Stripe test-mode recordings)

**Benchmark tasks (v1):**
```
task-00: Smoke — minimal Node CLI with one passing test (canary, < $0.50)
task-01: Todo app with auth (Next.js + local Postgres fixture)
task-02: Add Stripe subscription (test mode, recorded webhooks) to fixture app
task-03: Fix 3 known bugs in broken fixture repo
task-04: Add Playwright e2e tests to fixture app
task-05: Transform a vague brief into a working MVP landing page
```

**Rules:**
- Each task runs 3× per harness version; compare means and worst case
- Hard cost cap per eval run (default $15) — runner aborts past cap, reports partial scores
- Human-labeled fields (`unnecessaryQuestions`, architecture quality) are recorded as `pending-label` and excluded from automated promotion math

**Tests:**
- [unit] `projectos eval run` executes tasks and writes `evals/results/<date>/scores.json`
- [unit] Baseline stored after first run; `eval compare` produces a diff table
- [unit] Cost cap aborts a runaway run and still writes partial scores
- [unit] A run that leaks secrets scores `secretsLeaked: true` and is marked failed
- [unit] task-00 smoke is runnable standalone (CI canary)

**Exit criteria:** `projectos eval run` produces a score report over 3 repetitions; baseline stored; task-00 wired as CI canary.

---

## PR-11: Self-Improvement Loop

**Goal:** Harness optimizer analyzes failed runs, proposes a candidate change, benchmarks it, promotes only if better.

**Scope:**
- `packages/evals/candidate-runner.ts`
- `packages/evals/frontier.ts`
- `packages/agents/harness-optimizer.ts`
- Candidate config schema

**Candidate scope (v1 — deliberately narrow):**
A candidate may change ONLY:
1. System prompts per role
2. The role → model routing table
3. Per-state budgets and loop bounds

No structural changes (no new states, tools, or permission rules) via self-improvement in v1. This keeps the candidate space well-defined and reviewable.

**Workflow:**
```
1. Collect failed runs from .runs/
2. Harness optimizer (fable) analyzes failure patterns
3. Optimizer proposes ONE targeted change within candidate scope
4. Candidate config created
5. Benchmark: 6 tasks × 3 repetitions on candidate
6. Compare candidate vs baseline (see EVALS_PLAN promotion rules)
7. Promote only if rules pass; promotion logged as ADR in ~/.projectos/harness/
8. Last 3 baselines retained for rollback
```

**Tests:**
- [unit] Optimizer output validates against the candidate config schema (structured, not free-text)
- [unit] Candidate runner executes a config distinct from baseline
- [unit] Promotion blocked when rules fail; applied when they pass (simulated scores)
- [unit] Rollback restores a prior baseline
- [eval] On a seeded failure corpus, optimizer produces a plausible, in-scope proposal

**Exit criteria:** A simulated failure triggers optimizer → candidate → benchmark → promote/reject, end-to-end, with rollback available.