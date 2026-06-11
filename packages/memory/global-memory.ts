import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync } from "fs";
import { join, dirname, basename, resolve } from "path";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import type { Lesson } from "./lesson-curator";

/** Stable namespace key for a workspace: the git remote repo name when
 *  available, else the directory basename, else a short hash of the path. */
export function projectKeyFor(workspace: string): string {
  const remote = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: workspace,
    encoding: "utf8",
  });
  if (remote.status === 0 && remote.stdout.trim()) {
    const name = remote.stdout.trim().split("/").pop()?.replace(/\.git$/, "");
    if (name) return name.toLowerCase();
  }
  try {
    if (statSync(workspace).isDirectory()) {
      const base = basename(resolve(workspace));
      // Workspace dirs named by run id (UUIDs) are not stable namespaces
      if (!/^[0-9a-f-]{36}$/.test(base)) return base.toLowerCase();
    }
  } catch {
    // fall through to hash
  }
  return createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 12);
}

export interface GlobalMemoryOptions {
  /** Storage root (default ~/.projectos/memory) */
  root?: string;
  /** Project namespace (use projectKeyFor) */
  project: string;
}

/** Cross-run, cross-workspace lesson store. Lessons survive fresh clones:
 *  - global:  <root>/lessons.jsonl
 *  - project: <root>/projects/<project>/lessons.jsonl */
export class GlobalMemory {
  private root: string;
  private project: string;

  constructor(opts: GlobalMemoryOptions) {
    this.root =
      opts.root ??
      join(process.env.HOME ?? "~", ".projectos", "memory");
    this.project = opts.project;
  }

  private pathFor(scope: "global" | "project"): string {
    return scope === "global"
      ? join(this.root, "lessons.jsonl")
      : join(this.root, "projects", this.project, "lessons.jsonl");
  }

  appendLesson(lesson: Lesson, scope: "global" | "project" = "project"): void {
    const p = this.pathFor(scope);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(lesson) + "\n", "utf8");
  }

  private readScope(scope: "global" | "project"): Lesson[] {
    const p = this.pathFor(scope);
    if (!existsSync(p)) return [];
    const lessons: Lesson[] = [];
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        lessons.push(JSON.parse(line) as Lesson);
      } catch {
        // skip malformed lines
      }
    }
    return lessons;
  }

  /** Approved lessons whose trigger appears in the topic text —
   *  project-scoped lessons first, then global, deduplicated by id. */
  matching(topic: string, limit = 10): Lesson[] {
    const lower = topic.toLowerCase();
    const seen = new Set<string>();
    const out: Lesson[] = [];
    for (const scope of ["project", "global"] as const) {
      for (const l of this.readScope(scope)) {
        if (!l.approved || seen.has(l.id)) continue;
        if (!lower.includes(l.trigger.toLowerCase())) continue;
        seen.add(l.id);
        out.push(l);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  toContextBlock(topic: string): string {
    const matched = this.matching(topic);
    if (matched.length === 0) return "";
    const lines = ["## Lessons from past runs\n"];
    for (const l of matched) {
      lines.push(`- **[${l.trigger}]** ${l.content}`);
    }
    return lines.join("\n") + "\n";
  }
}
