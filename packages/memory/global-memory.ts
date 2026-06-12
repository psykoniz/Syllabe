import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync } from "fs";
import { join, dirname, basename, resolve } from "path";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import type { Lesson } from "./lesson-curator";
import { createSemanticIndex } from "./embeddings";
import type { SemanticIndex } from "./embeddings";

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
  /** Enable semantic search via embeddings (auto-detected from env) */
  enableSemanticSearch?: boolean;
}

/** Cross-run, cross-workspace lesson store. Lessons survive fresh clones:
 *  - global:  <root>/lessons.jsonl
 *  - project: <root>/projects/<project>/lessons.jsonl
 *
 *  When PROJECTOS_EMBEDDINGS_API_KEY is set, lessons are also indexed in a
 *  vector store for semantic (meaning-based) retrieval instead of substring
 *  matching. */
export class GlobalMemory {
  private root: string;
  private project: string;
  private semanticIndex: SemanticIndex | null = null;

  constructor(opts: GlobalMemoryOptions) {
    this.root =
      opts.root ??
      join(process.env.HOME ?? "~", ".projectos", "memory");
    this.project = opts.project;

    // Lazy-init semantic index when embeddings are available
    if (opts.enableSemanticSearch !== false) {
      try {
        const indexPath = join(this.root, "projects", this.project, "vectors.json");
        this.semanticIndex = createSemanticIndex(indexPath);
      } catch {
        // embeddings not available — substring matching will be used
      }
    }
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

    // Index for semantic search (best-effort, fire-and-forget)
    if (this.semanticIndex && lesson.approved && lesson.trigger && lesson.content) {
      this.semanticIndex
        .upsert(lesson.id, `${lesson.trigger}: ${lesson.content}`, {
          scope,
          runId: lesson.runId,
        })
        .catch(() => {});
    }
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
   *  project-scoped lessons first, then global, deduplicated by id.
   *  This is the original substring-matching method (still used as fallback). */
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

  /** Semantic search: find lessons by meaning similarity rather than exact
   *  substring match. Falls back to matching() when embeddings are not
   *  configured. Returns lessons sorted by semantic relevance. */
  async matchingSemantic(topic: string, limit = 10): Promise<Lesson[]> {
    if (!this.semanticIndex || this.semanticIndex.size === 0) {
      return this.matching(topic, limit);
    }

    try {
      const results = await this.semanticIndex.search(topic, limit * 2);
      const matchedIds = new Set(
        results
          .filter((r) => r.score > 0.3)  // minimum similarity threshold
          .map((r) => r.id)
      );

      if (matchedIds.size === 0) return this.matching(topic, limit);

      const allLessons = [
        ...this.readScope("project"),
        ...this.readScope("global"),
      ];
      const seen = new Set<string>();
      return allLessons
        .filter((l) => {
          if (!l.approved || seen.has(l.id) || !matchedIds.has(l.id)) return false;
          seen.add(l.id);
          return true;
        })
        .slice(0, limit);
    } catch {
      // Semantic search failed — fall back to substring matching
      return this.matching(topic, limit);
    }
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

  /** Async variant of toContextBlock that uses semantic search when available. */
  async toSemanticContextBlock(topic: string): Promise<string> {
    const matched = await this.matchingSemantic(topic);
    if (matched.length === 0) return "";
    const lines = ["## Lessons from past runs\n"];
    for (const l of matched) {
      lines.push(`- **[${l.trigger}]** ${l.content}`);
    }
    return lines.join("\n") + "\n";
  }
}

