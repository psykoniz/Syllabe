import { minimatch } from "minimatch";

export type Decision = "allow" | "ask" | "deny";

export interface ToolRequest {
  tool: string;
  args: Record<string, unknown>;
}

export interface PolicyRule {
  tool: string;           // glob pattern e.g. "bash", "fs:write", "*"
  match?: (args: Record<string, unknown>) => boolean;
  decision: Decision;
  reason: string;
}

// Hard-deny patterns checked before any rule
const HARD_DENY_BASH_PATTERNS = [
  /rm\s+-rf/,
  /:\s*\(\s*\)\s*\{/,   // fork bomb
  /mkfs/,
  /dd\s+if=/,
];

const SECRET_FILE_GLOBS = ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx"];

function isBashDestructive(command: string): boolean {
  return HARD_DENY_BASH_PATTERNS.some((re) => re.test(command));
}

function isSecretFile(filePath: string): boolean {
  const base = filePath.replace(/\\/g, "/");
  return SECRET_FILE_GLOBS.some((g) => minimatch(base, g, { matchBase: true, dot: true }));
}

function isAgentBranch(branch: string): boolean {
  // Agent branches follow the pattern: agent/<anything>
  return /^agent\//.test(branch) || /^claude\//.test(branch);
}

export const DEFAULT_RULES: PolicyRule[] = [
  // Secret files: hard deny, no override
  {
    tool: "fs:read",
    match: (a) => isSecretFile(String(a.filePath ?? "")),
    decision: "deny",
    reason: "reading secret files is not permitted",
  },
  {
    tool: "fs:write",
    match: (a) => isSecretFile(String(a.filePath ?? "")),
    decision: "deny",
    reason: "writing secret files is not permitted",
  },
  // Bash destructive patterns: hard deny
  {
    tool: "bash",
    match: (a) => isBashDestructive(String(a.command ?? "")),
    decision: "deny",
    reason: "destructive bash command blocked",
  },
  // git push: ask
  {
    tool: "git:push",
    decision: "ask",
    reason: "git push requires user approval",
  },
  // git commit on agent branch: allow (logged)
  {
    tool: "git:commit",
    match: (a) => isAgentBranch(String(a.branch ?? "")),
    decision: "allow",
    reason: "commits on agent branches are allowed without prompt",
  },
  // git commit on other branches: ask
  {
    tool: "git:commit",
    decision: "ask",
    reason: "git commit on non-agent branch requires approval",
  },
  // File write inside workspace: allow
  {
    tool: "fs:write",
    match: (a) => Boolean(a.insideWorkspace),
    decision: "allow",
    reason: "writes inside workspace are permitted",
  },
  // File write outside workspace: ask
  {
    tool: "fs:write",
    decision: "ask",
    reason: "writes outside workspace require approval",
  },
];

export interface PolicyDecision {
  decision: Decision;
  reason: string;
  rule: PolicyRule | null;
}

export class PermissionEngine {
  constructor(private rules: PolicyRule[] = DEFAULT_RULES) {}

  evaluate(req: ToolRequest): PolicyDecision {
    for (const rule of this.rules) {
      if (!minimatch(req.tool, rule.tool)) continue;
      if (rule.match && !rule.match(req.args)) continue;
      return { decision: rule.decision, reason: rule.reason, rule };
    }
    // Default: allow unknown tools
    return { decision: "allow", reason: "no matching rule — default allow", rule: null };
  }
}
