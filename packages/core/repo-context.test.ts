import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { redactGitUrl, buildRepoContext, buildRepoTree, findRelevantFiles, relevantDirTree } from "./repo-context";

describe("redactGitUrl", () => {
  it("strips user:token from https URLs", () => {
    expect(redactGitUrl("https://user:tok123@github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git"
    );
  });

  it("strips bare token userinfo", () => {
    expect(redactGitUrl("https://tok123@github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git"
    );
  });

  it("leaves clean https URLs untouched", () => {
    expect(redactGitUrl("https://github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git"
    );
  });

  it("leaves local paths untouched", () => {
    expect(redactGitUrl("/home/user/myrepo")).toBe("/home/user/myrepo");
    expect(redactGitUrl("../relative/repo")).toBe("../relative/repo");
  });

  it("strips password from scp-like syntax, keeps user@host", () => {
    expect(redactGitUrl("git:secret@github.com:org/repo.git")).toBe(
      "git@github.com:org/repo.git"
    );
    expect(redactGitUrl("git@github.com:org/repo.git")).toBe(
      "git@github.com:org/repo.git"
    );
  });
});

describe("buildRepoContext", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "repo-ctx-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("includes file tree, skips ignored dirs", () => {
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "src", "index.ts"), "export {}");
    const ctx = buildRepoContext(dir);
    expect(ctx).toContain("src/");
    expect(ctx).toContain("index.ts");
    expect(ctx).not.toContain("node_modules");
    expect(ctx).not.toContain(".git");
  });

  it("caps tree entries and flags truncation", () => {
    for (let i = 0; i < 30; i++) writeFileSync(join(dir, `f${String(i).padStart(2, "0")}.txt`), "");
    const ctx = buildRepoContext(dir, { maxEntries: 10 });
    expect(ctx).toContain("first 10 entries");
  });

  it("truncates long READMEs", () => {
    writeFileSync(join(dir, "README.md"), "x".repeat(5000));
    const ctx = buildRepoContext(dir, { readmeChars: 100 });
    expect(ctx).toContain("…(truncated)");
    expect(ctx).toContain("README excerpt");
  });

  it("detects conventions from package.json and test files", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "bun test" }, workspaces: ["pkgs/*"] })
    );
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    writeFileSync(join(dir, "util.test.ts"), "");
    const ctx = buildRepoContext(dir);
    expect(ctx).toContain("Package name: demo");
    expect(ctx).toContain("Monorepo workspaces: pkgs/*");
    expect(ctx).toContain("TypeScript project");
    expect(ctx).toContain("*.test.* files colocated with sources");
  });
});

describe("findRelevantFiles", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "relevant-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("finds Python source files matching a keyword (was JS/TS-only)", () => {
    mkdirSync(join(dir, "astropy", "modeling"), { recursive: true });
    writeFileSync(join(dir, "astropy", "modeling", "separable.py"), "def separability_matrix():\n    pass\n");
    const files = findRelevantFiles(dir, ["separability"]);
    expect(files).toContain("astropy/modeling/separable.py");
  });

  it("finds Go and Rust sources too", () => {
    writeFileSync(join(dir, "main.go"), "package main // widget");
    writeFileSync(join(dir, "lib.rs"), "// widget impl");
    const files = findRelevantFiles(dir, ["widget"]);
    expect(files).toContain("main.go");
    expect(files).toContain("lib.rs");
  });
});

describe("relevantDirTree", () => {
  it("renders ancestor dirs as a nested sub-tree", () => {
    const out = relevantDirTree([
      "astropy/modeling/separable.py",
      "astropy/modeling/core.py",
      "django/forms/fields.py",
    ]);
    expect(out).toContain("astropy/");
    expect(out).toContain("  modeling/");
    expect(out).toContain("    separable.py");
    expect(out).toContain("    core.py");
    expect(out).toContain("django/");
    expect(out).toContain("    fields.py");
  });

  it("is empty for no files", () => {
    expect(relevantDirTree([])).toBe("");
  });
});

describe("buildRepoTree", () => {
  it("returns tree only, no README section", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-tree-"));
    try {
      writeFileSync(join(dir, "README.md"), "# Hello");
      writeFileSync(join(dir, "a.ts"), "");
      const tree = buildRepoTree(dir);
      expect(tree).toContain("a.ts");
      expect(tree).not.toContain("README excerpt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
