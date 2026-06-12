import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Reviewer, validateVerdict } from "./reviewer";
import type { ReviewVerdict } from "./reviewer";
import { transition, makeContext } from "@projectos/core";

const TMP = join(tmpdir(), "projectos-reviewer-test");

const APPROVED_VERDICT: ReviewVerdict = {
  approved: true,
  risks: [],
  mustFix: [],
  shouldFix: ["Add more tests"],
  architectureNotes: "Clean separation of concerns.",
  testCoverageAssessment: "80% coverage, acceptable.",
};

const REJECTED_VERDICT: ReviewVerdict = {
  approved: false,
  risks: [{ severity: "high", area: "auth", description: "Passwords stored in plaintext" }],
  mustFix: ["Hash passwords with bcrypt"],
  shouldFix: [],
  architectureNotes: "Auth layer needs rework.",
  testCoverageAssessment: "Missing auth tests.",
};

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("Reviewer.recordVerdict", () => {
  it("stores a verdict for a work unit", () => {
    const r = new Reviewer();
    r.startReview("wu-1", "diff content");
    r.recordVerdict("wu-1", APPROVED_VERDICT);
    expect(r.hasVerdict("wu-1")).toBe(true);
  });

  it("getVerdict returns null before verdict is recorded", () => {
    const r = new Reviewer();
    r.startReview("wu-1", "diff");
    expect(r.getVerdict("wu-1")).toBeNull();
  });

  it("recordVerdict throws for unknown work unit", () => {
    const r = new Reviewer();
    expect(() => r.recordVerdict("wu-unknown", APPROVED_VERDICT)).toThrow(
      "No review session for work unit"
    );
  });

  it("mustFix items are preserved in verdict", () => {
    const r = new Reviewer();
    r.startReview("wu-1", "diff");
    r.recordVerdict("wu-1", REJECTED_VERDICT);
    expect(r.getVerdict("wu-1")?.mustFix).toContain("Hash passwords with bcrypt");
  });

  it("shouldFix items are logged but do not affect approved flag", () => {
    const r = new Reviewer();
    r.startReview("wu-1", "diff");
    r.recordVerdict("wu-1", APPROVED_VERDICT);
    const v = r.getVerdict("wu-1")!;
    expect(v.approved).toBe(true);
    expect(v.shouldFix).toContain("Add more tests");
  });
});

describe("Reviewer.saveFinalReport", () => {
  it("writes final-report.md with verdict content", () => {
    const r = new Reviewer();
    r.startReview("wu-1", "diff");
    r.recordVerdict("wu-1", APPROVED_VERDICT);
    const reportPath = join(TMP, "final-report.md");
    r.saveFinalReport(reportPath, "wu-1");
    expect(existsSync(reportPath)).toBe(true);
    const content = readFileSync(reportPath, "utf8");
    expect(content).toContain("wu-1");
    expect(content).toContain("yes");
    expect(content).toContain("Clean separation of concerns");
  });

  it("report includes risks when present", () => {
    const r = new Reviewer();
    r.startReview("wu-1", "diff");
    r.recordVerdict("wu-1", REJECTED_VERDICT);
    const reportPath = join(TMP, "final-report.md");
    r.saveFinalReport(reportPath, "wu-1");
    const content = readFileSync(reportPath, "utf8");
    expect(content).toContain("HIGH");
    expect(content).toContain("auth");
    expect(content).toContain("Passwords stored in plaintext");
  });

  it("report includes mustFix checklist", () => {
    const r = new Reviewer();
    r.startReview("wu-1", "diff");
    r.recordVerdict("wu-1", REJECTED_VERDICT);
    const reportPath = join(TMP, "final-report.md");
    r.saveFinalReport(reportPath, "wu-1");
    const content = readFileSync(reportPath, "utf8");
    expect(content).toContain("Hash passwords with bcrypt");
  });

  it("throws when no verdict exists", () => {
    const r = new Reviewer();
    r.startReview("wu-1", "diff");
    expect(() => r.saveFinalReport(join(TMP, "report.md"), "wu-1")).toThrow("No verdict for");
  });

  it("creates parent directory if missing", () => {
    const r = new Reviewer();
    r.startReview("wu-1", "diff");
    r.recordVerdict("wu-1", APPROVED_VERDICT);
    const nested = join(TMP, "deep/nested/final-report.md");
    r.saveFinalReport(nested, "wu-1");
    expect(existsSync(nested)).toBe(true);
  });
});

describe("validateVerdict", () => {
  it("returns true for a valid verdict object", () => {
    expect(validateVerdict(APPROVED_VERDICT)).toBe(true);
  });

  it("returns false for null", () => {
    expect(validateVerdict(null)).toBe(false);
  });

  it("returns false when approved field is missing", () => {
    const { approved, ...rest } = APPROVED_VERDICT;
    expect(validateVerdict(rest)).toBe(false);
  });

  it("returns false when risks is not an array", () => {
    expect(validateVerdict({ ...APPROVED_VERDICT, risks: "none" })).toBe(false);
  });

  it("returns false when mustFix is not an array", () => {
    expect(validateVerdict({ ...APPROVED_VERDICT, mustFix: null })).toBe(false);
  });
});

describe("State machine REVIEW gate", () => {
  it("transitions REVIEW → next state when verdictProvided=true", () => {
    const ctx = {
      ...makeContext([{ id: "wu-1", description: "d" }]),
      state: "REVIEW" as const,
    };
    const next = transition(ctx, { type: "REVIEW_APPROVE", verdictProvided: true });
    expect(next.state).toBe("DOCUMENT");
  });

  it("escalates from REVIEW when verdictProvided=false", () => {
    const ctx = {
      ...makeContext([{ id: "wu-1", description: "d" }]),
      state: "REVIEW" as const,
    };
    const next = transition(ctx, { type: "REVIEW_APPROVE", verdictProvided: false });
    expect(next.state).toBe("ESCALATED");
    expect(next.escalationReason).toContain("no verdict");
  });

  it("mustFix routes REVIEW back to IMPLEMENT (bounded)", () => {
    const ctx = {
      ...makeContext([{ id: "wu-1", description: "d" }]),
      state: "REVIEW" as const,
    };
    const next = transition(ctx, { type: "REVIEW_MUST_FIX" });
    expect(next.state).toBe("IMPLEMENT");
    expect(next.reviewCycleCount).toBe(1);
  });

  it("shouldFix items do not block: REVIEW_APPROVE still proceeds", () => {
    const r = new Reviewer();
    r.startReview("wu-1", "diff");
    r.recordVerdict("wu-1", { ...APPROVED_VERDICT, shouldFix: ["minor thing"] });
    // verdict is stored — shouldFix does not affect flow
    expect(r.getVerdict("wu-1")?.approved).toBe(true);
    const ctx = {
      ...makeContext([{ id: "wu-1", description: "d" }]),
      state: "REVIEW" as const,
    };
    const next = transition(ctx, { type: "REVIEW_APPROVE", verdictProvided: true });
    expect(next.state).toBe("DOCUMENT");
  });
});
