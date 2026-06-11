import type { BashResult, BashOptions } from "@projectos/tools";
import { DockerSandbox } from "./docker-sandbox";
import type { ExecFn } from "./docker-sandbox";

export interface SandboxedBashOptions extends BashOptions {
  sandboxImage?: string;
  sandboxNetwork?: "none" | "host" | "bridge";
  sandboxMemoryMb?: number;
  /** Injectable exec for tests */
  exec?: ExecFn;
}

/**
 * Drop-in replacement for BashTool that routes execution through DockerSandbox.
 * Implements the same run() / getEnv() interface so it can replace BashTool
 * inside ToolContext without other changes.
 */
export class SandboxedBash {
  private sandbox: DockerSandbox;

  constructor(private opts: SandboxedBashOptions) {
    this.sandbox = new DockerSandbox({
      image: opts.sandboxImage,
      workspace: opts.workspace,
      logPath: opts.logPath,
      timeoutMs: opts.timeoutMs,
      network: opts.sandboxNetwork,
      memoryMb: opts.sandboxMemoryMb,
      exec: opts.exec,
    });
  }

  run(command: string): BashResult {
    return this.sandbox.run(command);
  }

  getEnv(): Record<string, string> {
    return { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" };
  }
}
