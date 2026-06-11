import { describe, it, expect, beforeEach } from "bun:test";
import { redact, redactObject, setHarnessApiKey } from "./secret-redactor";

beforeEach(() => setHarnessApiKey(""));

describe("redact", () => {
  it("redacts API_KEY=...", () => {
    expect(redact("API_KEY=sk-abc123")).toBe("API_KEY=<redacted>");
  });

  it("redacts TOKEN=...", () => {
    expect(redact("TOKEN=ghp_secret")).toBe("TOKEN=<redacted>");
  });

  it("redacts PASSWORD=...", () => {
    expect(redact("PASSWORD=hunter2")).toBe("PASSWORD=<redacted>");
  });

  it("redacts SECRET=...", () => {
    expect(redact("SECRET=mysecret")).toBe("SECRET=<redacted>");
  });

  it("redacts DATABASE_URL=...", () => {
    expect(redact("DATABASE_URL=postgres://user:pass@host/db")).toBe("DATABASE_URL=<redacted>");
  });

  it("is case-insensitive for key names", () => {
    expect(redact("api_key=lower")).toBe("API_KEY=<redacted>");
  });

  it("leaves non-secret text unchanged", () => {
    expect(redact("hello world")).toBe("hello world");
  });

  it("redacts harness API key literal when set", () => {
    setHarnessApiKey("sk-ant-real-key-12345");
    expect(redact("Authorization: Bearer sk-ant-real-key-12345")).toContain("<redacted-harness-key>");
    expect(redact("Authorization: Bearer sk-ant-real-key-12345")).not.toContain("sk-ant-real-key-12345");
  });

  it("harness key always redacted wherever it appears", () => {
    setHarnessApiKey("sk-ant-real-key-12345");
    const text = `key=sk-ant-real-key-12345 and again sk-ant-real-key-12345`;
    const out = redact(text);
    expect(out).not.toContain("sk-ant-real-key-12345");
    expect(out.split("<redacted-harness-key>")).toHaveLength(3);
  });
});

describe("redactObject", () => {
  it("redacts string values in objects", () => {
    const out = redactObject({ cmd: "API_KEY=secret", other: "safe" });
    expect(out.cmd).toBe("API_KEY=<redacted>");
    expect(out.other).toBe("safe");
  });

  it("redacts nested objects", () => {
    const out = redactObject({ env: { secret: "TOKEN=ghp_xyz", OTHER: "x" } } as any);
    expect((out.env as any).secret).toBe("TOKEN=<redacted>");
    expect((out.env as any).OTHER).toBe("x");
  });

  it("leaves non-string values unchanged", () => {
    const out = redactObject({ count: 42, flag: true });
    expect(out.count).toBe(42);
    expect(out.flag).toBe(true);
  });
});
