import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { GlobalMemory, projectKeyFor } from "./global-memory";
import type { Lesson } from "./lesson-curator";

function lesson(trigger: string, content: string, approved = true): Lesson {
  return {
    id: crypto.randomUUID(),
    trigger,
    content,
    createdAt: new Date().toISOString(),
    runId: "r1",
    approved,
  };
}

describe("GlobalMemory", () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "gmem-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("appends and matches project lessons", () => {
    const mem = new GlobalMemory({ root, project: "syllabe" });
    mem.appendLesson(lesson("typescript", "Prefer bun test over jest"), "project");
    const hits = mem.matching("fix the TypeScript build");
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain("bun test");
  });

  it("project lessons come before global ones", () => {
    const mem = new GlobalMemory({ root, project: "syllabe" });
    mem.appendLesson(lesson("api", "global advice"), "global");
    mem.appendLesson(lesson("api", "project advice"), "project");
    const hits = mem.matching("build the api");
    expect(hits[0].content).toBe("project advice");
    expect(hits[1].content).toBe("global advice");
  });

  it("ignores unapproved lessons and respects limit", () => {
    const mem = new GlobalMemory({ root, project: "p" });
    mem.appendLesson(lesson("x", "no", false), "project");
    for (let i = 0; i < 15; i++) mem.appendLesson(lesson("x", `l${i}`), "project");
    const hits = mem.matching("x marks the spot", 5);
    expect(hits).toHaveLength(5);
    expect(hits.every((l) => l.content !== "no")).toBe(true);
  });

  it("isolates projects", () => {
    const a = new GlobalMemory({ root, project: "a" });
    const b = new GlobalMemory({ root, project: "b" });
    a.appendLesson(lesson("topic", "for a"), "project");
    expect(b.matching("topic")).toHaveLength(0);
  });

  it("toContextBlock renders matched lessons", () => {
    const mem = new GlobalMemory({ root, project: "p" });
    mem.appendLesson(lesson("docker", "Use slim images"), "project");
    expect(mem.toContextBlock("setup docker")).toContain("Use slim images");
    expect(mem.toContextBlock("unrelated")).toBe("");
  });
});

describe("projectKeyFor", () => {
  it("uses git remote repo name when available", () => {
    const dir = mkdtempSync(join(tmpdir(), "pk-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: dir });
      spawnSync("git", ["remote", "add", "origin", "https://github.com/org/MyRepo.git"], { cwd: dir });
      expect(projectKeyFor(dir)).toBe("myrepo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to directory basename", () => {
    const dir = mkdtempSync(join(tmpdir(), "pk2-"));
    try {
      const sub = join(dir, "CoolProject");
      mkdirSync(sub);
      expect(projectKeyFor(sub)).toBe("coolproject");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
