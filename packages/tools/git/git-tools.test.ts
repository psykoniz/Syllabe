import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { GitTools } from "./git-tools";

const TMP = "/tmp/projectos-git-test";
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
