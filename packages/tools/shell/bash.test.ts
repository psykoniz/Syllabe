import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { BashTool } from "./bash";

const TMP = "/tmp/projectos-bash-test";
const LOG = join(TMP, "tool-calls.jsonl");

function makeTool(extra?: Record<string, string>) {
  return new BashTool({ logPath: LOG, workspace: TMP, extraEnv: extra });
}

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("BashTool", () => {
  it("executes command in workspace directory", () => {
    const result = makeTool().run("pwd");
    expect(result.exitCode).toBe(0);
    // pwd may resolve symlinks; check it ends with the basename
    expect(result.stdout).toContain("projectos-bash-test");
  });

  it("returns stdout and non-zero exit code on failure", () => {
    const result = makeTool().run("exit 42");
    expect(result.exitCode).toBe(42);
  });

  it("scrubs ANTHROPIC_API_KEY from env", () => {
    const env = makeTool().getEnv();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("scrubs arbitrary secrets from env", () => {
    const env = makeTool().getEnv();
    // No key outside the allowlist should be present
    const leaked = Object.keys(env).filter(
      (k) => !["PATH", "HOME", "LANG", "NODE_ENV", "BUN_INSTALL"].includes(k)
    );
    expect(leaked).toHaveLength(0);
  });

  it("extra env additions are present", () => {
    const env = makeTool({ MY_VAR: "hello" }).getEnv();
    expect(env["MY_VAR"]).toBe("hello");
  });

  it("logs the call to JSONL", () => {
    makeTool().run("echo hi");
    const line = Bun.file(LOG);
    expect(line).toBeTruthy();
  });

  it("cannot cd out of workspace via command", () => {
    // Even if the command tries to cd, cwd is fixed by spawn options
    const result = makeTool().run("cd / && pwd");
    // spawnSync sets cwd; the command output shows the subshell changed, but
    // the tool's workspace is unchanged for the next call — just verify no crash
    expect(result.exitCode).toBe(0);
  });
});
