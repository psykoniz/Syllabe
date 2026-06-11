import type { ToolDef } from "@projectos/tools";

export const PLAYWRIGHT_TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: "browser_navigate",
    description:
      "Navigate the browser to a URL. Returns the final URL, page title, and HTTP status. Use this first before any other browser tools.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to navigate to (must include https://)." },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_click",
    description:
      "Click an element on the current page using a CSS selector. Returns whether the element was found.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for the element to click." },
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_fill",
    description: "Fill a form input, textarea, or contenteditable element with a value.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for the input element." },
        value: { type: "string", description: "The value to type into the element." },
      },
      required: ["selector", "value"],
    },
  },
  {
    name: "browser_extract",
    description:
      "Extract the visible text from all elements matching a CSS selector. Returns a list of strings.",
    input_schema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector. Use broad selectors like 'p', 'li', 'h1,h2,h3' for content extraction.",
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_screenshot",
    description: "Take a screenshot of the current page and save it to a file path.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute file path where the screenshot PNG will be saved.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "browser_evaluate",
    description:
      "Evaluate a JavaScript expression in the page context and return the result. Use for reading DOM state (e.g. document.title, window.location.href). Avoid side-effect expressions.",
    input_schema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "JavaScript expression to evaluate." },
      },
      required: ["expression"],
    },
  },
  {
    name: "browser_source",
    description: "Get the full HTML source of the current page. Use for scraping or debugging.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "browser_close",
    description: "Close the browser session. Call this when you are done with browser tasks.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];
