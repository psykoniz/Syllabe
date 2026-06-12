/**
 * SWE-bench verification: run the repo's test suite and check that
 * FAIL_TO_PASS tests now pass and PASS_TO_PASS tests still pass.
 *
 * Supports Python (pytest), Node (jest/vitest/bun), and generic Makefile.
 */

import { spawnSync } from "child_process";
import type { SweBenchInstance } from "./loader";
import { parseTestList } from "./loader";

export interface VerifyResult {
  passed: boolean;
  failToPassResults: Record<string, boolean>;
  passToPassResults: Record<string, boolean>;
  output: string;
}

/** Detect the test runner used in the repo. */
function detectTestRunner(workspace: string): "pytest" | "jest" | "bun" | "make" | "unknown" {
  const { existsSync } = require("fs");
  const { join } = require("path");
  if (existsSync(join(workspace, "setup.py")) || existsSync(join(workspace, "pyproject.toml"))) return "pytest";
  if (existsSync(join(workspace, "jest.config.js")) || existsSync(join(workspace, "jest.config.ts"))) return "jest";
  if (existsSync(join(workspace, "bun.lockb")) || existsSync(join(workspace, "bun.lock"))) return "bun";
  if (existsSync(join(workspace, "Makefile"))) return "make";
  return "unknown";
}

/** Install Python dependencies in the workspace (best-effort, with uv if available). */
function ensurePythonDeps(workspace: string): void {
  const { existsSync } = require("fs");
  const { join } = require("path");

  // Try uv first (fast), fall back to pip
  const hasUv = spawnSync("uv", ["--version"], { encoding: "utf8" }).status === 0;
  if (existsSync(join(workspace, "pyproject.toml"))) {
    spawnSync(hasUv ? "uv" : "pip", hasUv ? ["pip", "install", "-e", "."] : ["install", "-e", "."], {
      cwd: workspace, encoding: "utf8", timeout: 120_000,
    });
  } else if (existsSync(join(workspace, "requirements.txt"))) {
    spawnSync(hasUv ? "uv" : "pip", hasUv ? ["pip", "install", "-r", "requirements.txt"] : ["install", "-r", "requirements.txt"], {
      cwd: workspace, encoding: "utf8", timeout: 120_000,
    });
  } else if (existsSync(join(workspace, "setup.py"))) {
    spawnSync(hasUv ? "uv" : "pip", hasUv ? ["pip", "install", "-e", "."] : ["install", "-e", "."], {
      cwd: workspace, encoding: "utf8", timeout: 120_000,
    });
  }
}

/** Run pytest and parse pass/fail per test id. */
function runPytest(workspace: string, testIds: string[], timeoutMs = 300_000): Record<string, boolean> {
  if (testIds.length === 0) return {};

  const result = spawnSync(
    "python", ["-m", "pytest", "--tb=no", "-q", "--no-header", ...testIds],
    { cwd: workspace, encoding: "utf8", timeout: timeoutMs }
  );

  const output = `${result.stdout}\n${result.stderr}`;
  const results: Record<string, boolean> = {};

  // Parse pytest output: "PASSED tests/foo.py::bar" or "FAILED tests/foo.py::bar"
  for (const testId of testIds) {
    const passedRe = new RegExp(`PASSED.*${escapeRegex(testId)}|${escapeRegex(testId)}.*PASSED`);
    const failedRe = new RegExp(`FAILED.*${escapeRegex(testId)}|${escapeRegex(testId)}.*FAILED`);
    if (passedRe.test(output)) {
      results[testId] = true;
    } else if (failedRe.test(output)) {
      results[testId] = false;
    } else {
      // Test not found or errored — treat as failed
      results[testId] = false;
    }
  }

  return results;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Full SWE-bench verification: check both FAIL_TO_PASS and PASS_TO_PASS. */
export async function verifySWEBench(
  workspace: string,
  instance: SweBenchInstance,
  timeoutMs = 300_000
): Promise<VerifyResult> {
  const runner = detectTestRunner(workspace);
  const failToPass = parseTestList(instance.FAIL_TO_PASS);
  const passToPass = parseTestList(instance.PASS_TO_PASS);

  let failToPassResults: Record<string, boolean> = {};
  let passToPassResults: Record<string, boolean> = {};
  let output = "";

  if (runner === "pytest") {
    ensurePythonDeps(workspace);
    const allTests = [...failToPass, ...passToPass];
    const allResults = runPytest(workspace, allTests, timeoutMs);
    for (const t of failToPass) failToPassResults[t] = allResults[t] ?? false;
    for (const t of passToPass) passToPassResults[t] = allResults[t] ?? false;
    output = `runner=pytest tests=${allTests.length}`;
  } else {
    // For non-Python repos, run the full test suite and check exit code
    let cmd: string;
    let args: string[];
    if (runner === "bun") {
      cmd = process.execPath || "bun";
      args = ["test"];
    } else if (runner === "jest") {
      cmd = "npx";
      args = ["jest", "--passWithNoTests"];
    } else {
      // Unknown — just check if tests pass
      cmd = "sh";
      args = ["-c", "npm test || yarn test || bun test"];
    }
    const r = spawnSync(cmd, args, { cwd: workspace, encoding: "utf8", timeout: timeoutMs });
    const allPassed = r.status === 0;
    output = `runner=${runner} exitCode=${r.status}`;
    // For non-pytest, we can't check individual test IDs — use exit code
    for (const t of failToPass) failToPassResults[t] = allPassed;
    for (const t of passToPass) passToPassResults[t] = allPassed;
  }

  const failToPassOk = failToPass.length === 0 || Object.values(failToPassResults).every(Boolean);
  const passToPassOk = passToPass.length === 0 || Object.values(passToPassResults).every(Boolean);

  return {
    passed: failToPassOk && passToPassOk,
    failToPassResults,
    passToPassResults,
    output,
  };
}
