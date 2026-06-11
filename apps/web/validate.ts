/** Pure validation helpers for the web server (kept separate from server.ts
 *  so they can be unit-tested without booting Bun.serve). */

export type ValidationResult = { ok: true } | { ok: false; error: string };

// Accepted repo sources: http(s) URLs, git@ scp-like, ssh:// URLs, absolute
// paths and explicit relative paths (./ or ../).
const REPO_PREFIX = /^(https?:\/\/|git@|ssh:\/\/|\/|\.{1,2}\/)/;
// Anything that could break out of an argv slot or get interpreted by a shell.
const FORBIDDEN_CHARS = /[\s;|&`$<>]/;
const BRANCH_PATTERN = /^[\w./-]+$/;

export function validateRepoParams(repoUrl?: string, baseBranch?: string): ValidationResult {
  if (repoUrl !== undefined && repoUrl !== "") {
    if (typeof repoUrl !== "string" || !REPO_PREFIX.test(repoUrl)) {
      return { ok: false, error: "repoUrl must be an http(s)/ssh/git@ URL or a local path" };
    }
    if (FORBIDDEN_CHARS.test(repoUrl)) {
      return { ok: false, error: "repoUrl contains forbidden characters" };
    }
  }
  if (baseBranch !== undefined && baseBranch !== "") {
    if (typeof baseBranch !== "string" || !BRANCH_PATTERN.test(baseBranch)) {
      return { ok: false, error: "baseBranch contains invalid characters" };
    }
  }
  return { ok: true };
}

/** Strip userinfo (user:token@) from a git URL so credentials never appear
 *  in run metadata or logs. Local paths are left untouched. */
export function redactGitUrl(url: string): string {
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      const parsed = new URL(url);
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
  } catch {
    // not a parseable URL — fall through
  }
  const scpMatch = /^([^@:/]+)(?::[^@]+)?@(.+)$/.exec(url);
  if (scpMatch && url.includes(":") && !url.startsWith("/")) {
    return `${scpMatch[1]}@${scpMatch[2]}`;
  }
  return url;
}
