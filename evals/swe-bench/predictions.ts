/**
 * SWE-bench prediction format + patch extraction.
 *
 * The official SWE-bench harness consumes a predictions file where each line is:
 *   { "instance_id": ..., "model_name_or_path": ..., "model_patch": <unified diff> }
 *
 * The harness checks out base_commit, applies model_patch, then applies the
 * gold test_patch (test files win), and runs FAIL_TO_PASS / PASS_TO_PASS.
 * Therefore the model_patch must contain ONLY source changes — test-file
 * changes are stripped so they cannot conflict with the gold test_patch.
 */

export interface Prediction {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}

/** Test-file path patterns whose diff sections are stripped from the model patch. */
export const TEST_FILE_PATTERNS: RegExp[] = [
  /(^|\/)tests?\//,        // tests/ or test/ directory
  /(^|\/)test_[^/]+\.py$/, // test_foo.py
  /[^/]+_test\.py$/,       // foo_test.py
  /\.test\.[jt]sx?$/,      // foo.test.ts / .tsx / .js / .jsx
  /\.spec\.[jt]sx?$/,      // foo.spec.ts
  /(^|\/)conftest\.py$/,   // pytest conftest
];

/** Agent-internal / build-artifact path patterns. These are metadata and run
 *  byproducts (never part of the repo under test) and must never leak into the
 *  model patch — they would dirty the diff and can break `git apply`. */
export const INTERNAL_FILE_PATTERNS: RegExp[] = [
  /(^|\/)\.agent\//,       // ProjectOS planning/state docs
  /(^|\/)\.projectos\//,   // run db, traces, tool-calls
  /(^|\/)bun\.lockb?$/,    // bun lockfile from stray installs
  /(^|\/)node_modules\//,  // dependency installs
  /(^|\/)__pycache__\//,   // python bytecode cache
  /\.pyc$/,                // compiled python
  /\.log$/,                // build_ext.log, pytest.log, etc.
];

/** Split a unified diff into per-file sections, keyed by the b/ (new) path. */
export function splitDiffByFile(diff: string): Array<{ path: string; section: string }> {
  if (!diff.trim()) return [];
  const parts = diff.split(/(?=^diff --git )/m).filter((s) => s.trim());
  return parts.map((section) => {
    const m = /^diff --git a\/(\S+) b\/(\S+)/m.exec(section);
    return { path: m ? m[2] : "", section };
  });
}

/** Remove diff sections that touch test files, so the model patch is
 *  source-only and never conflicts with the gold test_patch. */
export function stripTestChanges(diff: string): string {
  return splitDiffByFile(diff)
    .filter(({ path }) => !TEST_FILE_PATTERNS.some((re) => re.test(path)))
    .map((s) => s.section)
    .join("");
}

/** Remove both test-file sections and agent-internal/build-artifact sections,
 *  leaving only genuine source changes for the official harness. */
export function stripNonSourceChanges(diff: string): string {
  const drop = [...TEST_FILE_PATTERNS, ...INTERNAL_FILE_PATTERNS];
  return splitDiffByFile(diff)
    .filter(({ path }) => path !== "" && !drop.some((re) => re.test(path)))
    .map((s) => s.section)
    .join("");
}

/** Build one prediction line (newline-terminated) in official JSONL format. */
export function toPredictionLine(
  instanceId: string,
  modelName: string,
  patch: string
): string {
  const pred: Prediction = {
    instance_id: instanceId,
    model_name_or_path: modelName,
    model_patch: patch,
  };
  return JSON.stringify(pred) + "\n";
}
