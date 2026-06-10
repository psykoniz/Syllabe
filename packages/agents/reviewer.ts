import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export type RiskSeverity = "low" | "medium" | "high" | "critical";

export interface Risk {
  severity: RiskSeverity;
  area: string;
  description: string;
}

export interface ReviewVerdict {
  approved: boolean;
  risks: Risk[];
  mustFix: string[];
  shouldFix: string[];
  architectureNotes: string;
  testCoverageAssessment: string;
}

export interface ReviewSession {
  workUnitId: string;
  diffSummary: string;
  verdict: ReviewVerdict | null;
}

export class Reviewer {
  private sessions: ReviewSession[] = [];

  startReview(workUnitId: string, diffSummary: string): ReviewSession {
    const session: ReviewSession = { workUnitId, diffSummary, verdict: null };
    this.sessions.push(session);
    return session;
  }

  recordVerdict(workUnitId: string, verdict: ReviewVerdict): void {
    const session = this.sessions.find((s) => s.workUnitId === workUnitId);
    if (!session) throw new Error(`No review session for work unit: ${workUnitId}`);
    session.verdict = verdict;
  }

  getVerdict(workUnitId: string): ReviewVerdict | null {
    return this.sessions.find((s) => s.workUnitId === workUnitId)?.verdict ?? null;
  }

  hasVerdict(workUnitId: string): boolean {
    return this.getVerdict(workUnitId) !== null;
  }

  /** Save final-report.md to the given path */
  saveFinalReport(filePath: string, workUnitId: string): void {
    const verdict = this.getVerdict(workUnitId);
    if (!verdict) throw new Error(`No verdict for work unit: ${workUnitId}`);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, formatReport(workUnitId, verdict), "utf8");
  }

  saveAllReports(filePath: string): void {
    const lines: string[] = ["# Review Report\n"];
    for (const session of this.sessions) {
      if (session.verdict) {
        lines.push(formatReport(session.workUnitId, session.verdict));
      }
    }
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, lines.join("\n"), "utf8");
  }
}

export function validateVerdict(verdict: unknown): verdict is ReviewVerdict {
  if (!verdict || typeof verdict !== "object") return false;
  const v = verdict as Record<string, unknown>;
  return (
    typeof v.approved === "boolean" &&
    Array.isArray(v.risks) &&
    Array.isArray(v.mustFix) &&
    Array.isArray(v.shouldFix) &&
    typeof v.architectureNotes === "string" &&
    typeof v.testCoverageAssessment === "string"
  );
}

function formatReport(workUnitId: string, verdict: ReviewVerdict): string {
  const lines: string[] = [
    `## Work Unit: ${workUnitId}`,
    "",
    `**Approved:** ${verdict.approved ? "yes" : "no"}`,
    "",
  ];

  if (verdict.risks.length > 0) {
    lines.push("### Risks\n");
    for (const r of verdict.risks) {
      lines.push(`- [${r.severity.toUpperCase()}] **${r.area}**: ${r.description}`);
    }
    lines.push("");
  }

  if (verdict.mustFix.length > 0) {
    lines.push("### Must Fix\n");
    for (const item of verdict.mustFix) {
      lines.push(`- [ ] ${item}`);
    }
    lines.push("");
  }

  if (verdict.shouldFix.length > 0) {
    lines.push("### Should Fix\n");
    for (const item of verdict.shouldFix) {
      lines.push(`- [ ] ${item}`);
    }
    lines.push("");
  }

  lines.push("### Architecture Notes\n");
  lines.push(verdict.architectureNotes);
  lines.push("");
  lines.push("### Test Coverage\n");
  lines.push(verdict.testCoverageAssessment);
  lines.push("");

  return lines.join("\n");
}
