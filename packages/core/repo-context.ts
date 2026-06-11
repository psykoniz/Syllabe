import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const SKIP_DIRS = new Set([".git", "node_modules", ".agent", ".projectos"]);

export interface RepoContextOptions {
  /** Maximum directory depth for the file tree (default 3) */
  maxDepth?: number;
  /** Maximum number of tree entries (default 200) */
  maxEntries?: number;
  /** Maximum README excerpt length in characters (default 2000) */
  readmeChars?: number;
}

/** Strip userinfo (user:token@) from a git URL so credentials never appear
 *  in run metadata, logs or console output. Local paths are left untouched. */
export function redactGitUrl(url: string): string {
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      const parsed = new URL(url);
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
  } catch {
    // not a parseable URL — fall through
  }
  // scp-like syntax: user@host:path — keep host, it carries no secret beyond
  // the username which is conventionally "git"; strip any password segment.
  const scpMatch = /^([^@:/]+)(?::[^@]+)?@(.+)$/.exec(url);
  if (scpMatch && url.includes(":") && !url.startsWith("/")) {
    return `${scpMatch[1]}@${scpMatch[2]}`;
  }
  return url;
}

interface TreeResult {
  lines: string[];
  truncated: boolean;
}

function buildTree(root: string, maxDepth: number, maxEntries: number): TreeResult {
  const lines: string[] = [];
  let truncated = false;

  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > maxDepth || truncated) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((e) => !SKIP_DIRS.has(e)).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (lines.length >= maxEntries) {
        truncated = true;
        return;
      }
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      lines.push(`${prefix}${entry}${isDir ? "/" : ""}`);
      if (isDir) walk(full, prefix + "  ", depth + 1);
    }
  };

  walk(root, "", 1);
  return { lines, truncated };
}

function detectConventions(workspace: string): string[] {
  const conventions: string[] = [];
  const pkgPath = join(workspace, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        name?: string;
        scripts?: Record<string, string>;
        workspaces?: string[];
      };
      if (pkg.name) conventions.push(`Package name: ${pkg.name}`);
      if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
        conventions.push(
          "package.json scripts: " +
            Object.entries(pkg.scripts)
              .slice(0, 10)
              .map(([k, v]) => `\`${k}\` (${v})`)
              .join(", ")
        );
      }
      if (Array.isArray(pkg.workspaces) && pkg.workspaces.length > 0) {
        conventions.push(`Monorepo workspaces: ${pkg.workspaces.join(", ")}`);
      }
    } catch {
      // malformed package.json — skip
    }
  }
  if (existsSync(join(workspace, "tsconfig.json"))) {
    conventions.push("TypeScript project (tsconfig.json present)");
  }
  if (existsSync(join(workspace, "bun.lock")) || existsSync(join(workspace, "bun.lockb"))) {
    conventions.push("Uses Bun (bun.lock present) — prefer `bun install` / `bun test`");
  }
  // Test file pattern detection (shallow scan, depth 2)
  const patterns = new Set<string>();
  const scan = (dir: string, depth: number) => {
    if (depth > 2) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((e) => !SKIP_DIRS.has(e));
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) {
          if (entry === "__tests__" || entry === "test" || entry === "tests") {
            patterns.add(`${entry}/ directories`);
          }
          scan(full, depth + 1);
        } else if (/\.test\.(ts|tsx|js|jsx)$/.test(entry)) {
          patterns.add("*.test.* files colocated with sources");
        } else if (/\.spec\.(ts|tsx|js|jsx)$/.test(entry)) {
          patterns.add("*.spec.* files");
        }
      } catch {
        // ignore unreadable entries
      }
    }
  };
  scan(workspace, 1);
  if (patterns.size > 0) {
    conventions.push(`Test conventions: ${[...patterns].join(", ")}`);
  }
  return conventions;
}

function readmeExcerpt(workspace: string, maxChars: number): string | null {
  for (const name of ["README.md", "README", "readme.md"]) {
    const p = join(workspace, name);
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf8");
        return content.length > maxChars
          ? content.slice(0, maxChars) + "\n…(truncated)"
          : content;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Build a markdown summary of an existing repository for prompt injection:
 *  file tree (bounded), README excerpt and detected conventions. */
export function buildRepoContext(workspace: string, opts: RepoContextOptions = {}): string {
  const maxDepth = opts.maxDepth ?? 3;
  const maxEntries = opts.maxEntries ?? 200;
  const readmeChars = opts.readmeChars ?? 2000;

  const sections: string[] = [];

  const tree = buildTree(workspace, maxDepth, maxEntries);
  sections.push(
    "#### File tree" + (tree.truncated ? ` (first ${maxEntries} entries)` : ""),
    "```",
    tree.lines.join("\n") || "(empty)",
    "```"
  );

  const readme = readmeExcerpt(workspace, readmeChars);
  if (readme) {
    sections.push("#### README excerpt", "```markdown", readme, "```");
  }

  const conventions = detectConventions(workspace);
  if (conventions.length > 0) {
    sections.push("#### Detected conventions", ...conventions.map((c) => `- ${c}`));
  }

  return sections.join("\n");
}

/** Tree-only variant for cheaper prompt injection in PLAN/IMPLEMENT. */
export function buildRepoTree(workspace: string, opts: RepoContextOptions = {}): string {
  const maxDepth = opts.maxDepth ?? 3;
  const maxEntries = opts.maxEntries ?? 200;
  const tree = buildTree(workspace, maxDepth, maxEntries);
  return [
    "#### File tree" + (tree.truncated ? ` (first ${maxEntries} entries)` : ""),
    "```",
    tree.lines.join("\n") || "(empty)",
    "```",
  ].join("\n");
}
