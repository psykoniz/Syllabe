import type { ToolDispatchResult } from "@projectos/tools";
import type { BrowserSession } from "./browser-session";

type DispatchInput = Record<string, unknown>;

/**
 * Dispatch a Playwright tool call to the given BrowserSession.
 * Returns a ToolDispatchResult compatible with the existing tool pipeline.
 */
export async function dispatchPlaywrightTool(
  toolName: string,
  input: DispatchInput,
  session: BrowserSession
): Promise<ToolDispatchResult> {
  function ok(content: string): ToolDispatchResult {
    return { content, isError: false };
  }
  function err(content: string): ToolDispatchResult {
    return { content, isError: true };
  }

  try {
    switch (toolName) {
      case "browser_navigate": {
        const result = await session.navigate(input.url as string);
        return ok(
          `Navigated to: ${result.url}\nTitle: ${result.title}\nStatus: ${result.status ?? "unknown"}`
        );
      }

      case "browser_click": {
        const result = await session.click(input.selector as string);
        if (!result.found) return err(`Element not found: ${input.selector as string}`);
        return ok(`Clicked: ${result.selector}`);
      }

      case "browser_fill": {
        await session.fill(input.selector as string, input.value as string);
        return ok(`Filled "${input.selector as string}" with value`);
      }

      case "browser_extract": {
        const result = await session.extract(input.selector as string);
        if (result.texts.length === 0)
          return ok(`No elements found for selector: ${input.selector as string}`);
        const lines = result.texts.slice(0, 50).join("\n");
        const suffix =
          result.texts.length > 50 ? `\n\n[... ${result.texts.length - 50} more items]` : "";
        return ok(lines + suffix);
      }

      case "browser_screenshot": {
        const result = await session.screenshot(input.path as string);
        return ok(
          `Screenshot saved to ${result.path} (${result.width}×${result.height})`
        );
      }

      case "browser_evaluate": {
        const result = await session.evaluate(input.expression as string);
        return ok(JSON.stringify(result.value, null, 2));
      }

      case "browser_source": {
        const html = await session.getPageSource();
        // Truncate to ~40k chars to avoid overwhelming the context
        const truncated =
          html.length > 40_000
            ? html.slice(0, 40_000) + `\n\n[... ${html.length - 40_000} chars truncated]`
            : html;
        return ok(truncated);
      }

      case "browser_close": {
        await session.close();
        return ok("Browser session closed.");
      }

      default:
        return err(`Unknown playwright tool: ${toolName}`);
    }
  } catch (e) {
    return err(`browser error: ${(e as Error).message}`);
  }
}
