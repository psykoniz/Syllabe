import { describe, it, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { DockerSandbox } from "./src/docker-sandbox";
import type { ExecFn } from "./src/docker-sandbox";
import { SandboxedBash } from "./src/sandboxed-bash";

const TEST_WORKSPACE = join(tmpdir(), "test-workspace");
const TEST_LOG = join(tmpdir(), "test-tool-calls.jsonl");
const WORKSPACE = join(tmpdir(), "ws");
const LOG = join(tmpdir(), "log.jsonl");

function fakeExec(calls: Array<{ cmd: string; args: string[] }>): ExecFn {
  return (cmd, args) => {
    calls.push({ cmd, args });
    const shIdx = args.indexOf("sh");
    const command = shIdx !== -1 ? args[shIdx + 2] : "";
    return {
      status: 0,
      stdout: command.includes("echo") ? "hello\n" : "",
      stderr: "",
      signal: null,
    };
  };
}

describe("DockerSandbox", () => {
  it("runs commands through docker run with stdout returned", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const sandbox = new DockerSandbox({
      workspace: TEST_WORKSPACE,
      logPath: TEST_LOG,
      exec: fakeExec(calls),
    });
    const result = sandbox.run("echo hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(calls[0].cmd).toBe("docker");
    expect(calls[0].args[0]).toBe("run");
  });

  it("uses --network none, --read-only, and no-new-privileges by default", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const sandbox = new DockerSandbox({
      workspace: WORKSPACE,
      logPath: LOG,
      exec: fakeExec(calls),
    });
    sandbox.run("ls");
    const args = calls[0].args;
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args).toContain("--read-only");
    expect(args[args.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
    expect(args).toContain("--rm");
  });

  it("mounts the workspace at /workspace and locks cwd there", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const sandbox = new DockerSandbox({
      workspace: WORKSPACE,
      logPath: LOG,
      exec: fakeExec(calls),
    });
    sandbox.run("ls");
    const args = calls[0].args;
    expect(args[args.indexOf("--volume") + 1]).toBe(`${WORKSPACE}:/workspace:rw`);
    expect(args[args.indexOf("--workdir") + 1]).toBe("/workspace");
  });

  it("passes only PATH into the container env", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const sandbox = new DockerSandbox({
      workspace: WORKSPACE,
      logPath: LOG,
      exec: fakeExec(calls),
    });
    sandbox.run("env");
    const args = calls[0].args;
    const envFlags = args.filter((_, i) => args[i - 1] === "--env");
    expect(envFlags).toHaveLength(1);
    expect(envFlags[0]).toStartWith("PATH=");
    expect(envFlags[0]).not.toContain("ANTHROPIC");
  });

  it("caps memory and disables swap", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const sandbox = new DockerSandbox({
      workspace: WORKSPACE,
      logPath: LOG,
      memoryMb: 256,
      exec: fakeExec(calls),
    });
    sandbox.run("ls");
    const args = calls[0].args;
    expect(args[args.indexOf("--memory") + 1]).toBe("256m");
    expect(args[args.indexOf("--memory-swap") + 1]).toBe("256m");
  });

  it("reports non-zero exit codes", () => {
    const sandbox = new DockerSandbox({
      workspace: WORKSPACE,
      logPath: LOG,
      exec: () => ({ status: 2, stdout: "", stderr: "boom", signal: null }),
    });
    const result = sandbox.run("false");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("boom");
  });
});

describe("SandboxedBash", () => {
  it("implements the BashRunner interface (run + getEnv)", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const sb = new SandboxedBash({
      workspace: TEST_WORKSPACE,
      logPath: TEST_LOG,
      exec: fakeExec(calls),
    });
    const result = sb.run("echo hello");
    expect(result.stdout).toBe("hello\n");
    expect(result.exitCode).toBe(0);
  });

  it("getEnv exposes only PATH — no host secrets", () => {
    const sb = new SandboxedBash({
      workspace: WORKSPACE,
      logPath: LOG,
    });
    const env = sb.getEnv();
    expect(Object.keys(env)).toEqual(["PATH"]);
    expect(env.PATH).not.toContain("ANTHROPIC");
  });

  it("forwards sandbox options to docker args", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const sb = new SandboxedBash({
      workspace: WORKSPACE,
      logPath: LOG,
      sandboxImage: "python:3.12-alpine",
      sandboxNetwork: "bridge",
      exec: fakeExec(calls),
    });
    sb.run("ls");
    const args = calls[0].args;
    expect(args).toContain("python:3.12-alpine");
    expect(args[args.indexOf("--network") + 1]).toBe("bridge");
  });
});
