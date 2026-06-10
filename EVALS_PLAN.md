# ProjectOS Agent — Evals Plan

## Purpose

Without evals, harness improvements are guesses. With evals, they are measurements.

The eval system answers: "Is the new harness version better than the old one, and by how much, at what cost?"

---

## Eval Architecture

```
evals/
  tasks/
    task-00-smoke-node-cli.yaml
    task-01-todo-app.yaml
    task-02-stripe-integration.yaml
    task-03-bug-fixing.yaml
    task-04-playwright-tests.yaml
    task-05-mvp-brief.yaml
  fixtures/
    broken-repo-for-task-03/
  results/
    <date>-<run-id>/
      scores.json
      per-task/
  baseline.json
  frontier.json
```

---

## Benchmark Tasks (v1 — 6 tasks)

### task-00: Smoke — Minimal Node CLI

**Input:** "Create a minimal Node.js CLI that prints a greeting and has one passing test."

**Purpose:** cheap canary (< $0.50, < 5 min). Runs on every harness change, including in CI, from Milestone 1 onward. Any failure here blocks all other evals.

**Scoring checklist:**
- [ ] Repo created in workspace
- [ ] Test exists and passes
- [ ] Blueprint produced before code
- [ ] Zero approval prompts needed (nothing dangerous in scope)

---

### task-01: Todo App with Auth

**Input:** "Create a full-stack todo app with user authentication."

**Stack:** Next.js + local Postgres fixture (hermetic — no hosted Supabase in evals)

**Scoring checklist:**
- [ ] Repo created
- [ ] `pnpm install` succeeds
- [ ] `pnpm build` succeeds
- [ ] Auth works (sign up, sign in, sign out) — checked via Playwright
- [ ] Todo CRUD works for authenticated user
- [ ] Tests exist and pass
- [ ] Blueprint was generated before code
- [ ] No secrets in logs

**Human review required for:**
- `unnecessaryQuestions` count
- Architecture quality (spot check)

---

### task-02: Stripe Subscription Integration

**Input:** "Add a monthly subscription plan to an existing Next.js app."

**Fixture:** Minimal Next.js app with Supabase auth (provided as fixture)

**Scoring checklist:**
- [ ] Stripe package installed
- [ ] Checkout session created correctly
- [ ] Webhook endpoint exists
- [ ] Webhook signature verified
- [ ] `customerId` stored in User model
- [ ] Subscription gating middleware exists
- [ ] Tests for webhook handler exist
- [ ] No Stripe secret key in logs

---

### task-03: Bug Fixing

**Input:** "Fix all failing tests in this repository."

**Fixture:** Repo with 3 known bugs (provided as fixture, bugs documented in fixture README)

**Scoring checklist:**
- [ ] All 3 bugs fixed
- [ ] All previously passing tests still pass (no regressions)
- [ ] No new dependencies added
- [ ] Fix is minimal (no unnecessary refactoring)

---

### task-04: Playwright E2E Tests

**Input:** "Add Playwright end-to-end tests for the login and dashboard flows."

**Fixture:** Minimal Next.js app with working login and dashboard

**Scoring checklist:**
- [ ] Playwright installed
- [ ] Login flow test exists and passes
- [ ] Dashboard flow test exists and passes
- [ ] Tests run in CI (config updated)
- [ ] No hardcoded credentials in test files

---

### task-05: MVP from Vague Brief

**Input:** "I want to build something for freelancers to send better invoices."

**No fixture.** Agent must clarify, design, and build.

**Scoring checklist:**
- [ ] Agent asked at least 3 clarifying questions
- [ ] Blueprint produced before code
- [ ] MVP is runnable
- [ ] Core happy path works
- [ ] A README with setup instructions exists

**Note:** This task has the highest variance. Human review required for quality assessment.

---

## Scoring Dimensions

```ts
interface RunScore {
  // Objective
  success: boolean                    // Did the run reach COMPLETE?
  buildPassed: boolean                // Did the build succeed?
  testsPassed: boolean                // Did tests pass?
  regressions: number                 // Tests that passed before, fail after
  filesModified: number               // Proxy for scope creep
  timeToGreenSeconds: number          // Wall clock time
  costUsd: number                     // Total API cost

  // Security
  secretsLeaked: boolean              // Any secret in logs or model prompts
  unapprovedDestructive: boolean      // Any destructive action without approval

  // Process quality (some require human review)
  questionsAsked: number              // Total questions during run
  unnecessaryQuestions: number        // Human-labeled: questions that added no value
  blueprintProduced: boolean          // Was a blueprint written before code?
  adrWritten: boolean                 // Was at least one ADR written?
  reviewerPassed: boolean             // Did the reviewer approve?
}
```

Human-labeled fields (`unnecessaryQuestions`, architecture quality) are recorded as `pending-label` and **excluded from automated promotion math**. They inform manual review only.

---

## Harness Comparison

### Running a comparison

```bash
projectos eval run --save-as candidate-a
projectos eval compare baseline candidate-a
```

### Output format

```
Dimension              Baseline    Candidate-A   Delta
──────────────────────────────────────────────────────
success_rate           60%         68%           +8%   ✓
build_pass_rate        80%         85%           +5%   ✓
test_pass_rate         70%         72%           +2%   ✓
avg_cost_usd           $0.82       $1.10         +34%  ⚠
avg_questions_asked    6.2         4.1           -2.1  ✓
unnecessary_questions  1.4         0.8           -0.6  ✓
regressions            0.4         0.2           -0.2  ✓
time_to_green          142s        138s          -4s   ✓

Verdict: CANDIDATE-A IMPROVES SUCCESS BUT COSTS 34% MORE
Recommendation: promote only for tasks with complexity > medium
```

### Repetitions

Every task runs **3×** per harness version (6 tasks × 3 = 18 task-runs). Compare means and worst case. With only 6 tasks, a single run per task makes a "5 percentage point" rule meaningless (1 task = ~17pp) — single-run deltas are noise, not signal.

### Promotion rules

A candidate is promoted to baseline if, over the full 18 task-runs:
1. The candidate succeeds on **at least 2 more task-runs** than baseline, AND
2. `secretsLeaked` is false on every run, AND
3. `unapprovedDestructive` is false on every run, AND
4. Mean cost increase is ≤ 20% (otherwise: promote only as routing for high-complexity tasks)

Promotion creates an ADR in `~/.projectos/harness/decisions/`. The last 3 baselines are retained for rollback.

---

## Hermeticity & Cost Caps

- Eval fixtures must run **offline**: local Postgres container instead of hosted Supabase; Stripe in test mode with recorded webhook payloads; no live third-party calls. Flaky external services would corrupt every comparison.
- Package installs use a warm local cache where possible.
- **Hard cost cap per eval run** (default $15). The runner aborts past the cap and reports partial scores — a runaway candidate must not burn the budget.

---

## Frontier Tracking

The frontier stores the best-ever score per task per dimension:

```json
{
  "task-01": {
    "best_success_rate": 1.0,
    "best_cost_usd": 0.54,
    "best_time_to_green": 98,
    "achieved_by": "harness-v3-2026-09-01"
  }
}
```

The frontier never regresses. A new run that beats a frontier record updates it.

---

## Eval Roadmap

| Phase | Tasks | Notes |
|---|---|---|
| v1 (PR-10) | 6 tasks | Manual fixture setup |
| v2 | 10 tasks | Add harder tasks: multi-service, monorepo, migration |
| v3 | 20 tasks | Add adversarial tasks: broken requirements, ambiguous briefs |
| v4 | 20+ tasks | Automated fixture generation, CI integration |