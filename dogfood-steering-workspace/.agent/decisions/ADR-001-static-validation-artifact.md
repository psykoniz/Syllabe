# ADR-001: Use a Static Validation Artifact

## Status
Accepted

## Context
The task requires creating a single file named `critic_test.txt` containing exactly `critic validated`.

## Decision
Represent the deliverable as a static text file in the workspace root.

## Consequences
- The solution is minimal and directly matches the task scope.
- No application code, database, authentication, or deployment architecture is introduced.
- Verification can be performed with a simple exact content check.
