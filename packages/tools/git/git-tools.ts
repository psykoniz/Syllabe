import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { logToolCall } from "../tool-logger";

/** Strip userinfo (user:token@) from a git URL so credentials never leak
 *  into logs or .git/config. Local paths are returned untouched. */
function redactRemoteUrl(url: string): string {
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      const parsed = new URL(url);
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
  } catch {
    // fall through — treat as path / scp-like syntax
  }
  return url;
}

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

  /** Clone an existing repository into `dest`, which may be non-empty
   *  (e.g. already contains a .agent/ directory). Implemented as
   *  init + fetch + checkout so it tolerates pre-existing files.
   *  Credentials in `source` are stripped from the persisted remote URL. */
  static clone(source: string, dest: string, baseBranch = "main"): void {
    const run = (args: string[]) => {
      const r = git(args, dest);
      if (r.exitCode !== 0) {
        throw new Error(`git ${args[0]} failed: ${redactRemoteUrl(r.stderr || r.stdout)}`);
      }
      return r.stdout;
    };
    if (!existsSync(join(dest, ".git"))) {
      run(["init", "-q"]);
    }
    const remotes = git(["remote"], dest).stdout.split("\n").filter(Boolean);
    if (!remotes.includes("origin")) {
      run(["remote", "add", "origin", source]);
    } else {
      run(["remote", "set-url", "origin", source]);
    }
    run(["fetch", "--depth", "50", "origin", baseBranch]);
    run(["checkout", "-B", baseBranch, "FETCH_HEAD"]);
    // Never persist credentials in .git/config
    run(["remote", "set-url", "origin", redactRemoteUrl(source)]);
  }

  /** Create (or reset) a branch at HEAD and switch to it. */
  createBranch(name: string): void {
    const start = Date.now();
    const { stderr, exitCode } = git(["checkout", "-B", name], this.opts.repoPath);
    const durationMs = Date.now() - start;
    if (exitCode !== 0) {
      this.log("git:create_branch", { name }, durationMs, stderr);
      throw new Error(`git checkout -B failed: ${stderr}`);
    }
    this.log("git:create_branch", { name }, durationMs);
  }

  /** Name of the currently checked-out branch. */
  currentBranch(): string {
    const { stdout, stderr, exitCode } = git(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      this.opts.repoPath
    );
    if (exitCode !== 0) throw new Error(`git rev-parse failed: ${stderr}`);
    return stdout;
  }

  /** Diff of everything since `base` (committed range plus uncommitted changes). */
  diffRange(base: string): string {
    const range = git(["diff", `${base}..HEAD`], this.opts.repoPath);
    if (range.exitCode !== 0) throw new Error(`git diff range failed: ${range.stderr}`);
    const uncommitted = git(["diff"], this.opts.repoPath);
    if (uncommitted.exitCode !== 0) throw new Error(`git diff failed: ${uncommitted.stderr}`);
    return [range.stdout, uncommitted.stdout].filter(Boolean).join("\n");
  }

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
