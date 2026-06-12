import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { GitTools } from "./git-tools";

const TMP = join(tmpdir(), "projectos-git-test");
const LOG = join(TMP, "tool-calls.jsonl");
const REPO = join(TMP, "repo");

function git(args: string[]) {
  return spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
}

function makeTools() {
  return new GitTools({ logPath: LOG, repoPath: REPO });
}

beforeEach(() => {
  mkdirSync(REPO, { recursive: true });
  git(["init"]);
  git(["config", "user.email", "test@test.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "gpg.format", "openpgp"]);
});

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("GitTools.status", () => {
  it("returns empty string on clean repo", () => {
    // need at least one commit for status to work cleanly
    writeFileSync(join(REPO, "init.txt"), "init");
    git(["add", "."]);
    git(["commit", "-m", "init"]);
    const status = makeTools().status();
    expect(status).toBe("");
  });

  it("shows untracked file", () => {
    writeFileSync(join(REPO, "init.txt"), "init");
    git(["add", "."]);
    git(["commit", "-m", "init"]);
    writeFileSync(join(REPO, "new.txt"), "hello");
    const status = makeTools().status();
    expect(status).toContain("new.txt");
  });
});

describe("GitTools.diff", () => {
  it("returns empty diff on clean repo", () => {
    writeFileSync(join(REPO, "a.txt"), "v1");
    git(["add", "."]);
    git(["commit", "-m", "init"]);
    expect(makeTools().diff()).toBe("");
  });

  it("shows unstaged changes", () => {
    writeFileSync(join(REPO, "a.txt"), "v1");
    git(["add", "."]);
    git(["commit", "-m", "init"]);
    writeFileSync(join(REPO, "a.txt"), "v2");
    expect(makeTools().diff()).toContain("v2");
  });
});

describe("GitTools.commit", () => {
  it("stages and commits provided files", () => {
    writeFileSync(join(REPO, "a.txt"), "hello");
    const result = makeTools().commit(["a.txt"], "add a.txt");
    expect(result.sha).toHaveLength(40);
    expect(result.message).toBe("add a.txt");
    expect(git(["log", "--oneline"]).stdout).toContain("add a.txt");
  });

  it("logs the commit call", () => {
    writeFileSync(join(REPO, "b.txt"), "world");
    makeTools().commit(["b.txt"], "add b");
    const log = Bun.file(LOG);
    expect(log).toBeTruthy();
  });
});

describe("GitTools.clone / branches / diffRange", () => {
  const DEST = join(TMP, "clone-dest");

  function seedSourceRepo() {
    writeFileSync(join(REPO, "main.ts"), "export const x = 1;\n");
    git(["add", "."]);
    git(["commit", "-m", "init"]);
    git(["branch", "-M", "main"]);
  }

  it("clones into a non-empty dir and redacts the persisted remote", () => {
    seedSourceRepo();
    mkdirSync(join(DEST, ".agent"), { recursive: true });
    GitTools.clone(REPO, DEST, "main");
    const head = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: DEST, encoding: "utf8",
    }).stdout.trim();
    expect(head).toBe("main");
    const remote = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: DEST, encoding: "utf8",
    }).stdout.trim();
    expect(remote).not.toContain("token");
  });

  it("throws a redacted error on a bad source", () => {
    mkdirSync(DEST, { recursive: true });
    expect(() => GitTools.clone("/nonexistent/repo-xyz", DEST, "main")).toThrow(/fetch failed/);
  });

  it("createBranch + currentBranch", () => {
    seedSourceRepo();
    const tools = makeTools();
    tools.createBranch("projectos/run-abc123");
    expect(tools.currentBranch()).toBe("projectos/run-abc123");
  });

  it("diffRange includes committed and uncommitted changes", () => {
    seedSourceRepo();
    const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim();
    const tools = makeTools();
    tools.createBranch("work");
    writeFileSync(join(REPO, "feature.ts"), "export const y = 2;\n");
    git(["add", "."]);
    git(["commit", "-m", "add feature"]);
    writeFileSync(join(REPO, "main.ts"), "export const x = 42;\n");
    const diff = tools.diffRange(base);
    expect(diff).toContain("feature.ts");
    expect(diff).toContain("x = 42");
  });
});
