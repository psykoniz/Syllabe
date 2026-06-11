export interface ApprovalRequest {
  tool: string;
  reason: string;
  args: Record<string, unknown>;
}

export interface ApprovalResult {
  approved: boolean;
  note?: string;
}

export type ApprovalHandler = (req: ApprovalRequest) => Promise<ApprovalResult>;

// Non-interactive mode: approve everything (used with --yes flag)
export const autoApprove: ApprovalHandler = async () => ({ approved: true });

// Non-interactive mode: deny everything (used in tests)
export const autoDeny: ApprovalHandler = async () => ({ approved: false });

// Interactive mode: prompts via stdin
export async function interactiveApproval(req: ApprovalRequest): Promise<ApprovalResult> {
  process.stdout.write(
    `\n[ProjectOS] Tool request: ${req.tool}\n` +
    `Reason: ${req.reason}\n` +
    `Allow? [y/N] `
  );

  const answer = await readLine();
  const approved = answer.trim().toLowerCase() === "y";
  return { approved };
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.once("data", (chunk: string) => {
      buf += chunk;
      process.stdin.pause();
      resolve(buf.split("\n")[0] ?? "");
    });
  });
}
