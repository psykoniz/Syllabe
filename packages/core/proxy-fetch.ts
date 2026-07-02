/**
 * Proxy-aware fetch for Bun in CCR remote environments.
 *
 * Bun 1.3.x cannot tunnel HTTPS through HTTP CONNECT (its node:http shim
 * intercepts and rejects CONNECT). When HTTPS_PROXY is set and we are running
 * under Bun, we fall back to spawning `curl` for each request — curl already
 * has the CCR CA bundle configured and respects HTTPS_PROXY natively.
 *
 * In Node, or when no proxy is configured, we return globalThis.fetch unchanged.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROXY_URL =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  "";

const IS_BUN = typeof Bun !== "undefined";
const CA_BUNDLE = process.env.NODE_EXTRA_CA_CERTS ?? "/root/.ccr/ca-bundle.crt";

/**
 * A fetch implementation that delegates to `curl --proxy` so that Bun's
 * inability to HTTP CONNECT is bypassed entirely.
 */
async function curlFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  // Normalise input to a URL string + merged init
  let urlStr: string;
  let mergedInit: RequestInit = init ?? {};
  if (typeof input === "string") {
    urlStr = input;
  } else if (input instanceof URL) {
    urlStr = input.href;
  } else {
    // Request object
    urlStr = input.url;
    mergedInit = {
      method: input.method,
      headers: input.headers,
      body: mergedInit.body ?? (input.body ? await input.text() : undefined),
      ...mergedInit,
    };
  }

  const method = (mergedInit.method ?? "GET").toUpperCase();
  const bodyStr = mergedInit.body != null ? String(mergedInit.body) : null;

  // Build curl args
  const args: string[] = [
    "--silent",
    "--show-error",
    "--include",            // include response headers
    "--max-time", "90",
    "--proxy", PROXY_URL,
    "--cacert", CA_BUNDLE,
    "-X", method,
    urlStr,
  ];

  // Headers
  const headers = new Headers(mergedInit.headers as HeadersInit | undefined);
  for (const [k, v] of headers.entries()) {
    args.push("-H", `${k}: ${v}`);
  }

  // Body — write to a temp file to avoid shell quoting issues
  let bodyPath: string | null = null;
  if (bodyStr) {
    const tmpDir = mkdtempSync(join(tmpdir(), "proxy-fetch-"));
    bodyPath = join(tmpDir, "body.json");
    writeFileSync(bodyPath, bodyStr, "utf8");
    args.push("--data-binary", `@${bodyPath}`);
  }

  const proc = spawnSync("curl", args, { encoding: "binary", maxBuffer: 64 * 1024 * 1024 });

  if (proc.error) throw new Error(`curlFetch: spawn failed: ${proc.error.message}`);
  if (proc.status !== 0) {
    throw new Error(`curlFetch: curl exited ${proc.status}: ${proc.stderr?.slice(0, 200)}`);
  }

  const raw: string = proc.stdout;

  // Parse HTTP response (may have multiple header blocks for redirects)
  const blocks = raw.split(/(?=HTTP\/[\d.]+\s)/);
  const lastBlock = blocks[blocks.length - 1] ?? "";
  const headerEnd = lastBlock.indexOf("\r\n\r\n");
  if (headerEnd < 0) throw new Error("curlFetch: malformed response — no header terminator");

  const headerSection = lastBlock.slice(0, headerEnd);
  const bodyBinary = lastBlock.slice(headerEnd + 4);

  const [statusLine, ...headerLines] = headerSection.split("\r\n");
  const statusCode = parseInt((statusLine ?? "HTTP/1.1 200").split(" ")[1] ?? "200", 10);

  const respHeaders = new Headers();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      respHeaders.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
  }

  const bodyBuffer = Buffer.from(bodyBinary, "binary");
  return new Response(bodyBuffer, { status: statusCode, headers: respHeaders });
}

/**
 * Returns a fetch function that works correctly under Bun in CCR environments.
 * Falls back to the global fetch when not in Bun or when no proxy is set.
 */
export function makeProxyFetch(): typeof fetch {
  if (!PROXY_URL || !IS_BUN) {
    return globalThis.fetch;
  }
  return curlFetch as unknown as typeof fetch;
}

export const proxyFetch = makeProxyFetch();
