import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import {
  ensureNodeModules,
  parseTestFailures,
  parseFailedTestFiles,
  getChangedFiles,
  failuresOutsideScope,
  changedFileStats,
  buildRepairDiagnostic,
} from "./workspace-runner";

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "ws-runner-"));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

// ─── Fix 1: bun install before tests ─────────────────────────────────────────

describe("ensureNodeModules", () => {
  test("skips when there is no package.json", () => {
    const r = ensureNodeModules(ws);
    expect(r.attempted).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("no package.json");
  });

  test("skips when node_modules already exists", () => {
    writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "x" }));
    mkdirSync(join(ws, "node_modules"));
    const r = ensureNodeModules(ws);
    expect(r.attempted).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("node_modules present");
  });

  test("runs bun install when node_modules is absent", () => {
    writeFileSync(
      join(ws, "package.json"),
      JSON.stringify({ name: "x", version: "0.0.1" })
    );
    const r = ensureNodeModules(ws);
    expect(r.attempted).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("bun install");
    // No lockfile in this workspace — must not use --frozen-lockfile
    expect(r.detail).not.toContain("--frozen-lockfile");
  });

  test("uses --frozen-lockfile when a lockfile is present", () => {
    writeFileSync(
      join(ws, "package.json"),
      JSON.stringify({ name: "x", version: "0.0.1" })
    );
    writeFileSync(
      join(ws, "bun.lock"),
      `{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "x",\n    },\n  },\n  "packages": {},\n}\n`
    );
    const r = ensureNodeModules(ws);
    expect(r.attempted).toBe(true);
    expect(r.detail).toContain("--frozen-lockfile");
  });
});

// ─── Fix 2/3: parsing bun test output ────────────────────────────────────────

const SAMPLE_OUTPUT = `
bun test v1.1.0

packages/telemetry/cost-tracker.test.ts:
(pass) cost tracker > tracks zero cost [0.12ms]
96 |     expect(cost).toBe(1.4);
error: expect(received).toBe(expected)
expected 0 to be 1.4
      at /work/packages/telemetry/cost-tracker.test.ts:96:5
(fail) cost tracker > computes non-zero cost for gpt-5.5 [1.02ms]

apps/cli/commands/self-improve.test.ts:
error: Cannot find module 'commander' from '/work/apps/cli/commands/self-improve.test.ts'
 1 pass
 2 fail
`;

describe("parseTestFailures", () => {
  test("extracts file, line, test name and message for assertion failures", () => {
    const failures = parseTestFailures(SAMPLE_OUTPUT);
    const f = failures.find((x) => x.testName?.includes("gpt-5.5"));
    expect(f).toBeDefined();
    expect(f!.file).toBe("packages/telemetry/cost-tracker.test.ts");
    expect(f!.line).toBe(96);
    expect(f!.message).toContain("expect(received).toBe(expected)");
  });

  test("extracts module-level failures (missing import) without a (fail) line", () => {
    const failures = parseTestFailures(SAMPLE_OUTPUT);
    const f = failures.find((x) => x.file === "apps/cli/commands/self-improve.test.ts");
    expect(f).toBeDefined();
    expect(f!.message).toContain("Cannot find module 'commander'");
  });

  test("returns no failures for clean output", () => {
    expect(parseTestFailures("(pass) all good\n 5 pass\n 0 fail\n")).toEqual([]);
  });
});

describe("parseFailedTestFiles", () => {
  test("returns the unique set of failing test files", () => {
    const files = parseFailedTestFiles(SAMPLE_OUTPUT);
    expect(files).toContain("packages/telemetry/cost-tracker.test.ts");
    expect(files).toContain("apps/cli/commands/self-improve.test.ts");
    expect(files.length).toBe(2);
  });
});

// ─── Fix 2: out-of-scope detection ───────────────────────────────────────────

describe("failuresOutsideScope", () => {
  test("true when no failing file overlaps the agent's changes", () => {
    expect(
      failuresOutsideScope(
        ["apps/cli/commands/self-improve.test.ts"],
        ["packages/telemetry/cost-tracker.ts"]
      )
    ).toBe(true);
  });

  test("false when a failing test file was changed by the agent", () => {
    expect(
      failuresOutsideScope(
        ["packages/telemetry/cost-tracker.test.ts"],
        ["packages/telemetry/cost-tracker.test.ts"]
      )
    ).toBe(false);
  });

  test("false when a failing test sits next to a changed source file", () => {
    expect(
      failuresOutsideScope(
        ["packages/telemetry/cost-tracker.test.ts"],
        ["packages/telemetry/cost-tracker.ts"]
      )
    ).toBe(false);
  });

  test("false when at least one failure is in scope (mixed case)", () => {
    expect(
      failuresOutsideScope(
        [
          "apps/cli/commands/self-improve.test.ts",
          "packages/telemetry/cost-tracker.test.ts",
        ],
        ["packages/telemetry/cost-tracker.ts"]
      )
    ).toBe(false);
  });

  test("false when no failures were parsed (assume in scope)", () => {
    expect(failuresOutsideScope([], ["packages/foo/bar.ts"])).toBe(false);
  });
});

// ─── Fix 2: changed-file detection via git ───────────────────────────────────

describe("getChangedFiles / changedFileStats", () => {
  function initRepo(dir: string) {
    const run = (args: string[]) => spawnSync("git", args, { cwd: dir });
    run(["init", "-q"]);
    run(["config", "user.email", "t@t"]);
    run(["config", "user.name", "t"]);
    run(["config", "commit.gpgsign", "false"]);
  }

  test("reports modified and untracked files", () => {
    initRepo(ws);
    mkdirSync(join(ws, "packages/telemetry"), { recursive: true });
    writeFileSync(join(ws, "packages/telemetry/cost-tracker.ts"), "export const a = 1;\n");
    spawnSync("git", ["add", "-A"], { cwd: ws });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: ws });

    writeFileSync(
      join(ws, "packages/telemetry/cost-tracker.ts"),
      "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n"
    );
    writeFileSync(join(ws, "packages/telemetry/new-file.ts"), "export {};\n");

    const changed = getChangedFiles(ws);
    expect(changed).toContain("packages/telemetry/cost-tracker.ts");
    expect(changed).toContain("packages/telemetry/new-file.ts");

    const stats = changedFileStats(ws);
    expect(stats).toContain("packages/telemetry/cost-tracker.ts (+3 lines)");
    expect(stats).toContain("packages/telemetry/new-file.ts (new file)");
  });

  test("returns empty list outside a git repo", () => {
    expect(getChangedFiles(ws)).toEqual([]);
  });
});

// ─── Fix 3: REPAIR diagnostic format ─────────────────────────────────────────

describe("buildRepairDiagnostic", () => {
  test("produces the compact failures + changed-files format", () => {
    const diag = buildRepairDiagnostic(
      [
        {
          file: "packages/telemetry/cost-tracker.test.ts",
          line: 96,
          testName: "computes non-zero cost for gpt-5.5",
          message: "expected 0 to be 1.4",
        },
      ],
      ["packages/telemetry/cost-tracker.ts (+3 lines)"]
    );
    expect(diag).toContain("### Test failures");
    expect(diag).toContain(
      '- packages/telemetry/cost-tracker.test.ts:96 — "computes non-zero cost for gpt-5.5": expected 0 to be 1.4'
    );
    expect(diag).toContain("### Files changed in this run");
    expect(diag).toContain("- packages/telemetry/cost-tracker.ts (+3 lines)");
  });

  test("handles empty inputs gracefully", () => {
    const diag = buildRepairDiagnostic([], []);
    expect(diag).toContain("no structured failures parsed");
    expect(diag).toContain("no changes detected");
  });
});
