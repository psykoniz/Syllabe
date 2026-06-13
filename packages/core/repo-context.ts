import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const SKIP_DIRS = new Set([".git", "node_modules", ".agent", ".projectos"]);

/** Source file extensions searched by task-guided file discovery. Kept
 *  language-agnostic on purpose: SWE-bench (and most real repos we run on) are
 *  Python, Go, Rust, Java, … — restricting to JS/TS made the relevant file
 *  invisible to the agent on every non-JS repo. */
const SOURCE_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "go", "rs", "java", "kt", "scala",
  "rb", "php", "c", "h", "cc", "cpp", "hpp", "cs", "swift",
  "json", "toml", "cfg", "ini", "md", "rst",
] as const;

const GREP_INCLUDES = SOURCE_EXTENSIONS.map((e) => `--include=*.${e}`);

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

// ─── Smart repo context (task-guided) ────────────────────────────────────────

const STOP_WORDS = new Set([
  "that", "this", "with", "from", "have", "will", "should", "create",
  "make", "build", "want", "need", "like", "just", "using", "also",
  "each", "file", "code", "project", "must", "some", "when", "then",
]);

/** Extract meaningful keywords from a task description for file search. */
export function extractTaskKeywords(task: string): string[] {
  return task
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

/** Grep the workspace for files containing task-relevant keywords. */
export function findRelevantFiles(
  workspace: string,
  keywords: string[],
  maxFiles = 20
): string[] {
  const files = new Set<string>();
  for (const kw of keywords.slice(0, 5)) {
    const r = spawnSync(
      "grep",
      ["-rl", ...GREP_INCLUDES,
       ...[...SKIP_DIRS].map((d) => `--exclude-dir=${d}`),
       "--fixed-strings", kw, "."],
      { cwd: workspace, encoding: "utf8", timeout: 5000 }
    );
    if (r.status === 0) {
      for (const f of r.stdout.split("\n").filter(Boolean)) {
        const clean = f.replace(/^\.\//, "");
        if (!SKIP_DIRS.has(clean.split("/")[0])) {
          files.add(clean);
        }
        if (files.size >= maxFiles) break;
      }
    }
    if (files.size >= maxFiles) break;
  }
  return [...files];
}

/** Read the first N lines of files for concise prompt injection. */
function readExcerpts(
  workspace: string,
  files: string[],
  maxFiles = 10,
  maxLines = 120
): string {
  const sections: string[] = [];
  for (const file of files.slice(0, maxFiles)) {
    try {
      const content = readFileSync(join(workspace, file), "utf8");
      const lines = content.split("\n").slice(0, maxLines);
      const suffix = content.split("\n").length > maxLines ? "\n…(truncated)" : "";
      sections.push(`#### ${file}\n\`\`\`\n${lines.join("\n")}${suffix}\n\`\`\``);
    } catch { /* skip unreadable */ }
  }
  return sections.join("\n\n");
}

/** Smart repo context: compact tree + relevant file discovery + excerpts,
 *  guided by task keywords. Produces a much more focused context than
 *  buildRepoContext() for large repositories. */
export function buildSmartRepoContext(
  workspace: string,
  task: string,
  opts: RepoContextOptions = {}
): string {
  const keywords = extractTaskKeywords(task);

  // 1. Compact tree (reduced depth to save tokens)
  const tree = buildTree(workspace, opts.maxDepth ?? 2, opts.maxEntries ?? 100);

  // 2. Find files matching task keywords
  const relevantFiles = findRelevantFiles(workspace, keywords);

  // 3. Read excerpts of the most relevant files
  const excerpts = readExcerpts(workspace, relevantFiles);

  const sections: string[] = [
    "#### File tree" + (tree.truncated ? " (truncated)" : ""),
    "```",
    tree.lines.join("\n") || "(empty)",
    "```",
  ];

  if (relevantFiles.length > 0) {
    sections.push(
      "",
      `#### Files relevant to the task (${relevantFiles.length} matches)`,
      relevantFiles.map((f) => `- ${f}`).join("\n"),
    );
  }

  if (excerpts) {
    sections.push("", "#### Key file excerpts", excerpts);
  }

  const conventions = detectConventions(workspace);
  if (conventions.length > 0) {
    sections.push("", "#### Detected conventions", ...conventions.map((c) => `- ${c}`));
  }

  const readme = readmeExcerpt(workspace, opts.readmeChars ?? 1000);
  if (readme) {
    sections.push("", "#### README excerpt", "```markdown", readme, "```");
  }

  return sections.join("\n");
}

