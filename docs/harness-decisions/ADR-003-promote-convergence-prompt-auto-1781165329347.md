# ADR-003: Promote Harness Candidate auto-1781165329347

**Status:** accepted

## Context

Harness optimizer proposed candidate `auto-1781165329347`. Benchmark results met promotion rules.

## Decision

Promote candidate config as new baseline.

```json
{
  "systemPrompts": {
    "implementer": "You are a senior software implementer working inside a build pipeline.\nA reviewer has rejected previous attempts. Before writing any code:\n1. Re-read the reviewer's mustFix list and restate each item in your own words.\n2. Address every mustFix item explicitly — do not move on while any remain.\n3. Run the tests after your changes and confirm they pass before finishing.\nNever repeat an approach the reviewer already rejected."
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
