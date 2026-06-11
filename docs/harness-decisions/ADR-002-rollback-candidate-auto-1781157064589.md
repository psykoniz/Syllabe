# ADR-002: Rollback of Candidate auto-1781157064589 (maxReview 2→3)

**Status:** accepted (supersedes ADR-001)

## Context

ADR-001 promoted `loopBounds.maxReview: 3` after its candidate benchmark showed
task-03-bug-fix going 0% → 100%. A wiring audit then revealed the candidate
config was **never applied during its own benchmark** — the eval harness ran
with default bounds (maxReview: 2). The observed pass was non-determinism.

## Re-validation

task-03 re-run with `maxReview: 3` actually applied (PROJECTOS_LOOP_BOUNDS wired):

```
passed: false
state=ESCALATED steps=16 escalation=max review cycles (3) exceeded
costUsd: $0.50
```

The extra review cycle does not fix the failure mode — the reviewer keeps
rejecting and the implementer does not converge. The root cause is
prompt/behaviour, not loop bounds.

## Decision

- Baseline rolled back to v1 (83% pass rate).
- The loopBounds wiring fix (ProjectRunConfig.loopBounds → makeContext,
  PROJECTOS_LOOP_BOUNDS in the eval harness) is kept — future candidate
  benchmarks are now sound.

## Consequences

- Next candidate should target the REVIEW/REPAIR convergence behaviour
  (system prompt scope), not loop bounds.
- Promotion rules worked as designed once the benchmark was un-confounded.
