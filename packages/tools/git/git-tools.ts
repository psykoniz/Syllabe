import { spawnSync } from "child_process";
import { logToolCall } from "../tool-logger";

export interface GitToolsOptions {
  logPath: string;
  repoPath: string;
}

export interface GitCommitResult {
  sha: string;
  message: string;
}

function git(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const proc = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    stdout: (proc.stdout ?? "").trim(),
    stderr: (proc.stderr ?? "").trim(),
    exitCode: proc.status ?? 1,
  };
}

export class GitTools {
  constructor(private opts: GitToolsOptions) {}

  private log(tool: string, args: Record<string, unknown>, durationMs: number, error?: string) {
    logToolCall(this.opts.logPath, {
      ts: new Date().toISOString(),
      tool,
      args,
      result: error ? "error" : "ok",
      durationMs,
      error,
    });
  }

  status(): string {
    const start = Date.now();
    const { stdout, stderr, exitCode } = git(["status", "--short"], this.opts.repoPath);
    const durationMs = Date.now() - start;
    if (exitCode !== 0) {
      this.log("git:status", {}, durationMs, stderr);
      throw new Error(`git status failed: ${stderr}`);
    }
    this.log("git:status", {}, durationMs);
    return stdout;
  }

  diff(staged = false): string {
    const start = Date.now();
    const args = staged ? ["diff", "--cached"] : ["diff"];
    const { stdout, stderr, exitCode } = git(args, this.opts.repoPath);
    const durationMs = Date.now() - start;
    if (exitCode !== 0) {
      this.log("git:diff", { staged }, durationMs, stderr);
      throw new Error(`git diff failed: ${stderr}`);
    }
    this.log("git:diff", { staged }, durationMs);
    return stdout;
  }

  commit(files: string[], message: string): GitCommitResult {
    const start = Date.now();
    try {
      const addResult = git(["add", "--", ...files], this.opts.repoPath);
      if (addResult.exitCode !== 0) throw new Error(`git add failed: ${addResult.stderr}`);

      const commitResult = git(["commit", "-m", message], this.opts.repoPath);
      if (commitResult.exitCode !== 0) throw new Error(`git commit failed: ${commitResult.stderr}`);

      const shaResult = git(["rev-parse", "HEAD"], this.opts.repoPath);
      const sha = shaResult.stdout;

      this.log("git:commit", { files, message }, Date.now() - start);
      return { sha, message };
    } catch (e) {
      this.log("git:commit", { files, message }, Date.now() - start, (e as Error).message);
      throw e;
    }
  }
}
