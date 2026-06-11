const REDACT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(API_KEY\s*=\s*)[^\s"']+/gi,      label: "API_KEY=<redacted>" },
  { re: /\b(TOKEN\s*=\s*)[^\s"']+/gi,         label: "TOKEN=<redacted>" },
  { re: /\b(PASSWORD\s*=\s*)[^\s"']+/gi,      label: "PASSWORD=<redacted>" },
  { re: /\b(SECRET\s*=\s*)[^\s"']+/gi,        label: "SECRET=<redacted>" },
  { re: /\b(PRIVATE_KEY\s*=\s*)[^\s"']+/gi,   label: "PRIVATE_KEY=<redacted>" },
  { re: /\b(DATABASE_URL\s*=\s*)[^\s"']+/gi,  label: "DATABASE_URL=<redacted>" },
];

// Loaded once at startup — the harness's own API key literal
let harnessApiKey: string | null = null;

export function setHarnessApiKey(key: string): void {
  harnessApiKey = key;
}

export function redact(text: string): string {
  let out = text;

  // Redact the harness key literal first (highest priority)
  if (harnessApiKey && harnessApiKey.length > 8) {
    out = out.split(harnessApiKey).join("<redacted-harness-key>");
  }

  for (const { re, label } of REDACT_PATTERNS) {
    out = out.replace(re, label);
  }

  return out;
}

export function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      result[k] = redact(v);
    } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      result[k] = redactObject(v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}
