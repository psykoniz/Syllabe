import { describe, it, expect } from "bun:test";
import { validateRepoParams, redactGitUrl } from "./validate";

describe("validateRepoParams", () => {
  it("accepts empty params (no repo run)", () => {
    expect(validateRepoParams()).toEqual({ ok: true });
    expect(validateRepoParams("", "")).toEqual({ ok: true });
  });

  it("accepts https URLs", () => {
    expect(validateRepoParams("https://github.com/org/repo.git", "main")).toEqual({ ok: true });
  });

  it("accepts http URLs", () => {
    expect(validateRepoParams("http://internal.example/repo.git")).toEqual({ ok: true });
  });

  it("accepts scp-like git@ URLs", () => {
    expect(validateRepoParams("git@github.com:org/repo.git")).toEqual({ ok: true });
  });

  it("accepts ssh:// URLs", () => {
    expect(validateRepoParams("ssh://git@github.com/org/repo.git")).toEqual({ ok: true });
  });

  it("accepts absolute and relative local paths", () => {
    expect(validateRepoParams("/home/user/some-repo")).toEqual({ ok: true });
    expect(validateRepoParams("./repo")).toEqual({ ok: true });
    expect(validateRepoParams("../repo")).toEqual({ ok: true });
  });

  it("rejects bare names without a recognized prefix", () => {
    expect(validateRepoParams("org/repo").ok).toBe(false);
    expect(validateRepoParams("repo.git").ok).toBe(false);
  });

  it("rejects shell metacharacters in repoUrl", () => {
    for (const bad of [
      "https://x.com/a;rm -rf /",
      "https://x.com/a|b",
      "https://x.com/a&b",
      "https://x.com/a`b`",
      "https://x.com/a$(b)",
      "https://x.com/a<b",
      "https://x.com/a>b",
      "/tmp/repo with space",
    ]) {
      expect(validateRepoParams(bad).ok).toBe(false);
    }
  });

  it("rejects invalid base branch names", () => {
    expect(validateRepoParams("/tmp/repo", "main;rm").ok).toBe(false);
    expect(validateRepoParams("/tmp/repo", "a b").ok).toBe(false);
    expect(validateRepoParams("/tmp/repo", "$(x)").ok).toBe(false);
  });

  it("accepts common base branch names", () => {
    for (const good of ["main", "master", "develop", "release/1.2", "feature/foo-bar", "v1.0.0"]) {
      expect(validateRepoParams("/tmp/repo", good)).toEqual({ ok: true });
    }
  });
});

describe("redactGitUrl", () => {
  it("strips user:token from https URLs", () => {
    expect(redactGitUrl("https://user:token@github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git"
    );
  });

  it("leaves local paths untouched", () => {
    expect(redactGitUrl("/home/user/repo")).toBe("/home/user/repo");
  });

  it("strips password from scp-like syntax", () => {
    expect(redactGitUrl("git:secret@github.com:org/repo.git")).toBe("git@github.com:org/repo.git");
  });
});
