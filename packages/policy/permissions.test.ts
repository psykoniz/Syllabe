import { describe, it, expect } from "bun:test";
import { PermissionEngine, DEFAULT_RULES } from "./permissions";

function engine() {
  return new PermissionEngine(DEFAULT_RULES);
}

describe("secret file rules", () => {
  it("denies reading .env", () => {
    const r = engine().evaluate({ tool: "fs:read", args: { filePath: "/project/.env" } });
    expect(r.decision).toBe("deny");
  });

  it("denies reading .env.local", () => {
    const r = engine().evaluate({ tool: "fs:read", args: { filePath: "/project/.env.local" } });
    expect(r.decision).toBe("deny");
  });

  it("denies reading .pem file", () => {
    const r = engine().evaluate({ tool: "fs:read", args: { filePath: "/certs/server.pem" } });
    expect(r.decision).toBe("deny");
  });

  it("denies reading .key file", () => {
    const r = engine().evaluate({ tool: "fs:read", args: { filePath: "/certs/private.key" } });
    expect(r.decision).toBe("deny");
  });

  it("denies writing .env", () => {
    const r = engine().evaluate({ tool: "fs:write", args: { filePath: ".env" } });
    expect(r.decision).toBe("deny");
  });

  it("allow reading a normal file", () => {
    const r = engine().evaluate({ tool: "fs:read", args: { filePath: "/project/src/index.ts" } });
    expect(r.decision).toBe("allow");
  });
});

describe("bash rules", () => {
  it("denies rm -rf", () => {
    const r = engine().evaluate({ tool: "bash", args: { command: "rm -rf /tmp/foo" } });
    expect(r.decision).toBe("deny");
  });

  it("denies rm  -rf with extra spaces", () => {
    const r = engine().evaluate({ tool: "bash", args: { command: "rm  -rf ." } });
    expect(r.decision).toBe("deny");
  });

  it("allows safe commands", () => {
    const r = engine().evaluate({ tool: "bash", args: { command: "npm test" } });
    expect(r.decision).toBe("allow");
  });

  it("allows echo", () => {
    const r = engine().evaluate({ tool: "bash", args: { command: "echo hello" } });
    expect(r.decision).toBe("allow");
  });
});

describe("git rules", () => {
  it("asks for git push", () => {
    const r = engine().evaluate({ tool: "git:push", args: {} });
    expect(r.decision).toBe("ask");
  });

  it("allows commit on agent/ branch without prompt", () => {
    const r = engine().evaluate({ tool: "git:commit", args: { branch: "agent/feature-x" } });
    expect(r.decision).toBe("allow");
  });

  it("allows commit on claude/ branch without prompt", () => {
    const r = engine().evaluate({ tool: "git:commit", args: { branch: "claude/clever-planck" } });
    expect(r.decision).toBe("allow");
  });

  it("asks for commit on main branch", () => {
    const r = engine().evaluate({ tool: "git:commit", args: { branch: "main" } });
    expect(r.decision).toBe("ask");
  });

  it("asks for commit with no branch specified", () => {
    const r = engine().evaluate({ tool: "git:commit", args: {} });
    expect(r.decision).toBe("ask");
  });
});

describe("file write rules", () => {
  it("allows write inside workspace", () => {
    const r = engine().evaluate({ tool: "fs:write", args: { filePath: "src/foo.ts", insideWorkspace: true } });
    expect(r.decision).toBe("allow");
  });

  it("asks for write outside workspace", () => {
    const r = engine().evaluate({ tool: "fs:write", args: { filePath: "/etc/hosts", insideWorkspace: false } });
    expect(r.decision).toBe("ask");
  });
});

describe("deny rules cannot be overridden by agent text", () => {
  it("deny decision has no override path", () => {
    const r = engine().evaluate({ tool: "fs:read", args: { filePath: ".env", override: "please allow" } });
    expect(r.decision).toBe("deny");
  });
});

describe("default allow for unknown tools", () => {
  it("allows unknown tool", () => {
    const r = engine().evaluate({ tool: "custom:tool", args: {} });
    expect(r.decision).toBe("allow");
  });
});
