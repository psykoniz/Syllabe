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

  read(filePath: string): string {
    const start = Date.now();
    try {
      if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
      const content = readFileSync(filePath, "utf8");
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

  edit(filePath: string, oldStr: string, newStr: string): void {
    const start = Date.now();
    try {
      const content = readFileSync(filePath, "utf8");
      const count = content.split(oldStr).length - 1;
      if (count === 0) throw new Error(`String not found in ${filePath}`);
      if (count > 1) throw new Error(`String not unique (${count} occurrences) in ${filePath}`);
      writeFileSync(filePath, content.replace(oldStr, newStr), "utf8");
      this.log("edit", { filePath }, Date.now() - start);
    } catch (e) {
      this.log("edit", { filePath }, Date.now() - start, (e as Error).message);
      throw e;
    }
  }

  glob(pattern: string, baseDir: string): string[] {
    const start = Date.now();
    try {
      const results = globSync(pattern, baseDir);
      this.log("glob", { pattern, baseDir }, Date.now() - start);
      return results;
    } catch (e) {
      this.log("glob", { pattern, baseDir }, Date.now() - start, (e as Error).message);
      throw e;
    }
  }

  grep(pattern: string, filePaths: string[]): Record<string, string[]> {
    const start = Date.now();
    try {
      const re = new RegExp(pattern);
      const results: Record<string, string[]> = {};
      for (const fp of filePaths) {
        if (!existsSync(fp)) continue;
        const lines = readFileSync(fp, "utf8").split("\n");
        const matches = lines.filter((l) => re.test(l));
        if (matches.length > 0) results[fp] = matches;
      }
      this.log("grep", { pattern, fileCount: filePaths.length }, Date.now() - start);
      return results;
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
      if (statSync(full).isDirectory()) {
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
    } else if (statSync(full).isDirectory()) {
      results.push(...walk(full, rest, baseDir));
    }
  }
  return results;
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
