import { spawnSync } from "child_process";
import { logToolCall } from "@projectos/tools";

export interface DockerSandboxOptions {
  image?: string;           // default: "node:20-alpine"
  workspace: string;        // host path, mounted read-write at /workspace
  logPath: string;
  timeoutMs?: number;       // default: 60s
  network?: "none" | "host" | "bridge"; // default: "none"
  memoryMb?: number;        // default: 512
  /** Injectable exec for tests — defaults to spawnSync */
  exec?: ExecFn;
}

export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { timeout?: number; encoding: "utf8" },
) => { status: number | null; stdout: string | null; stderr: string | null; error?: Error; signal?: string | null };

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_IMAGE = "node:20-alpine";

/**
 * Runs bash commands inside an ephemeral Docker container.
 * - Workspace mounted at /workspace (cwd locked there)
 * - No network by default
 * - Memory capped
 * - Environment fully scrubbed — only PATH passed in
 * - Container is removed on exit (--rm)
 */
export class DockerSandbox {
  private opts: Required<Omit<DockerSandboxOptions, "exec">>;
  private exec: ExecFn;

  constructor(opts: DockerSandboxOptions) {
    this.opts = {
      image: opts.image ?? DEFAULT_IMAGE,
      workspace: opts.workspace,
      logPath: opts.logPath,
      timeoutMs: opts.timeoutMs ?? 60_000,
      network: opts.network ?? "none",
      memoryMb: opts.memoryMb ?? 512,
    };
    this.exec = opts.exec ?? (spawnSync as unknown as ExecFn);
  }

  run(command: string, timeoutMs?: number): SandboxResult {
    const start = Date.now();

    const dockerArgs = [
      "run",
      "--rm",
      "--network", this.opts.network,
      "--memory", `${this.opts.memoryMb}m`,
      "--memory-swap", `${this.opts.memoryMb}m`, // disable swap
      "--read-only",
      "--tmpfs", "/tmp:size=64m",
      "--volume", `${this.opts.workspace}:/workspace:rw`,
      "--workdir", "/workspace",
      "--env", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "--security-opt", "no-new-privileges",
      this.opts.image,
      "sh", "-c", command,
    ];

    const proc = this.exec("docker", dockerArgs, {
      timeout: timeoutMs ?? this.opts.timeoutMs,
      encoding: "utf8",
    });

    const durationMs = Date.now() - start;
    const stdout = proc.stdout ?? "";
    const stderr = proc.stderr ?? "";
    const exitCode = proc.status ?? 1;
    const timedOut = proc.error?.message?.includes("ETIMEDOUT") || proc.signal === "SIGTERM";

    logToolCall(this.opts.logPath, {
      ts: new Date().toISOString(),
      tool: "docker-sandbox",
      args: { command, workspace: this.opts.workspace, image: this.opts.image },
      result: exitCode === 0 ? "ok" : "error",
      durationMs,
      error: timedOut ? "timeout" : exitCode !== 0 ? stderr.slice(0, 200) : undefined,
    });

    return { stdout, stderr, exitCode };
  }

  /** Check if Docker is available on the host */
  static isAvailable(): boolean {
    const result = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 5000 });
    return result.status === 0;
  }

  /** Pull the image if not already present */
  pull(): void {
    spawnSync("docker", ["pull", this.opts.image], {
      encoding: "utf8",
      timeout: 120_000,
      stdio: "pipe",
    });
  }
}
