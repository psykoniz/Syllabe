# ProjectOS Agent — Roadmap

## Phase 1 — Foundation (PRs 1–5)

Goal: a working agent loop that can run a simple task end-to-end with mocked agents, basic tools, and a permission layer.

Per ADR-000, these PRs build **on the Claude Agent SDK** — wiring and constraining an existing kernel (sessions, tools, permission callbacks, subagents), not reimplementing one. This is what makes 5 PRs realistic.

| PR | Name | Goal |
|---|---|---|
| PR-01 | CLI + Session Core | `projectos run "task"` works, logs JSONL |
| PR-02 | State Machine | States transition correctly, exit conditions enforced |
| PR-03 | Model Router | Each role maps to correct model, budget enforced |
| PR-04 | Tool Layer | read/write/edit/bash/git/grep/glob functional |
| PR-05 | Permission Layer | allow/ask/deny works, secrets never logged |

**Milestone 1 exit criteria:**
- `projectos run "create a hello world Node app"` completes end-to-end
- All tool calls are logged
- `.env` file cannot be read; `echo $ANTHROPIC_API_KEY` in bash prints nothing
- `git push` requires approval; commits on agent branches flow freely
- Cost is tracked
- The hello-world run is scripted as a CI smoke check (precursor of eval task-00)

---

## Phase 2 — Intelligence (PRs 6–8)

Goal: the agent makes smart decisions, stores them, and remembers them.

| PR | Name | Goal |
|---|---|---|
| PR-06 | Design Interview | Structured questions before blueprinting (interview precedes blueprint in the flow, so it precedes it in the build order) |
| PR-07 | Project Blueprint | No code before blueprint; blueprint consumes interview output |
| PR-08 | Memory Layer | ADRs, lessons, skills persist across runs |

**Milestone 2 exit criteria:**
- Agent asks 5–8 questions before generating blueprint
- Blueprint includes product.md, architecture.md, plan.md
- ADR is written for each major decision
- Lesson is written after any failure
- User preferences persist across runs

---

## Phase 3 — Quality (PRs 9–10)

Goal: the agent reviews its own work and measures performance.

| PR | Name | Goal |
|---|---|---|
| PR-09 | Review Agent | Mandatory reviewer pass before COMPLETE |
| PR-10 | Eval Suite | 6 benchmark tasks (incl. smoke), scoring, baseline tracking |

**Milestone 3 exit criteria:**
- Every run ends with a reviewer verdict
- 6 benchmark tasks run 3× each and produce scores
- Baseline stored; future versions compared against it
- Final delivery report generated for every run

---

## Phase 4 — Self-Improvement (PR 11)

Goal: the harness can analyze its failures and propose improvements to itself.

| PR | Name | Goal |
|---|---|---|
| PR-11 | Self-Improvement Loop | Harness optimizer agent, candidate testing, promotion logic |

**Milestone 4 exit criteria:**
- Failed runs are analyzed by harness-optimizer
- A candidate harness variant is proposed
- Candidate is benchmarked against baseline
- Candidate is promoted only if it improves score without cost regression

---

## Phase 5 — Polish (PRs 12–15)

| PR | Name | Goal |
|---|---|---|
| PR-12 | Local Web UI | Approval queue, live status, run history |
| PR-13 | Docker Sandbox | Shell isolation for untrusted commands |
| PR-14 | Playwright Tools | Browser automation for e2e tests and scraping |
| PR-15 | Run Replay | Full session replay from JSONL transcript |

---

## Not In Scope (v1)

- Multi-user or team features
- Cloud deployment of the harness itself
- Mobile client
- Integration with external project management tools
- Real-time collaboration
- Web-research agent role (deferred; the vision's "Researcher" is post-v1)
- Multi-provider model routing (all v1 models are Anthropic — see ADR-000)
- Complexity-aware dynamic routing (v1 routing is static per role; the "this task doesn't justify Fable" estimator is post-v1, fed by eval data)

These are deferred until Milestone 4 is validated.