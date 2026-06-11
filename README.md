# ProjectOS Agent

An autonomous software-building OS powered by Claude. Give it a task; it interviews you, designs a blueprint, implements work unit by work unit, tests, reviews, documents, and learns — all in a deterministic state machine.

## Quick start

```bash
bun install
bun run apps/cli/index.ts build --task "Build a REST API with CRUD endpoints for a todo list" --yes
```

Add `--model-override claude-sonnet-4-6` if the default model is unavailable.

## Multiply utility

This workspace includes a small TypeScript `multiply(a: number, b: number): number` utility in `packages/multiply/index.ts`. It was built as a focused example of a typed arithmetic helper with a `bun:test` unit test in `packages/multiply/multiply.test.ts`, making it easy to verify expected behavior in the existing Bun workspace.

Run the project CLI with Bun:

```bash
bun run apps/cli/index.ts build --task "Build a REST API with CRUD endpoints for a todo list" --yes
```

Run the test suite with Bun:

```bash
bun test
```

## CLI commands

| Command | Description |
|---------|-------------|
| `projectos build --task "..."` | Run the full state machine for a task |
| `projectos run --prompt "..."` | Start a single-agent session |
| `projectos resume --run-id <id>` | Resume a prior session |
| `projectos report` | Show cost and status for all runs |
| `projectos eval run` | Execute the eval benchmark suite |
| `projectos eval compare` | Compare latest results against baseline |
| `projectos self-improve` | Analyze failures, propose + benchmark a candidate config |

## Key options for `build`

```
--task <text>          Task description (required)
--workspace <path>     Target directory (default: cwd)
--yes                  Apply all interview defaults (non-interactive)
--model-override <id>  Force all role calls to a specific model
--max-iterations <n>   Max agent iterations per state (default: 20)
--db <path>            SQLite run database (default: .projectos/runs.db)
--traces <path>        JSONL trace log (default: .projectos/traces.jsonl)
```

## State machine

```
INTAKE → CLARIFY → DESIGN → PLAN
                              ↓
                    ┌── IMPLEMENT ──┐
                    │      ↓        │
                    │     TEST      │ (per work unit)
                    │    ↙    ↘    │
                    │ REPAIR  REVIEW│
                    └──────────────┘
                              ↓
                         DOCUMENT → LEARN → COMPLETE
```

- **PLAN**: architect refines work units from the implementation plan, writes `.agent/work-units.json`
- **IMPLEMENT → TEST → REPAIR**: up to 3 repair cycles per work unit
- **REVIEW**: structured verdict (APPROVE / MUST_FIX); up to 2 review cycles per work unit

## Role → model mapping

| Role | Default model |
|------|--------------|
| product-strategist, architect, reviewer | claude-fable-5 |
| implementer, test-engineer | claude-sonnet-4-6 |
| memory-curator | claude-haiku-4-5 |

Override all roles with `--model-override <model-id>`.

## Running tests

```bash
bun test          # all 290+ unit tests
bun test --bail   # stop on first failure
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_AUTH_TOKEN` | Preferred credential |
| `ANTHROPIC_API_KEY` | Standard Anthropic API key |
| `ANTHROPIC_BASE_URL` | Override API endpoint (e.g. a proxy) |

See [SECURITY_POLICY.md](./SECURITY_POLICY.md) for the full security model.
