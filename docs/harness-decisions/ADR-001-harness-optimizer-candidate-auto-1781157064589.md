# ADR-001: Promote Harness Candidate auto-1781157064589

**Status:** accepted

## Context

Harness optimizer proposed candidate `auto-1781157064589`. Benchmark results met promotion rules.

## Decision

Promote candidate config as new baseline.

```json
{
  "loopBounds": {
    "maxReview": 3
  }
}
```

## Consequences

Pass rate deltas across tasks:

- task-00-smoke: 1.00 → 1.00 (Δ+0.00)
- task-01-todo-app: 1.00 → 1.00 (Δ+0.00)
- task-02-stripe: 1.00 → 1.00 (Δ+0.00)
- task-03-bug-fix: 0.00 → 1.00 (Δ+1.00)
- task-04-playwright: 1.00 → 1.00 (Δ+0.00)
- task-05-landing-page: 1.00 → 1.00 (Δ+0.00)
