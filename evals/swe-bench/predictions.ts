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
