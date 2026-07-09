import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { redactGitUrl, buildRepoContext, buildRepoTree, findRelevantFiles, relevantDirTree, extractSignatures, buildRepoMap, extractImports, resolveImport, pageRank, rankRepoFiles } from "./repo-context";
import { parseImplementationPlan, isBugFixTask, parseVerdict, capHandoff } from "./project-run";

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

describe("extractSignatures", () => {
  it("extracts TypeScript exports", () => {
    const src = `export function foo(a: string): void {}\nexport class Bar {}\nconst x = 1;\n`;
    const sigs = extractSignatures("foo.ts", src);
    expect(sigs.some((s) => s.includes("foo"))).toBe(true);
    expect(sigs.some((s) => s.includes("Bar"))).toBe(true);
  });

  it("extracts Python defs", () => {
    const src = `def separability_matrix(x):\n    pass\nclass Model:\n    pass\n`;
    const sigs = extractSignatures("sep.py", src);
    expect(sigs.some((s) => s.includes("separability_matrix"))).toBe(true);
    expect(sigs.some((s) => s.includes("Model"))).toBe(true);
  });

  it("returns empty for unknown extension", () => {
    expect(extractSignatures("binary.bin", "abc")).toEqual([]);
  });
});

describe("buildRepoMap", () => {
  it("renders symbol signatures for relevant files", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-map-"));
    try {
      writeFileSync(join(dir, "foo.ts"), `export function greet(name: string) {}\nexport class Greeter {}\n`);
      const map = buildRepoMap(dir, ["foo.ts"]);
      expect(map).toContain("foo.ts:");
      expect(map).toContain("greet");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseImplementationPlan", () => {
  it("parses numbered list", () => {
    const md = `# Plan\n1. Set up project structure\n2. Write the parser\n3. Add tests\n`;
    const units = parseImplementationPlan(md, "fallback");
    expect(units.length).toBe(3);
    expect(units[0].description).toContain("project structure");
  });

  it("parses markdown headers", () => {
    const md = `## Step 1: Create the CLI entry point\n## Step 2: Add argument parsing\n`;
    const units = parseImplementationPlan(md, "fallback");
    expect(units.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to task when plan is empty", () => {
    const units = parseImplementationPlan("", "do the thing");
    expect(units).toEqual([{ id: "wu-1", description: "do the thing" }]);
  });
});

describe("import graph + PageRank ranking", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rank-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("extractImports handles JS/TS and Python", () => {
    expect(extractImports("a.ts", `import { x } from "./util";\nconst y = require("../lib/y");`))
      .toEqual(["./util", "../lib/y"]);
    expect(extractImports("a.py", `from astropy.modeling import core\nimport numpy`))
      .toEqual(["astropy.modeling", "numpy"]);
  });

  it("resolveImport maps relative and dotted specifiers to repo files", () => {
    const files = new Set(["src/util.ts", "astropy/modeling/core.py", "pkg/__init__.py"]);
    expect(resolveImport("./util", "src/main.ts", files)).toBe("src/util.ts");
    expect(resolveImport("astropy.modeling.core", "x.py", files)).toBe("astropy/modeling/core.py");
    expect(resolveImport("pkg", "x.py", files)).toBe("pkg/__init__.py");
    expect(resolveImport("numpy", "x.py", files)).toBeNull();
    expect(resolveImport("@scope/pkg", "src/main.ts", files)).toBeNull();
  });

  it("rankRepoFiles surfaces graph neighbours of the seed files", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    // seed.ts imports helper.ts; unrelated.ts is disconnected
    writeFileSync(join(dir, "src", "seed.ts"), `import { h } from "./helper";\nexport function widget() {}`);
    writeFileSync(join(dir, "src", "helper.ts"), `export function h() {}`);
    writeFileSync(join(dir, "src", "unrelated.ts"), `export function nothing() {}`);
    const ranked = rankRepoFiles(dir, ["src/seed.ts"], 10);
    expect(ranked[0]).toBe("src/seed.ts");
    expect(ranked).toContain("src/helper.ts");
    // helper (connected to the seed) must outrank unrelated (disconnected)
    expect(ranked.indexOf("src/helper.ts")).toBeLessThan(
      ranked.includes("src/unrelated.ts") ? ranked.indexOf("src/unrelated.ts") : Infinity
    );
  });

  it("pageRank concentrates mass on seeds and their neighbours", () => {
    const files = ["a", "b", "c"];
    const edges = new Map([["a", new Set(["b"])]]);
    const rank = pageRank(files, edges, ["a"]);
    expect(rank.get("a")! + rank.get("b")!).toBeGreaterThan(rank.get("c")!);
  });
});

describe("isBugFixTask", () => {
  it("detects bug reports", () => {
    expect(isBugFixTask("separability_matrix does not compute separability correctly for nested CompoundModels")).toBe(true);
    expect(isBugFixTask("Fix the crash when parsing empty config")).toBe(true);
    expect(isBugFixTask("TypeError raised instead of ValueError")).toBe(true);
  });

  it("detects pure creation tasks", () => {
    expect(isBugFixTask("Add a --version flag to the CLI")).toBe(false);
    expect(isBugFixTask("Create a REST API for user management")).toBe(false);
  });

  it("defaults ambiguous tasks to reproduce", () => {
    expect(isBugFixTask("The parser needs updating for the new format")).toBe(true);
  });
});

describe("extractSignatures — bare class methods", () => {
  it("captures unmodified TS class methods and skips control flow", () => {
    const src = [
      "class Runner {",
      "  run(command: string): BashResult {",
      "    if (foo) {",
      "      while (bar) {",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const sigs = extractSignatures("runner.ts", src);
    expect(sigs.some((s) => s.includes("run(command"))).toBe(true);
    expect(sigs.some((s) => s.startsWith("if") || s.startsWith("while"))).toBe(false);
  });
});

describe("parseVerdict", () => {
  it("parses strict VERDICT lines", () => {
    expect(parseVerdict("done.\nVERDICT: PASS", "PASS", "FAIL")).toBe(true);
    expect(parseVerdict("VERDICT: FAIL — two tests red", "PASS", "FAIL")).toBe(false);
    expect(parseVerdict("VERDICT: MUST_FIX\n- issue", "APPROVE", "MUST_FIX")).toBe(false);
    expect(parseVerdict("VERDICT: MUST FIX (spaces)", "APPROVE", "MUST_FIX")).toBe(false);
  });

  it("falls back to keyword scan when the strict form is missing", () => {
    expect(parseVerdict("All 12 tests pass, so I consider this a PASS.", "PASS", "FAIL")).toBe(true);
    expect(parseVerdict("Given the issues above I must say: MUST FIX", "APPROVE", "MUST_FIX")).toBe(false);
    expect(parseVerdict("Everything looks good — APPROVE", "APPROVE", "MUST_FIX")).toBe(true);
  });

  it("returns null when no keyword appears", () => {
    expect(parseVerdict("I wrote some tests.", "PASS", "FAIL")).toBeNull();
  });

  it("uses the LAST keyword when both appear", () => {
    expect(parseVerdict("Earlier attempts would FAIL but now: PASS", "PASS", "FAIL")).toBe(true);
  });
});

describe("capHandoff", () => {
  it("passes short text through trimmed", () => {
    expect(capHandoff("  summary  ")).toBe("summary");
  });
  it("truncates long text with a marker", () => {
    const out = capHandoff("x".repeat(5000));
    expect(out.length).toBeLessThan(2500);
    expect(out).toContain("[... handoff truncated ...]");
  });
});
