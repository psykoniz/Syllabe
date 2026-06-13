import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "fs";
import { dirname, join, resolve, relative } from "path";
import { logToolCall } from "../tool-logger";

export interface FsToolsOptions {
  logPath: string;
}

export interface EditOptions {
  replaceAll?: boolean;
}

export interface EditResult {
  replacements: number;
  matchedVia: "exact" | "whitespace-normalized";
}

export interface GlobResult {
  files: string[];
  truncated: boolean;
}

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
  context?: Array<{ line: number; text: string }>;
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
  /** Requested paths that did not exist — surfaced so the caller is not misled
   *  into believing a search returned no matches when the file was simply absent. */
  missingFiles: string[];
}

export interface ReadOptions {
  /** 1-indexed first line to return (inclusive) */
  startLine?: number;
  /** 1-indexed last line to return (inclusive) */
  endLine?: number;
}

const GLOB_DEFAULT_LIMIT = 500;
const GREP_DEFAULT_MAX_MATCHES = 200;

/** Locate windows of `oldLines` inside `contentLines` comparing with leading
 *  whitespace stripped per line. Pure — exported for tests. */
export function findNormalizedMatch(
  contentLines: string[],
  oldLines: string[]
): Array<{ start: number; count: number }> {
  const norm = (l: string) => l.replace(/^\s+/, "");
  const target = oldLines.map(norm);
  const hits: Array<{ start: number; count: number }> = [];
  outer: for (let i = 0; i + target.length <= contentLines.length; i++) {
    for (let j = 0; j < target.length; j++) {
      if (norm(contentLines[i + j]) !== target[j]) continue outer;
    }
    hits.push({ start: i, count: target.length });
  }
  return hits;
}

function timed<T>(fn: () => T): { value: T; durationMs: number } {
  const start = Date.now();
  const value = fn();
  return { value, durationMs: Date.now() - start };
}

export class FsTools {
  constructor(private opts: FsToolsOptions) {}

  private log(tool: string, args: Record<string, unknown>, durationMs: number, error?: string) {
    logToolCall(this.opts.logPath, {
      ts: new Date().toISOString(),
      tool,
      args,
      result: error ? "error" : "ok",
      durationMs,
      error,
    });
  }

  read(filePath: string, opts: ReadOptions = {}): string {
    const start = Date.now();
    try {
      if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
      const content = readFileSync(filePath, "utf8");
      // Optional line-range slice so the agent can target a region of a large
      // file instead of pulling the whole thing (10k-line source files are
      // common on real repos). 1-indexed, inclusive on both ends.
      if (opts.startLine !== undefined || opts.endLine !== undefined) {
        const lines = content.split("\n");
        const from = Math.max(1, opts.startLine ?? 1);
        const to = Math.min(lines.length, opts.endLine ?? lines.length);
        const slice = lines.slice(from - 1, to);
        // Prefix each line with its real number so edits stay anchored.
        const numbered = slice.map((l, i) => `${from + i}\t${l}`).join("\n");
        this.log("read", { filePath, startLine: from, endLine: to }, Date.now() - start);
        return numbered;
      }
      this.log("read", { filePath }, Date.now() - start);
      return content;
    } catch (e) {
      const msg = (e as Error).message;
      this.log("read", { filePath }, Date.now() - start, msg);
      throw e;
    }
  }

  write(filePath: string, content: string, opts: { overwrite?: boolean } = {}): void {
    const start = Date.now();
    try {
      if (!opts.overwrite && existsSync(filePath)) {
        throw new Error(`File already exists (use overwrite:true): ${filePath}`);
      }
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf8");
      this.log("write", { filePath, overwrite: opts.overwrite ?? false }, Date.now() - start);
    } catch (e) {
      this.log("write", { filePath }, Date.now() - start, (e as Error).message);
      throw e;
    }
  }

  edit(filePath: string, oldStr: string, newStr: string, opts: EditOptions = {}): EditResult {
    const start = Date.now();
    try {
      const content = readFileSync(filePath, "utf8");
      const count = content.split(oldStr).length - 1;

      if (opts.replaceAll && count > 0) {
        writeFileSync(filePath, content.split(oldStr).join(newStr), "utf8");
        this.log("edit", { filePath, replaceAll: true, replacements: count }, Date.now() - start);
        return { replacements: count, matchedVia: "exact" };
      }

      if (count === 1) {
        writeFileSync(filePath, content.replace(oldStr, newStr), "utf8");
        this.log("edit", { filePath }, Date.now() - start);
        return { replacements: 1, matchedVia: "exact" };
      }

      const lines = content.split("\n");

      if (count > 1) {
        const hitLines: number[] = [];
        const firstOld = oldStr.split("\n")[0];
        lines.forEach((l, i) => { if (l.includes(firstOld)) hitLines.push(i + 1); });
        throw new Error(
          `String not unique (${count} occurrences) in ${filePath}` +
          (hitLines.length > 0 ? ` — at lines: ${hitLines.slice(0, 10).join(", ")}` : "") +
          `. Add surrounding context or use replace_all.`
        );
      }

      // 0 exact matches — whitespace-normalized retry
      const oldLines = oldStr.split("\n");
      const windows = findNormalizedMatch(lines, oldLines);
      if (windows.length === 1) {
        const { start: ws, count: wc } = windows[0];
        // Re-indent newStr by the leading-whitespace delta of the first line
        const fileIndent = lines[ws].match(/^\s*/)?.[0] ?? "";
        const oldIndent = oldLines[0].match(/^\s*/)?.[0] ?? "";
        const newLines = newStr.split("\n").map((l) => {
          if (l.startsWith(oldIndent)) return fileIndent + l.slice(oldIndent.length);
          return l;
        });
        lines.splice(ws, wc, ...newLines);
        writeFileSync(filePath, lines.join("\n"), "utf8");
        this.log("edit", { filePath, matchedVia: "whitespace-normalized" }, Date.now() - start);
        return { replacements: 1, matchedVia: "whitespace-normalized" };
      }
      if (windows.length > 1) {
        throw new Error(
          `String not found exactly, and whitespace-normalized match is ambiguous ` +
          `(${windows.length} candidates at lines: ${windows.map((w) => w.start + 1).join(", ")}) in ${filePath}`
        );
      }

      // No match at all — point at near misses
      const norm = (l: string) => l.replace(/^\s+/, "");
      const firstTarget = norm(oldLines.find((l) => norm(l).length > 0) ?? "");
      const nearMisses: number[] = [];
      if (firstTarget) {
        lines.forEach((l, i) => { if (norm(l) === firstTarget) nearMisses.push(i + 1); });
      }
      throw new Error(
        `String not found in ${filePath}.` +
        (nearMisses.length > 0
          ? ` Near misses at lines: ${nearMisses.slice(0, 10).join(", ")} (check whitespace).`
          : "")
      );
    } catch (e) {
      this.log("edit", { filePath }, Date.now() - start, (e as Error).message);
      throw e;
    }
  }

  glob(pattern: string, baseDir: string, opts: { limit?: number } = {}): GlobResult {
    const start = Date.now();
    const limit = opts.limit ?? GLOB_DEFAULT_LIMIT;
    try {
      const all = globSync(pattern, baseDir).sort();
      const truncated = all.length > limit;
      const files = truncated ? all.slice(0, limit) : all;
      this.log("glob", { pattern, baseDir, found: all.length, truncated }, Date.now() - start);
      return { files, truncated };
    } catch (e) {
      this.log("glob", { pattern, baseDir }, Date.now() - start, (e as Error).message);
      throw e;
    }
  }

  grep(
    pattern: string,
    filePaths: string[],
    opts: { contextLines?: number; maxMatches?: number } = {}
  ): GrepResult {
    const start = Date.now();
    const maxMatches = opts.maxMatches ?? GREP_DEFAULT_MAX_MATCHES;
    const contextLines = opts.contextLines ?? 0;
    try {
      const re = new RegExp(pattern);
      const matches: GrepMatch[] = [];
      const missingFiles: string[] = [];
      let truncated = false;
      outer: for (const fp of filePaths) {
        if (!existsSync(fp)) {
          missingFiles.push(fp);
          continue;
        }
        const lines = readFileSync(fp, "utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          if (matches.length >= maxMatches) {
            truncated = true;
            break outer;
          }
          const m: GrepMatch = { file: fp, line: i + 1, text: lines[i] };
          if (contextLines > 0) {
            m.context = [];
            for (let c = Math.max(0, i - contextLines); c <= Math.min(lines.length - 1, i + contextLines); c++) {
              if (c !== i) m.context.push({ line: c + 1, text: lines[c] });
            }
          }
          matches.push(m);
        }
      }
      this.log("grep", { pattern, fileCount: filePaths.length, matchCount: matches.length, truncated, missing: missingFiles.length }, Date.now() - start);
      return { matches, truncated, missingFiles };
    } catch (e) {
      this.log("grep", { pattern }, Date.now() - start, (e as Error).message);
      throw e;
    }
  }
}

// Minimal recursive glob — supports * and ** patterns
function globSync(pattern: string, baseDir: string): string[] {
  const parts = pattern.split("/");
  return walk(baseDir, parts, baseDir);
}

function walk(dir: string, parts: string[], baseDir: string): string[] {
  if (parts.length === 0) return [];
  const [head, ...rest] = parts;
  const results: string[] = [];

  if (head === "**") {
    // match zero levels (skip **)
    results.push(...walk(dir, rest, baseDir));
    // match one or more levels
    for (const entry of safeReaddir(dir)) {
      const full = join(dir, entry);
      if (safeIsDirectory(full)) {
        results.push(...walk(full, parts, baseDir));
      }
    }
    return results;
  }

  const re = new RegExp("^" + head.replace(/\./g, "\\.").replace(/\*/g, "[^/]*") + "$");
  for (const entry of safeReaddir(dir)) {
    if (!re.test(entry)) continue;
    const full = join(dir, entry);
    if (rest.length === 0) {
      results.push(relative(baseDir, full));
    } else if (safeIsDirectory(full)) {
      results.push(...walk(full, rest, baseDir));
    }
  }
  return results;
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/** statSync that tolerates a file vanishing between readdir and stat (a real
 *  race on large, churning trees) instead of throwing and aborting the glob. */
function safeIsDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
