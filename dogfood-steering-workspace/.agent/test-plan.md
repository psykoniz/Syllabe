# Test Plan

## Strategy
Use a direct file content check to confirm the deliverable matches the task brief exactly.

## Acceptance Criteria
- `critic_test.txt` exists at the workspace root.
- Its full content is exactly `critic validated` with no additional text.

## Verification Command
`test "$(cat critic_test.txt)" = "critic validated"`
