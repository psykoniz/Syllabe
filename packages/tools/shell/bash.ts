import { existsSync } from "fs";
import { spawnSync } from "child_process";
import { logToolCall } from "../tool-logger";

const ENV_ALLOWLIST = new Set(["PATH", "HOME", "LANG", "NODE_ENV", "BUN_INSTALL"]);

export interface BashOptions {
  logPath: string;
  workspace: string;       // cwd locked to this directory
  timeoutMs?: number;      // default 30s
  extraEnv?: Record<string, string>; // explicit additions beyond allowlist
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function scrubEnv(extra: Record<string, string> = {}): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) clean[key] = process.env[key]!;
  }
  return { ...clean, ...extra };
}

export class BashTool {
  constructor(private opts: BashOptions) {}

  run(command: string, timeoutMs?: number): BashResult {
    const start = Date.now();
    const env = scrubEnv(this.opts.extraEnv);
    const effectiveTimeout = timeoutMs ?? this.opts.timeoutMs ?? 30_000;

    let shellPath = "bash";
    if (process.platform === "win32") {
      const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
      if (existsSync(gitBash)) {
        shellPath = gitBash;
      }
    }

    const proc = spawnSync(shellPath, ["-c", command], {
      cwd: this.opts.workspace,
      env,
      timeout: effectiveTimeout,
      encoding: "utf8",
    });

    const durationMs = Date.now() - start;
    const stdout = proc.stdout ?? "";
    const stderr = proc.stderr ?? "";
    const exitCode = proc.status ?? 1;
    const timedOut = proc.error?.message?.includes("ETIMEDOUT") || proc.signal === "SIGTERM";

    logToolCall(this.opts.logPath, {
      ts: new Date().toISOString(),
      tool: "bash",
      args: { command, workspace: this.opts.workspace },
      result: exitCode === 0 ? "ok" : "error",
      durationMs,
      error: timedOut ? "timeout" : exitCode !== 0 ? stderr.slice(0, 200) : undefined,
    });

    return { stdout, stderr, exitCode };
  }

  /** Returns the scrubbed env (for test inspection) */
  getEnv(): Record<string, string> {
    return scrubEnv(this.opts.extraEnv);
  }
}
