import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { FsTools } from "./fs-tools";

const TMP = "/tmp/projectos-fs-test";
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
    Bun.write(fp, "world");
    expect(makeTools().read(fp)).toBe("world");
  });

  it("throws on missing file", () => {
    expect(() => makeTools().read(join(TMP, "nope.txt"))).toThrow("File not found");
  });

  it("logs the call", () => {
    const fp = join(TMP, "a.txt");
    Bun.write(fp, "x");
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
    Bun.write(join(TMP, "src/a.ts"), "");
    Bun.write(join(TMP, "src/b.ts"), "");
    Bun.write(join(TMP, "src/c.js"), "");
    const results = makeTools().glob("src/*.ts", TMP);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.endsWith(".ts"))).toBe(true);
  });

  it("finds files recursively with **", () => {
    mkdirSync(join(TMP, "a/b"), { recursive: true });
    Bun.write(join(TMP, "a/x.ts"), "");
    Bun.write(join(TMP, "a/b/y.ts"), "");
    const results = makeTools().glob("**/*.ts", TMP);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });
});

describe("grep", () => {
  it("returns matching lines per file", () => {
    const fp = join(TMP, "grep.txt");
    makeTools().write(fp, "foo\nbar\nbaz foo");
    const results = makeTools().grep("foo", [fp]);
    expect(results[fp]).toHaveLength(2);
  });

  it("returns empty object when no matches", () => {
    const fp = join(TMP, "nope.txt");
    makeTools().write(fp, "abc\ndef");
    const results = makeTools().grep("xyz", [fp]);
    expect(Object.keys(results)).toHaveLength(0);
  });

  it("skips missing files silently", () => {
    const results = makeTools().grep("x", ["/tmp/does-not-exist-ever.txt"]);
    expect(Object.keys(results)).toHaveLength(0);
  });
});
