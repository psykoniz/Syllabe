import { describe, it, expect, beforeEach } from "bun:test";
import { BrowserSession } from "./src/browser-session";
import { dispatchPlaywrightTool } from "./src/dispatcher";
import { PLAYWRIGHT_TOOL_DEFINITIONS } from "./src/tool-definitions";

/** Minimal stub that records calls without launching a real browser */
function makeStubSession(): {
  session: BrowserSession;
  calls: string[];
} {
  const calls: string[] = [];

  const session = {
    navigate: async (url: string) => {
      calls.push(`navigate:${url}`);
      return { url, title: "Test Page", status: 200 };
    },
    click: async (selector: string) => {
      calls.push(`click:${selector}`);
      return { selector, found: true };
    },
    fill: async (selector: string, value: string) => {
      calls.push(`fill:${selector}=${value}`);
      return { selector, value };
    },
    extract: async (selector: string) => {
      calls.push(`extract:${selector}`);
      return { selector, texts: ["item 1", "item 2"] };
    },
    screenshot: async (path: string) => {
      calls.push(`screenshot:${path}`);
      return { path, width: 1280, height: 800 };
    },
    evaluate: async (expression: string) => {
      calls.push(`evaluate:${expression}`);
      return { value: "test-result" };
    },
    getPageSource: async () => {
      calls.push("source");
      return "<html><body>hello</body></html>";
    },
    close: async () => {
      calls.push("close");
    },
  } as unknown as BrowserSession;

  return { session, calls };
}

describe("PLAYWRIGHT_TOOL_DEFINITIONS", () => {
  it("exports 8 tool definitions", () => {
    expect(PLAYWRIGHT_TOOL_DEFINITIONS).toHaveLength(8);
  });

  it("all tools have name, description, input_schema", () => {
    for (const tool of PLAYWRIGHT_TOOL_DEFINITIONS) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.input_schema.type).toBe("object");
    }
  });

  it("includes required browser tools", () => {
    const names = PLAYWRIGHT_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toContain("browser_navigate");
    expect(names).toContain("browser_click");
    expect(names).toContain("browser_fill");
    expect(names).toContain("browser_extract");
    expect(names).toContain("browser_screenshot");
    expect(names).toContain("browser_evaluate");
    expect(names).toContain("browser_source");
    expect(names).toContain("browser_close");
  });
});

describe("dispatchPlaywrightTool", () => {
  let session: BrowserSession;
  let calls: string[];

  beforeEach(() => {
    const stub = makeStubSession();
    session = stub.session;
    calls = stub.calls;
  });

  it("navigate returns url + title + status", async () => {
    const result = await dispatchPlaywrightTool("browser_navigate", { url: "https://example.com" }, session);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("https://example.com");
    expect(result.content).toContain("Test Page");
    expect(result.content).toContain("200");
    expect(calls[0]).toBe("navigate:https://example.com");
  });

  it("click returns selector confirmation", async () => {
    const result = await dispatchPlaywrightTool("browser_click", { selector: "button#submit" }, session);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("button#submit");
  });

  it("click returns error when element not found", async () => {
    const notFoundSession = {
      ...session,
      click: async (selector: string) => ({ selector, found: false }),
    } as unknown as BrowserSession;
    const result = await dispatchPlaywrightTool("browser_click", { selector: "#missing" }, notFoundSession);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("extract returns joined text lines", async () => {
    const result = await dispatchPlaywrightTool("browser_extract", { selector: "li" }, session);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("item 1");
    expect(result.content).toContain("item 2");
  });

  it("evaluate returns JSON-serialized value", async () => {
    const result = await dispatchPlaywrightTool("browser_evaluate", { expression: "document.title" }, session);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("test-result");
  });

  it("source returns HTML", async () => {
    const result = await dispatchPlaywrightTool("browser_source", {}, session);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("<html>");
  });

  it("close closes the session", async () => {
    const result = await dispatchPlaywrightTool("browser_close", {}, session);
    expect(result.isError).toBe(false);
    expect(calls).toContain("close");
  });

  it("unknown tool returns isError=true", async () => {
    const result = await dispatchPlaywrightTool("browser_unknown", {}, session);
    expect(result.isError).toBe(true);
  });

  it("exception from session propagates as error result", async () => {
    const crashSession = {
      navigate: async () => { throw new Error("timeout"); },
    } as unknown as BrowserSession;
    const result = await dispatchPlaywrightTool("browser_navigate", { url: "https://x.com" }, crashSession);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timeout");
  });
});
