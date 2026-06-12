# SWE-bench Lite — ProjectOS

Two-phase evaluation, matching the official leaderboard methodology:

1. **Solve** (this repo): ProjectOS clones each repo at `base_commit`, reads the
   issue, and produces a source patch. Output: a predictions JSONL.
2. **Score** (official harness): the SWE-bench Docker harness applies each patch
   plus the gold test patch in a per-version container and runs
   `FAIL_TO_PASS` / `PASS_TO_PASS`. Its resolved rate is the official score.

Scoring is delegated on purpose — faithful results require the exact per-repo
Python environments the official harness builds. We never score in-process.

## Solve phase

```bash
# 5-instance smoke test
bun evals/swe-bench/run.ts --limit 5 --model-override gpt-5.5 --cost-cap 20

# single repo subset
bun evals/swe-bench/run.ts --repo astropy/astropy --limit 10

# one instance (debugging)
bun evals/swe-bench/run.ts --instance-id astropy__astropy-12907

# with the auto-steering critic
bun evals/swe-bench/run.ts --limit 20 --auto-steering
```

Writes `evals/results/swe-bench/predictions-<ts>.jsonl` and a `summary-<ts>.json`.

Notes:
- The `test_patch` is **not** applied during solving — the agent only sees the
  problem statement, so there is no eval leakage.
- The model patch is **source-only**: test-file changes are stripped
  (`predictions.ts`) so they can't conflict with the gold test patch.
- An empty patch is still emitted; the harness scores it as unresolved.

## Score phase (official)

Requires Docker running and `pip install swebench`.

```bash
bash evals/swe-bench/run-official-eval.sh evals/results/swe-bench/predictions-<ts>.jsonl
```

The resolved rate it prints is the SWE-bench Lite score.

## Files

- `loader.ts` — fetch + cache the 300 Lite instances from HuggingFace
- `predictions.ts` — patch extraction + official JSONL format (unit-tested)
- `runner.ts` — solve loop, patch extraction, predictions writer
- `run.ts` — CLI entry
- `run-official-eval.sh` — wrapper around the official Docker harness
