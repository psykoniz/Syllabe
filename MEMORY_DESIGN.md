# ProjectOS Agent — Memory Design

## Purpose

Memory makes the agent useful across runs. Without memory, every run starts cold. With memory, the agent:
- Never re-asks a question it already knows the answer to
- Applies lessons from past failures automatically
- Reuses proven workflows as skills
- Respects user preferences without being told again

---

## Memory Layers

### Layer 1: Project Memory (per project)

Stored in `<project-root>/.agent/`

```
.agent/
  project.md              # Product vision, target users, key constraints
  architecture.md         # Current architecture decisions
  conventions.md          # Code style, naming, file structure rules
  commands.md             # How to run, test, build, deploy
  decisions/
    ADR-001-*.md
    ADR-002-*.md
  lessons/
    lesson-001-*.md
  skills-used.md          # Which skills were applied in this project
```

Loaded at session start. All agents receive project memory in their context window.

### Layer 2: User Memory (cross-project)

Stored in `~/.projectos/`

```
~/.projectos/
  user-preferences.md     # Preferred stack, tools, style, naming
  skills/
    stripe-nextjs.md
    supabase-auth.md
    ...
  failed-runs/
    <run-id>-summary.md   # Failure mode + root cause
  successful-patterns/
    <pattern-name>.md
  harness/
    decisions/            # Harness evolution ADRs
    baseline.json
    frontier.json
```

### Layer 3: Run Memory (ephemeral)

Stored in `.runs/<run-id>/`

Not loaded in future runs. Used for debugging and replay only.

---

## ADR Schema

```md
# ADR-<number>: <title>

Date: YYYY-MM-DD
State: ACCEPTED | SUPERSEDED | DEPRECATED
Supersedes: ADR-<number> (if applicable)

## Decision

[What was decided in one sentence.]

## Context

[Why this decision was needed. What tradeoffs existed.]

## Rationale

[Why this option over alternatives. Key factors.]

## Consequences

[What becomes easier. What becomes harder. What is now locked in.]

## Risks

[What could go wrong. How reversible is this.]

## Reversible

Yes / Partially / No — [migration path if yes/partially]
```

ADRs are written by the architect agent during DESIGN state. They are updated (not deleted) when superseded.

---

## Lesson Schema

```md
# Lesson-<number>: <title>

Date: YYYY-MM-DD
Severity: HIGH | MEDIUM | LOW
Status: PROPOSED | ACTIVE | RETIRED
Trigger: [What action or condition causes this issue]

## Symptom

[What the agent or user observed.]

## Root Cause

[Why it happened.]

## Fix

[Exact corrective action.]

## Apply When

[Condition under which this lesson should be applied proactively.]

## Do Not Apply When

[Condition under which this lesson is irrelevant or harmful to apply.]
```

Lessons are written by the memory-curator agent during LEARN state, after any failure or near-failure.

**Lifecycle:** new lessons start as `PROPOSED`. In interactive mode the user approves them (one-line prompt at end of run); `--yes` auto-accepts. A lesson whose advice is contradicted by outcomes twice is `RETIRED` — a bad lesson learned from a misdiagnosed failure must not be injected forever.

**Dedup (v1):** the curator (Haiku) compares each proposed lesson's title + trigger against existing lessons and drops near-duplicates. No embedding index dependency in v1.

---

## Skill Schema

```md
# Skill: <name>

Version: <semver>
Last updated: YYYY-MM-DD
Applies to: [stack, framework, pattern]

## Trigger

[When to use this skill. Be specific.]

## Prerequisites

[What must be true in the project before applying this skill.]

## Steps

1. [Step 1]
2. [Step 2]
...

## Verification

[How to confirm the skill was applied correctly.]

## Common Failures

- [Failure mode 1]: [Fix]
- [Failure mode 2]: [Fix]

## Do Not Use When

[Conditions where this skill would cause problems.]
```

Skills are created by the memory-curator when a task succeeds and the workflow is judged reusable. Skills are versioned — a new version supersedes the old one.

---

## User Preferences Schema

```md
# User Preferences

Last updated: YYYY-MM-DD

## Stack defaults
- Frontend: Next.js
- UI: Tailwind + shadcn/ui
- Database: Supabase (Postgres)
- Auth: Supabase Auth
- Payments: Stripe
- Tests: Vitest + Playwright
- Deploy: Vercel

## Style preferences
- Language: TypeScript (strict)
- Import style: named imports
- File naming: kebab-case
- Component naming: PascalCase

## Process preferences
- PR size: small (< 400 lines diff)
- Test coverage: required before REVIEW
- Comments: minimal, only non-obvious WHY
- Documentation: required for public APIs

## Modes
- Default mode: founder
- When specifically asked for quality: engineer

## Do not suggest
- GraphQL
- tRPC (unless user asks)
- Class-based components
- Redux
```

User preferences are loaded at session start and injected into the product-strategist and architect context.

---

## Memory Loading Strategy

At session start:

1. Load `~/.projectos/user-preferences.md` → injected into all agent system prompts
2. Detect project root (git root or cwd)
3. Load `.agent/project.md`, `.agent/architecture.md`, `.agent/conventions.md`, `.agent/commands.md` → project context
4. Load last 5 ADRs → recent decisions context
5. Load last 10 ACTIVE lessons relevant to current task (keyword + curator-model match over titles/triggers — no embedding index in v1) → proactive lesson injection
6. Load skills matching current task type → available skills context

Total memory budget per agent call: configurable, default 8k tokens.

If loaded content exceeds the budget, truncation follows a strict priority (keep first): user preferences > commands > recent ADRs > lessons > skills. The tail is dropped, never the head.

---

## Memory Curator Behavior

The memory-curator agent runs during LEARN state after every run.

It analyzes:
- All tool calls in `tool-calls.jsonl`
- Test output from `test-output.log`
- Reviewer verdict
- Any REPAIR state entries

It produces:
- 0–3 new lessons (only if genuinely new)
- 0–1 new skill (only if the workflow is reusable and not already covered)
- Updates to `skills-used.md`

It does NOT produce:
- Duplicate lessons (curator-model comparison against existing titles/triggers)
- Skills for one-off tasks
- Lessons for expected behavior

---

## Memory Limits

| Store | Max entries | Pruning strategy |
|---|---|---|
| ADRs (per project) | Unlimited | None — never delete |
| Lessons (per project) | 50 | Prune by age + low severity |
| Lessons (global) | 200 | Prune by age + low severity |
| Skills (global) | 100 | Supersede old versions |
| User preferences | 1 file | Always overwrite |
| Failed runs | 30 | FIFO |
| Successful patterns | 50 | Prune by age |