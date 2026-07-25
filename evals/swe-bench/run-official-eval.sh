#!/usr/bin/env bash
#
# Score a ProjectOS predictions file with the OFFICIAL SWE-bench Docker harness.
#
# Prerequisites:
#   - Docker running (the harness builds a per-instance image with the correct
#     Python environment — this is what makes the score faithful)
#   - pip install swebench
#
# Usage:
#   bash evals/swe-bench/run-official-eval.sh <predictions.jsonl> [run_id]
#
# Env:
#   MAX_WORKERS  parallel Docker workers (default 4)
#   DATASET      dataset name (default princeton-nlp/SWE-bench_Lite)
#
# The harness writes <run_id>.<model>.json with resolved/unresolved per instance
# and a final resolved rate — that number is the SWE-bench Lite score.

set -euo pipefail

PRED="${1:?usage: run-official-eval.sh <predictions.jsonl> [run_id]}"
RUN_ID="${2:-projectos-$(date +%Y%m%d-%H%M%S)}"
MAX_WORKERS="${MAX_WORKERS:-4}"
DATASET="${DATASET:-princeton-nlp/SWE-bench_Lite}"

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker not found — the official harness requires Docker." >&2
  exit 1
fi

if ! python -c "import swebench" >/dev/null 2>&1; then
  echo "error: swebench not installed. Run: pip install swebench" >&2
  exit 1
fi

echo "Scoring ${PRED} against ${DATASET} (run_id=${RUN_ID}, workers=${MAX_WORKERS})"

python -m swebench.harness.run_evaluation \
  --dataset_name "${DATASET}" \
  --predictions_path "${PRED}" \
  --max_workers "${MAX_WORKERS}" \
  --run_id "${RUN_ID}"

echo
echo "Done. The resolved rate above is the SWE-bench Lite score."
echo "Detailed report: ${RUN_ID}.*.json"
