import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FsTools, findNormalizedMatch } from "./fs-tools";

const TMP = join(tmpdir(), "projectos-fs-test");
const LOG = join(TMP, "tool-calls.jsonl");

function makeTools() {
  return new FsTools({ logPath: LOG });
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  if (existsSync(LOG)) rmSync(LOG);
});
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("read", () => {
  it("returns file content", () => {
    const fp = join(TMP, "hello.txt");
    writeFileSync(fp, "world");
    expect(makeTools().read(fp)).toBe("world");
  });

  it("throws on missing file", () => {
    expect(() => makeTools().read(join(TMP, "nope.txt"))).toThrow("File not found");
  });

  it("logs the call", () => {
    const fp = join(TMP, "a.txt");
    writeFileSync(fp, "x");
    makeTools().read(fp);
    const log = readFileSync(LOG, "utf8").trim();
    expect(JSON.parse(log).tool).toBe("read");
    expect(JSON.parse(log).result).toBe("ok");
  });
});

describe("write", () => {
  it("creates a new file", () => {
    const fp = join(TMP, "new.txt");
    makeTools().write(fp, "content");
    expect(readFileSync(fp, "utf8")).toBe("content");
  });

  it("refuses to overwrite without flag", () => {
    const fp = join(TMP, "existing.txt");
    makeTools().write(fp, "v1");
    expect(() => makeTools().write(fp, "v2")).toThrow("already exists");
  });

  it("overwrites when flag is set", () => {
    const fp = join(TMP, "over.txt");
    makeTools().write(fp, "v1");
    makeTools().write(fp, "v2", { overwrite: true });
    expect(readFileSync(fp, "utf8")).toBe("v2");
  });

  it("creates parent directories", () => {
    const fp = join(TMP, "deep/nested/file.txt");
    makeTools().write(fp, "hi");
    expect(existsSync(fp)).toBe(true);
  });
});

describe("edit", () => {
  it("replaces exact string", () => {
    const fp = join(TMP, "edit.txt");
    makeTools().write(fp, "hello world");
    makeTools().edit(fp, "world", "there");
    expect(readFileSync(fp, "utf8")).toBe("hello there");
  });

  it("throws when string not found", () => {
    const fp = join(TMP, "edit2.txt");
    makeTools().write(fp, "foo bar");
    expect(() => makeTools().edit(fp, "baz", "x")).toThrow("not found");
  });

  it("throws when string not unique", () => {
    const fp = join(TMP, "edit3.txt");
    makeTools().write(fp, "ab ab");
    expect(() => makeTools().edit(fp, "ab", "cd")).toThrow("not unique");
  });
});

describe("glob", () => {
  it("finds files matching pattern", () => {
    mkdirSync(join(TMP, "src"), { recursive: true });
    writeFileSync(join(TMP, "src/a.ts"), "");
    writeFileSync(join(TMP, "src/b.ts"), "");
    writeFileSync(join(TMP, "src/c.js"), "");
    const results = makeTools().glob("src/*.ts", TMP);
    expect(results.files).toHaveLength(2);
    expect(results.files.every((r) => r.endsWith(".ts"))).toBe(true);
    expect(results.truncated).toBe(false);
  });

  it("finds files recursively with **", () => {
    mkdirSync(join(TMP, "a/b"), { recursive: true });
    writeFileSync(join(TMP, "a/x.ts"), "");
    writeFileSync(join(TMP, "a/b/y.ts"), "");
    const results = makeTools().glob("**/*.ts", TMP);
    expect(results.files.length).toBeGreaterThanOrEqual(2);
  });
});

describe("grep", () => {
  it("returns matching lines per file", () => {
    const fp = join(TMP, "grep.txt");
    makeTools().write(fp, "foo\nbar\nbaz foo");
    const results = makeTools().grep("foo", [fp]);
    expect(results.matches).toHaveLength(2);
    expect(results.matches[0].line).toBe(1);
    expect(results.matches[1].line).toBe(3);
  });

  it("returns empty object when no matches", () => {
    const fp = join(TMP, "nope.txt");
    makeTools().write(fp, "abc\ndef");
    const results = makeTools().grep("xyz", [fp]);
    expect(results.matches).toHaveLength(0);
  });

  it("skips missing files silently", () => {
    const results = makeTools().grep("x", [join(tmpdir(), "does-not-exist-ever.txt")]);
    expect(results.matches).toHaveLength(0);
  });
});

describe("edit upgrades", () => {
  it("replace_all replaces every occurrence", () => {
    const fp = join(TMP, "ra.txt");
    makeTools().write(fp, "foo bar foo baz foo");
    const r = makeTools().edit(fp, "foo", "qux", { replaceAll: true });
    expect(r.replacements).toBe(3);
    expect(readFileSync(fp, "utf8")).toBe("qux bar qux baz qux");
  });

  it("falls back to whitespace-normalized match", () => {
    const fp = join(TMP, "ws.ts");
    makeTools().write(fp, "function a() {\n\t\treturn 1;\n}\n");
    // caller uses 4 spaces instead of the file's tabs
    const r = makeTools().edit(fp, "function a() {\n    return 1;\n}", "function a() {\n    return 2;\n}");
    expect(r.matchedVia).toBe("whitespace-normalized");
    expect(readFileSync(fp, "utf8")).toContain("return 2;");
  });

  it("rejects ambiguous normalized matches", () => {
    const fp = join(TMP, "amb.txt");
    makeTools().write(fp, "  x = 1;\n\tx = 1;\n");
    expect(() => makeTools().edit(fp, "x = 1 ;", "x = 2;")).toThrow(/not found/i);
    // two normalized candidates for the same content
    expect(() => makeTools().edit(fp, "    x = 1;", "x = 2;")).toThrow(/ambiguous/);
  });

  it("reports near-miss line numbers when not found", () => {
    const fp = join(TMP, "near.txt");
    makeTools().write(fp, "alpha\n  needle();\nbeta\n");
    expect(() => makeTools().edit(fp, "needle();\nmissing();", "thread();")).toThrow(/Near misses at lines: 2/);
  });

  it("lists occurrence lines when not unique", () => {
    const fp = join(TMP, "multi.txt");
    makeTools().write(fp, "dup\nx\ndup\n");
    expect(() => makeTools().edit(fp, "dup", "one")).toThrow(/lines: 1, 3/);
  });
});

describe("findNormalizedMatch", () => {
  it("finds a window ignoring leading whitespace", () => {
    const hits = findNormalizedMatch(["  a", "\tb", "c"], ["a", "b"]);
    expect(hits).toEqual([{ start: 0, count: 2 }]);
  });

  it("returns all candidate windows", () => {
    const hits = findNormalizedMatch(["x", "x"], ["x"]);
    expect(hits).toHaveLength(2);
  });
});

describe("glob/grep caps", () => {
  it("glob caps results and flags truncation", () => {
    const dir = join(TMP, "many");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, `f${String(i).padStart(2, "0")}.txt`), "");
    const r = makeTools().glob("many/*.txt", TMP, { limit: 5 });
    expect(r.files).toHaveLength(5);
    expect(r.truncated).toBe(true);
    expect(r.files).toEqual([...r.files].sort());
  });

  it("grep caps matches and flags truncation", () => {
    const fp = join(TMP, "big.txt");
    makeTools().write(fp, Array.from({ length: 20 }, () => "hit").join("\n"));
    const r = makeTools().grep("hit", [fp], { maxMatches: 5 });
    expect(r.matches).toHaveLength(5);
    expect(r.truncated).toBe(true);
  });

  it("grep returns context lines", () => {
    const fp = join(TMP, "ctx.txt");
    makeTools().write(fp, "before\nmatch\nafter");
    const r = makeTools().grep("match", [fp], { contextLines: 1 });
    expect(r.matches[0].context).toEqual([
      { line: 1, text: "before" },
      { line: 3, text: "after" },
    ]);
  });
});
