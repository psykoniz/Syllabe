import { FsTools } from "./filesystem/fs-tools";
import { GitTools } from "./git/git-tools";

// Self-contained tool schema — structurally compatible with the Anthropic
// Messages API `tools` parameter. packages/tools stays SDK-free.
export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Anything that can execute a shell command — BashTool or a sandboxed runner */
export interface BashRunner {
  run(command: string): { stdout: string; stderr: string; exitCode: number };
  getEnv(): Record<string, string>;
}

export interface ToolContext {
  fs: FsTools;
  bash: BashRunner;
  git: GitTools;
  workspace: string;
  /** Current git branch, used by the permission layer for git:commit rules */
  branch?: () => string;
}

export interface ToolDispatchResult {
  content: string;
  isError: boolean;
}

export const TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a file at the given path. Pass start_line/end_line (1-indexed, inclusive) to read only a region of a large file; the returned lines are then prefixed with their line numbers.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative file path" },
        start_line: { type: "number", description: "First line to read (1-indexed, inclusive)" },
        end_line: { type: "number", description: "Last line to read (1-indexed, inclusive)" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file. Refuses to overwrite unless overwrite is true.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        overwrite: { type: "boolean", description: "Allow overwriting existing file" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact unique string in a file with new text. Falls back to a whitespace-normalized match when the exact string is not found. Use replace_all to replace every occurrence.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "Exact string to find (must be unique unless replace_all)" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "glob_files",
    description: "Find files matching a glob pattern under a base directory.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern e.g. **/*.ts" },
        dir: { type: "string", description: "Base directory (defaults to workspace)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep_files",
    description:
      "Search for a regex pattern in the given files. Returns path:line: text matches (capped at 200).",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        files: { type: "array", items: { type: "string" }, description: "File paths to search" },
        context_lines: { type: "number", description: "Lines of context to show around each match" },
        max_matches: { type: "number", description: "Cap on total matches returned (default 200)" },
      },
      required: ["pattern", "files"],
    },
  },
  {
    name: "bash",
    description: "Execute a bash command in the workspace directory (30s timeout).",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
      },
      required: ["command"],
    },
  },
  {
    name: "git_status",
    description: "Show the git working tree status.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "git_diff",
    description: "Show git diff of working tree or staged changes.",
    input_schema: {
      type: "object",
      properties: {
        staged: { type: "boolean", description: "Show staged diff instead of working tree" },
      },
    },
  },
  {
    name: "git_commit",
    description: "Stage specific files and create a git commit.",
    input_schema: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, description: "Files to stage" },
        message: { type: "string", description: "Commit message" },
      },
      required: ["files", "message"],
    },
  },
];

/** Resolve a model-supplied path against the workspace if it is relative. */
function resolvePath(p: string, workspace: string): string {
  const { resolve, isAbsolute } = require("path");
  return isAbsolute(p) ? p : resolve(workspace, p);
}

export function dispatchTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): ToolDispatchResult {
  try {
    switch (toolName) {
      case "read_file":
        return ok(
          ctx.fs.read(resolvePath(input.path as string, ctx.workspace), {
            startLine: input.start_line as number | undefined,
            endLine: input.end_line as number | undefined,
          })
        );

      case "write_file":
        ctx.fs.write(resolvePath(input.path as string, ctx.workspace), input.content as string, {
          overwrite: (input.overwrite as boolean) ?? false,
        });
        return ok("ok");

      case "edit_file": {
        const r = ctx.fs.edit(
          resolvePath(input.path as string, ctx.workspace),
          input.old_string as string,
          input.new_string as string,
          { replaceAll: (input.replace_all as boolean) ?? false }
        );
        return ok(`Edited ${input.path} (${r.replacements} replacement(s), ${r.matchedVia})`);
      }

      case "glob_files": {
        const dir = input.dir ? resolvePath(input.dir as string, ctx.workspace) : ctx.workspace;
        const r = ctx.fs.glob(input.pattern as string, dir);
        const body = r.files.join("\n") || "(no matches)";
        return ok(r.truncated ? `${body}\n[truncated at ${r.files.length} files]` : body);
      }

      case "grep_files": {
        const files = (input.files as string[]).map((f) => resolvePath(f, ctx.workspace));
        const r = ctx.fs.grep(input.pattern as string, files, {
          contextLines: (input.context_lines as number) ?? 0,
          maxMatches: input.max_matches as number | undefined,
        });
        const lines: string[] = [];
        for (const m of r.matches) {
          if (m.context) {
            for (const c of m.context.filter((c) => c.line < m.line)) {
              lines.push(`${m.file}:${c.line}- ${c.text}`);
            }
          }
          lines.push(`${m.file}:${m.line}: ${m.text}`);
          if (m.context) {
            for (const c of m.context.filter((c) => c.line > m.line)) {
              lines.push(`${m.file}:${c.line}- ${c.text}`);
            }
          }
        }
        let body = lines.join("\n") || "(no matches)";
        if (r.truncated) body += `\n[truncated: showing first ${r.matches.length} matches]`;
        if (r.missingFiles.length > 0) {
          body += `\n[skipped ${r.missingFiles.length} non-existent file(s): ${r.missingFiles
            .slice(0, 5)
            .join(", ")}${r.missingFiles.length > 5 ? ", …" : ""}]`;
        }
        return ok(body);
      }

      case "bash": {
        const r = ctx.bash.run(input.command as string);
        const out = [
          r.stdout,
          r.stderr ? `[stderr] ${r.stderr}` : "",
          r.exitCode !== 0 ? `[exit ${r.exitCode}]` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return { content: out || "(no output)", isError: r.exitCode !== 0 };
      }

      case "git_status":
        return ok(ctx.git.status());

      case "git_diff":
        return ok(ctx.git.diff((input.staged as boolean) ?? false));

      case "git_commit": {
        const r = ctx.git.commit(input.files as string[], input.message as string);
        return ok(`committed ${r.sha}: ${r.message}`);
      }

      default:
        return { content: `Unknown tool: ${toolName}`, isError: true };
    }
  } catch (e) {
    return { content: `error: ${(e as Error).message}`, isError: true };
  }
}

function ok(content: string): ToolDispatchResult {
  return { content, isError: false };
}
