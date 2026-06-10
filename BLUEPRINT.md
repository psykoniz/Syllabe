# ProjectOS Agent — Product Blueprint

## Vision

ProjectOS is a local-first TypeScript agent harness that transforms a vague idea into a tested, documented, deployable project. It orchestrates multiple specialized sub-agents across a deterministic state machine, routes tasks to the right model tier, maintains persistent memory across runs, and continuously measures and improves its own behavior through an eval framework.

The goal is not a generic coding assistant. The goal is a personal product-building OS that knows when to ask, when to decide, when to build, and when to stop.

---

## Core Principles

- Never ask unless the answer changes the product, architecture, cost, or risk significantly.
- Never code before producing a minimal blueprint.
- Every major architectural decision becomes an ADR.
- Every repeated failure becomes a lesson.
- Every reusable successful workflow becomes a skill.
- Dangerous actions always require explicit human approval.
- Secrets are never read, logged, or sent to any model.
- Every run produces a full audit trail: logs, diffs, costs, traces, test results, final report.

---

## User Experience

### Starting a project

```bash
projectos new "I want to build a SaaS for commercial proposals"
projectos new --mode founder "..."
projectos new --mode engineer "..."
```

### Resuming a run

```bash
projectos resume <run-id>
```

### Reviewing a run

```bash
projectos report <run-id>
projectos replay <run-id>
```

### Improving the harness

```bash
projectos eval run
projectos eval compare baseline candidate-a
projectos eval promote candidate-a
```

---

## Agent State Machine

```
INTAKE → CLARIFY → DESIGN → PLAN → IMPLEMENT → TEST → REPAIR → REVIEW → DOCUMENT → LEARN → COMPLETE
```

Each state has:
- A responsible agent role
- A recommended model tier
- An allowed tool set
- A token/cost budget
- Exit criteria
- Abort conditions

Transitions are explicit and every transition is logged. All loops are **bounded**: TEST ⇄ REPAIR retries at most 3 times per work unit; a REVIEW rejection returns to IMPLEMENT at most twice; past those bounds the harness escalates to the user instead of spinning. IMPLEMENT → TEST → REPAIR → REVIEW runs once per **work unit** ("local PR" produced by PLAN), not once per project.

---

## Agent Roles

| Role | Model Tier | Responsibility |
|---|---|---|
| product-strategist | Fable | Intake, scope definition, interview |
| architect | Fable | Architecture decisions, ADRs, PR planning |
| implementer | Sonnet | Code, file edits, git |
| test-engineer | Sonnet | Unit tests, e2e, fixtures |
| reviewer | Fable | Diff review, risk detection, architecture validation |
| memory-curator | Haiku | Lesson extraction, skill creation, memory dedup |
| harness-optimizer | Fable (analysis) + Sonnet (impl) | Failure analysis, candidate proposal, benchmark |

---

## Design Interview Engine

Before any blueprint is generated, the product-strategist agent runs a structured interview.

Questions are classified by impact:
- **Critical**: changes product scope or architecture
- **Important**: changes stack or major tradeoffs
- **Optional**: style, defaults, preferences

Each question includes a default recommendation with rationale. The interview output feeds directly into the blueprint generator.

---

## Milestone 1 — Minimum Viable Harness

A single end-to-end run that:
1. Accepts a SaaS idea as input.
2. Runs a 5–8 question design interview.
3. Produces a minimal blueprint (product.md, architecture.md, plan.md).
4. Creates a Next.js repo with auth and a simple data model.
5. Runs tests.
6. Produces a final report with cost, decisions, test results.

This is the benchmark. Everything else is measured against it.

---

## Success Criteria

- `success_rate` on 10 benchmark tasks > 70%
- `unnecessary_questions` per run < 2
- `build_pass_rate` > 90%
- `test_pass_rate` > 80%
- `cost_per_success` tracked and improving over harness versions
- No secrets ever appear in logs or model prompts
- No destructive action executes without approval