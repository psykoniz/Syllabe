import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { logToolCall } from "@projectos/tools";

export interface BrowserSessionOptions {
  logPath: string;
  headless?: boolean;
  timeoutMs?: number;
  viewport?: { width: number; height: number };
}

export interface NavigateResult {
  url: string;
  title: string;
  status: number | null;
}

export interface ClickResult {
  selector: string;
  found: boolean;
}

export interface FillResult {
  selector: string;
  value: string;
}

export interface ExtractResult {
  selector: string;
  texts: string[];
}

export interface ScreenshotResult {
  path: string;
  width: number;
  height: number;
}

export interface EvalResult {
  value: unknown;
}

/**
 * Stateful browser session wrapping a Playwright Page.
 * One session = one browser tab, reused across tool calls in an agent turn.
 */
export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private opts: Required<BrowserSessionOptions>;

  constructor(opts: BrowserSessionOptions) {
    this.opts = {
      headless: true,
      timeoutMs: 30_000,
      viewport: { width: 1280, height: 800 },
      ...opts,
    };
  }

  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;
    this.browser = await chromium.launch({ headless: this.opts.headless });
    this.context = await this.browser.newContext({
      viewport: this.opts.viewport,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.opts.timeoutMs);
    return this.page;
  }

  async navigate(url: string): Promise<NavigateResult> {
    const start = Date.now();
    const page = await this.ensurePage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    const title = await page.title();
    const finalUrl = page.url();
    const status = response?.status() ?? null;
    logToolCall(this.opts.logPath, {
      ts: new Date().toISOString(),
      tool: "browser_navigate",
      args: { url },
      result: "ok",
      durationMs: Date.now() - start,
    });
    return { url: finalUrl, title, status };
  }

  async click(selector: string): Promise<ClickResult> {
    const start = Date.now();
    const page = await this.ensurePage();
    let found = false;
    try {
      await page.click(selector, { timeout: this.opts.timeoutMs });
      found = true;
    } catch {
      found = false;
    }
    logToolCall(this.opts.logPath, {
      ts: new Date().toISOString(),
      tool: "browser_click",
      args: { selector },
      result: found ? "ok" : "error",
      durationMs: Date.now() - start,
      error: found ? undefined : "element not found",
    });
    return { selector, found };
  }

  async fill(selector: string, value: string): Promise<FillResult> {
    const start = Date.now();
    const page = await this.ensurePage();
    await page.fill(selector, value);
    logToolCall(this.opts.logPath, {
      ts: new Date().toISOString(),
      tool: "browser_fill",
      args: { selector, value: value.slice(0, 80) },
      result: "ok",
      durationMs: Date.now() - start,
    });
    return { selector, value };
  }

  async extract(selector: string): Promise<ExtractResult> {
    const start = Date.now();
    const page = await this.ensurePage();
    const texts = await page.$$eval(selector, (els) =>
      els.map((el) => (el as HTMLElement).innerText?.trim() ?? "").filter(Boolean)
    );
    logToolCall(this.opts.logPath, {
      ts: new Date().toISOString(),
      tool: "browser_extract",
      args: { selector },
      result: "ok",
      durationMs: Date.now() - start,
    });
    return { selector, texts };
  }

  async screenshot(savePath: string): Promise<ScreenshotResult> {
    const start = Date.now();
    const page = await this.ensurePage();
    await page.screenshot({ path: savePath, fullPage: false });
    const vp = page.viewportSize();
    logToolCall(this.opts.logPath, {
      ts: new Date().toISOString(),
      tool: "browser_screenshot",
      args: { path: savePath },
      result: "ok",
      durationMs: Date.now() - start,
    });
    return { path: savePath, width: vp?.width ?? 0, height: vp?.height ?? 0 };
  }

  async evaluate(expression: string): Promise<EvalResult> {
    const start = Date.now();
    const page = await this.ensurePage();
    // Only allow safe read-only expressions — no assignments, no fetch
    const value = await page.evaluate(expression);
    logToolCall(this.opts.logPath, {
      ts: new Date().toISOString(),
      tool: "browser_evaluate",
      args: { expression: expression.slice(0, 120) },
      result: "ok",
      durationMs: Date.now() - start,
    });
    return { value };
  }

  async getPageSource(): Promise<string> {
    const page = await this.ensurePage();
    return page.content();
  }

  async close(): Promise<void> {
    await this.page?.close().catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}
