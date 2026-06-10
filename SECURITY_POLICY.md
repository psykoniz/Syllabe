# ProjectOS Agent — Security Policy

## Core Guarantee

Secrets never enter model context. Dangerous actions never execute without human approval. These are not preferences — they are hard architectural constraints enforced at the tool layer, not the prompt layer.

---

## Secret Redaction

The `SecretRedactor` runs on **every tool output** before it is passed to any model prompt. It also runs on **every model input** as a final check.

### Patterns redacted (not exhaustive — defense-in-depth)

```
**/.env
**/.env.*
**/.env.local
**/.env.production
**/secrets/**
**/credentials/**
**/*.pem
**/*.key
**/*.p12
**/*.pfx
**/*.crt (private)

Inline patterns (regex):
  API_KEY\s*=\s*\S+
  API_SECRET\s*=\s*\S+
  TOKEN\s*=\s*\S+
  PASSWORD\s*=\s*\S+
  SECRET\s*=\s*\S+
  PRIVATE_KEY\s*=\s*\S+
  AWS_SECRET_ACCESS_KEY\s*=\s*\S+
  DATABASE_URL\s*=.*@.*
  SUPABASE_SERVICE_ROLE_KEY\s*=\s*\S+
  STRIPE_SECRET_KEY\s*=\s*\S+
```

Redacted values are replaced with `[REDACTED:<pattern-name>]`.

If a secret is detected in a model prompt or tool call input, the run is **immediately aborted** and the event is logged as a critical security incident.

### Environment Variable Scrubbing

File-read denial is not enough: `echo $DATABASE_URL` or `env` in bash would bypass it entirely. Therefore the `bash` tool runs with an **allowlisted environment** (`PATH`, `HOME`, `LANG`, `NODE_ENV`, plus explicit additions). Everything else — including the harness's own API keys — is stripped before the shell starts. `env`, `printenv`, or `echo $STRIPE_SECRET_KEY` cannot leak secrets regardless of file rules.

### Harness Credentials

The harness's own `ANTHROPIC_API_KEY` is stored outside the workspace (`~/.projectos/credentials`, mode 0600, or the OS keychain). It is read only by the model client, never exported into tool environments, never logged, and its literal value is registered with the redactor as an always-redact string.

---

## Permission Rules

### DENY (cannot be overridden by any agent or user prompt)

| Action | Why |
|---|---|
| `rm -rf` in bash | Irreversible data destruction |
| `sudo` in bash | Privilege escalation |
| `curl \| sh` or `wget \| bash` | Remote code execution |
| `git reset --hard` | Irreversible history rewrite |
| Read `**/.env*` | Secrets |
| Read `**/*.pem`, `**/*.key` | Secrets |
| `git push --force` | Irreversible upstream damage |
| `git push` to `main` or `master` | Requires PR process |
| Deploy to production | Requires explicit out-of-band approval |
| `DROP TABLE`, `DELETE FROM` without WHERE | Irreversible data loss |
| Any network request to external services from tool layer | Except explicitly allowlisted |

Deny rules are evaluated before any tool execution. They cannot be bypassed by agent instructions.

### ASK (requires explicit human approval before execution)

| Action | Why |
|---|---|
| `git push` (non-main) | Visible to others |
| `git commit` on a pre-existing user branch | User's history |
| `npm install`, `pnpm add`, `bun add` | Supply chain risk |
| Modify `package.json` | Dependency changes |
| Create or run database migration | Schema change |
| `docker compose up` | External process |
| Delete any file | Potentially irreversible |
| Modify auth logic | Security-critical |
| Modify billing logic | Business-critical |
| Modify CI/CD config | Affects all runs |
| Any file write **outside the active project workspace** | Could be wrong target |

Note on approval fatigue: the per-work-unit flow commits frequently. Requiring approval for every commit would generate 10+ prompts per run and train the user to approve blindly — worse than the risk it mitigates. Hence: commits on agent-created branches are auto-allowed (and logged); pushes always ask.

Approval prompts include:
- The exact command or action
- The file path or target
- The current state and agent role
- A one-line rationale from the agent

### ALLOW (no prompt needed)

| Action |
|---|
| Read any non-secret file |
| `grep`, `glob` |
| Run test suite |
| `git status`, `git diff` |
| `git commit` on an agent-created branch (always logged) |
| Edit non-sensitive source files (already opened this session) |
| File writes inside the active project workspace |
| Write to `.runs/`, `.agent/` directories |
| Read `package.json`, `tsconfig.json`, `README.md` |

---

## Audit Trail

Every tool call produces a log entry in `tool-calls.jsonl`:

```json
{
  "ts": "2026-06-10T14:23:01Z",
  "runId": "run-abc123",
  "state": "IMPLEMENT",
  "agent": "implementer",
  "tool": "bash",
  "input": "pnpm test",
  "permitted": true,
  "approvalRequired": false,
  "approvedBy": null,
  "secretsDetected": false,
  "durationMs": 3421
}
```

Security-relevant events (deny triggered, secret detected, approval requested) are also written to a separate `security-events.jsonl`.

---

## Sandbox

For untrusted shell execution (PR-13+):

- All `bash` tool calls run inside a Docker container with:
  - No network access
  - Read-only mount of project source
  - Write access only to a temp output directory
  - CPU and memory limits
  - 30-second timeout by default

Until Docker sandbox is implemented (PR-13), `bash` is sandboxed by:
- CWD locked to project root
- PATH restricted to a known-safe set
- Environment allowlist (no secrets present — see Environment Variable Scrubbing)
- No `sudo`, no `su`, no setuid binaries

**Known limitation until PR-13:** network-capable commands (`curl`, `wget`, `node -e "fetch(...)"``) are blocked only by pattern matching, which is best-effort and bypassable. The Docker sandbox (no-network by default) is what makes the network-deny rule actually enforceable. Until then, treat the network rule as a tripwire, not a wall.

---

## Model Input Policy

Before any string is sent to a model API:
1. SecretRedactor scans the full prompt
2. If any secret pattern is detected, the run aborts with a security incident log
3. No retry, no fallback — hard stop

This applies to system prompts, user turns, tool results, and assistant messages.

---

## Incident Response

If `secretsLeaked: true` is detected in a run:
1. Run is marked as failed
2. `security-events.jsonl` entry is written
3. User is notified immediately
4. Run transcript is flagged for manual review
5. The model provider is NOT notified automatically (user decides)