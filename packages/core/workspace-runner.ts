import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

// ─── Workspace hygiene + scoped test-failure analysis ────────────────────────
//
// Two systemic escalation causes addressed here:
//  1. `bun install` was never guaranteed in isolated workspaces, so `bun test`
//     failed on missing dependencies that have nothing to do with the task.
//  2. REPAIR was blind: the agent received the full test dump, including
//     failures in files it never touched, and looped on out-of-scope problems.

export interface InstallResult {
  /** Whether an install was actually attempted (node_modules was missing) */
  attempted: boolean;
  /** Whether the workspace is usable (install succeeded or wasn't needed) */
  ok: boolean;
  /** Human-readable summary for traces */
  detail: string;
}

/** Ensure node_modules exists in the workspace before running tests.
 *  Runs `bun install --frozen-lockfile` (or plain `bun install` when no
 *  lockfile is present) with a 60s timeout. No-op when node_modules already
 *  exists or the workspace has no package.json. */
export function ensureNodeModules(workspace: string): InstallResult {
  if (!existsSync(join(workspace, "package.json"))) {
    return { attempted: false, ok: true, detail: "no package.json — install skipped" };
  }
  if (existsSync(join(workspace, "node_modules"))) {
    return { attempted: false, ok: true, detail: "node_modules present — install skipped" };
  }

  const hasLockfile =
    existsSync(join(workspace, "bun.lockb")) || existsSync(join(workspace, "bun.lock"));
  const args = hasLockfile ? ["install", "--frozen-lockfile"] : ["install"];

  const r = spawnSync(process.execPath || "bun", args, {
    cwd: workspace,
    encoding: "utf8",
    timeout: 60_000,
  });

  const ok = r.status === 0;
  const detail = ok
    ? `bun ${args.join(" ")} succeeded`
    : `bun ${args.join(" ")} failed (status ${r.status}): ` +
      `${(r.stderr ?? r.stdout ?? "").slice(0, 500)}`;
  return { attempted: true, ok, detail };
}

export interface TestRunResult {
  exitCode: number;
  output: string;
}

/** Run `bun test` in the workspace and capture combined output. */
export function runWorkspaceTests(workspace: string, timeoutMs = 120_000): TestRunResult {
  const r = spawnSync(process.execPath || "bun", ["test"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return {
    exitCode: r.status ?? -1,
    output: `${r.stdout ?? ""}\n${r.stderr ?? ""}`,
  };
}

export interface TestFailure {
  /** Workspace-relative test file path, e.g. packages/foo/bar.test.ts */
  file: string;
  /** Line number of the failure when available */
  line?: number;
  /** Name of the failing test when available */
  testName?: string;
  /** First line of the error message (no stack trace) */
  message?: string;
}

const TEST_FILE_RE = /(?:^|[\s(/])((?:packages|apps)\/[\w./-]*?\.test\.(?:ts|tsx|js|jsx))(?::(\d+))?/g;

/** Extract the set of failing test files from `bun test` output.
 *  Matches `packages/foo/bar.test.ts` / `apps/foo/bar.test.ts` references
 *  (with or without `:line`) that appear in failure context. */
export function parseFailedTestFiles(output: string): string[] {
  const files = new Set<string>();
  for (const failure of parseTestFailures(output)) files.add(failure.file);
  return [...files];
}

/** Parse structured failures out of `bun test` output: file, line, test name
 *  and a one-line error message — no stack traces. */
export function parseTestFailures(output: string): TestFailure[] {
  const lines = output.split("\n");
  const failures: TestFailure[] = [];
  const seen = new Set<string>();

  // bun reports failures as "(fail) <suite> > <test name>" with the error and
  // an "at <path>:<line>" frame above it, and again as a summary block per file.
  let lastError: string | undefined;
  let lastLoc: { file: string; line?: number } | undefined;

  for (const raw of lines) {
    const line = raw.trim();

    if (/^error:/i.test(line)) {
      lastError = line.replace(/^error:\s*/i, "").slice(0, 300);
      // Module-level errors carry the file on the same line, e.g.
      // "error: Cannot find module 'commander' from '/work/apps/cli/x.test.ts'"
      TEST_FILE_RE.lastIndex = 0;
      const sameLine = TEST_FILE_RE.exec(raw);
      if (sameLine) {
        const key = `${sameLine[1]}:module:${lastError}`;
        if (!seen.has(key)) {
          seen.add(key);
          failures.push({
            file: sameLine[1],
            line: sameLine[2] ? parseInt(sameLine[2], 10) : undefined,
            message: lastError,
          });
        }
        lastError = undefined;
      }
      continue;
    }

    // Location frames: "at .../packages/foo/bar.test.ts:96:5" or bare
    // "packages/foo/bar.test.ts:" headers in the summary.
    TEST_FILE_RE.lastIndex = 0;
    const loc = TEST_FILE_RE.exec(raw);
    if (loc) {
      lastLoc = { file: loc[1], line: loc[2] ? parseInt(loc[2], 10) : undefined };
    }

    const fail = /^\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/.exec(line);
    if (fail && lastLoc) {
      const key = `${lastLoc.file}:${lastLoc.line ?? 0}:${fail[1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        failures.push({
          file: lastLoc.file,
          line: lastLoc.line,
          testName: fail[1],
          message: lastError,
        });
      }
      lastError = undefined;
      continue;
    }

    // Module-level failures (e.g. missing import) have no (fail) line — bun
    // prints "error: Cannot find module ..." followed by a bare file header.
    // Stack frames ("at .../file.ts:96:5") only update the location: their
    // error belongs to the upcoming (fail) line, not a module failure.
    if (lastError && loc && !line.startsWith("(pass)") && !line.startsWith("at ")) {
      const key = `${loc[1]}:module:${lastError}`;
      if (!seen.has(key)) {
        seen.add(key);
        failures.push({
          file: loc[1],
          line: loc[2] ? parseInt(loc[2], 10) : undefined,
          message: lastError,
        });
      }
      lastError = undefined;
    }
  }

  return failures;
}

/** Files modified in the workspace since the last commit (the agent's edits). */
export function getChangedFiles(workspace: string): string[] {
  const collect = (args: string[]): string[] => {
    const r = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
    if (r.status !== 0) return [];
    return (r.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  };
  // Working-tree changes plus untracked files the agent created.
  return [...new Set([
    ...collect(["diff", "--name-only", "HEAD"]),
    ...collect(["ls-files", "--others", "--exclude-standard"]),
  ])];
}

/** True when every failing test file is outside the agent's change scope:
 *  a failing test file is in scope if the agent changed it, or changed a
 *  sibling file in the same directory subtree (its likely subject under test). */
export function failuresOutsideScope(
  failedFiles: string[],
  changedFiles: string[]
): boolean {
  if (failedFiles.length === 0) return false; // nothing parsed — assume in scope
  const changedDirs = changedFiles.map((f) => f.replace(/\/[^/]+$/, ""));
  return failedFiles.every((file) => {
    const dir = file.replace(/\/[^/]+$/, "");
    return !changedFiles.includes(file) && !changedDirs.includes(dir);
  });
}

/** Per-file diff stat lines like "packages/telemetry/cost-tracker.ts (+3 lines)". */
export function changedFileStats(workspace: string): string[] {
  const r = spawnSync("git", ["diff", "--numstat", "HEAD"], {
    cwd: workspace, encoding: "utf8",
  });
  const stats: string[] = [];
  if (r.status === 0) {
    for (const line of (r.stdout ?? "").split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
      if (m) {
        const added = m[1] === "-" ? 0 : parseInt(m[1], 10);
        stats.push(`${m[3]} (+${added} lines)`);
      }
    }
  }
  const u = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: workspace, encoding: "utf8",
  });
  if (u.status === 0) {
    for (const f of (u.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean)) {
      stats.push(`${f} (new file)`);
    }
  }
  return stats;
}

/** Compact diagnostic block passed to the REPAIR prompt instead of the full
 *  `bun test` dump:
 *
 *  ### Test failures
 *  - packages/foo/bar.test.ts:96 — "test name": error message
 *  ### Files changed in this run
 *  - packages/foo/bar.ts (+3 lines)
 */
export function buildRepairDiagnostic(
  failures: TestFailure[],
  changedStats: string[]
): string {
  const lines: string[] = ["### Test failures"];
  if (failures.length === 0) {
    lines.push("- (no structured failures parsed — run `bun test` to inspect)");
  }
  for (const f of failures.slice(0, 20)) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    const name = f.testName ? ` — "${f.testName}"` : "";
    const msg = f.message ? `: ${f.message}` : "";
    lines.push(`- ${loc}${name}${msg}`);
  }
  lines.push("### Files changed in this run");
  if (changedStats.length === 0) {
    lines.push("- (no changes detected)");
  }
  for (const s of changedStats.slice(0, 30)) lines.push(`- ${s}`);
  return lines.join("\n");
}

/** Structured JSON diagnostic for REPAIR prompts — LLMs parse JSON
 *  more reliably than markdown, especially for file:line targeting.
 *  Includes a ~10-line code window around each failure for precise context. */
export function buildStructuredDiagnostic(
  failures: TestFailure[],
  changedStats: string[],
  workspace: string,
): string {
  const structured = failures.slice(0, 10).map((f) => {
    const entry: Record<string, unknown> = {
      file: f.file,
      line: f.line ?? null,
      testName: f.testName ?? null,
      error: f.message ?? null,
    };

    // Include the ~10 lines around the failure for precise context
    if (f.file && f.line) {
      try {
        const content = readFileSync(join(workspace, f.file), "utf8");
        const allLines = content.split("\n");
        const start = Math.max(0, f.line - 5);
        const end = Math.min(allLines.length, f.line + 5);
        entry.codeContext = allLines
          .slice(start, end)
          .map((l, i) => `${start + i + 1}: ${l}`)
          .join("\n");
      } catch { /* skip unreadable files */ }
    }

    return entry;
  });

  return JSON.stringify({
    totalFailures: failures.length,
    failures: structured,
    changedFiles: changedStats.slice(0, 20),
    instruction: "Fix ONLY the source files (not tests) to resolve these failures. " +
      "Focus on the codeContext around each failure line.",
  }, null, 2);
}

