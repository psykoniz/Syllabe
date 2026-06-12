import { describe, expect, it } from "bun:test";
import {
  splitDiffByFile,
  stripTestChanges,
  toPredictionLine,
  TEST_FILE_PATTERNS,
} from "./predictions";

const SRC_SECTION = `diff --git a/astropy/modeling/separable.py b/astropy/modeling/separable.py
--- a/astropy/modeling/separable.py
+++ b/astropy/modeling/separable.py
@@ -242,7 +242,7 @@ def _cstack(left, right):
-        cright[-right.shape[0]:, -right.shape[1]:] = 1
+        cright[-right.shape[0]:, -right.shape[1]:] = right
`;

const TEST_SECTION = `diff --git a/astropy/modeling/tests/test_separable.py b/astropy/modeling/tests/test_separable.py
--- a/astropy/modeling/tests/test_separable.py
+++ b/astropy/modeling/tests/test_separable.py
@@ -28,6 +28,7 @@
+cm_4d_expected = (np.array([False, False, True, True]),)
`;

describe("splitDiffByFile", () => {
  it("returns empty for an empty diff", () => {
    expect(splitDiffByFile("")).toEqual([]);
    expect(splitDiffByFile("   \n")).toEqual([]);
  });

  it("splits a multi-file diff and keys by the b/ path", () => {
    const parts = splitDiffByFile(SRC_SECTION + TEST_SECTION);
    expect(parts).toHaveLength(2);
    expect(parts[0].path).toBe("astropy/modeling/separable.py");
    expect(parts[1].path).toBe("astropy/modeling/tests/test_separable.py");
  });
});

describe("stripTestChanges", () => {
  it("keeps source files and drops test files", () => {
    const stripped = stripTestChanges(SRC_SECTION + TEST_SECTION);
    expect(stripped).toContain("separable.py");
    expect(stripped).not.toContain("test_separable.py");
  });

  it("returns empty when the diff only touches tests", () => {
    expect(stripTestChanges(TEST_SECTION).trim()).toBe("");
  });

  it("is a no-op when there are no test files", () => {
    expect(stripTestChanges(SRC_SECTION)).toBe(SRC_SECTION);
  });
});

describe("TEST_FILE_PATTERNS", () => {
  it.each([
    "pkg/tests/test_x.py",
    "test/foo.py",
    "src/test_module.py",
    "lib/module_test.py",
    "src/foo.test.ts",
    "src/foo.spec.tsx",
    "conftest.py",
  ])("matches test path %s", (path) => {
    expect(TEST_FILE_PATTERNS.some((re) => re.test(path))).toBe(true);
  });

  it.each([
    "astropy/modeling/separable.py",
    "src/index.ts",
    "lib/contest.py",
  ])("does not match source path %s", (path) => {
    expect(TEST_FILE_PATTERNS.some((re) => re.test(path))).toBe(false);
  });
});

describe("toPredictionLine", () => {
  it("produces a newline-terminated JSONL record in official format", () => {
    const line = toPredictionLine("astropy__astropy-12907", "projectos-gpt-5.5", SRC_SECTION);
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      instance_id: "astropy__astropy-12907",
      model_name_or_path: "projectos-gpt-5.5",
      model_patch: SRC_SECTION,
    });
  });
});
