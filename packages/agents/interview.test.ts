import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { InterviewSession } from "./interview";
import { DEFAULT_QUESTIONS, criticalQuestions } from "./product-strategist";
import type { InterviewQuestion } from "./interview";

const TMP = "/tmp/projectos-interview-test";
const INTERVIEW_FILE = join(TMP, ".agent/interview.md");

const QUESTIONS: InterviewQuestion[] = [
  {
    id: "q-critical-1",
    text: "Who is the user?",
    impact: "critical",
    default: "Developers",
    defaultRationale: "Most common target",
  },
  {
    id: "q-critical-2",
    text: "What problem does it solve?",
    impact: "critical",
    default: "Saves time",
    defaultRationale: "Default motivation",
  },
  {
    id: "q-important-1",
    text: "Preferred stack?",
    impact: "important",
    default: "TypeScript",
    defaultRationale: "Default stack",
  },
  {
    id: "q-optional-1",
    text: "Any nice-to-haves?",
    impact: "optional",
    default: "Dark mode",
    defaultRationale: "Always popular",
  },
];

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("isComplete", () => {
  it("is not complete with no answers", () => {
    const s = new InterviewSession(QUESTIONS);
    expect(s.isComplete()).toBe(false);
  });

  it("is not complete with only important/optional answered", () => {
    const s = new InterviewSession(QUESTIONS);
    s.answer("q-important-1", "React");
    expect(s.isComplete()).toBe(false);
  });

  it("is complete when all critical questions are answered", () => {
    const s = new InterviewSession(QUESTIONS);
    s.answer("q-critical-1", "Indie hackers");
    s.answer("q-critical-2", "Automation");
    expect(s.isComplete()).toBe(true);
  });

  it("is complete when critical questions are skipped (defaulted)", () => {
    const s = new InterviewSession(QUESTIONS);
    s.skip("q-critical-1");
    s.skip("q-critical-2");
    expect(s.isComplete()).toBe(true);
  });

  it("unansweredCritical returns remaining critical questions", () => {
    const s = new InterviewSession(QUESTIONS);
    s.answer("q-critical-1", "Someone");
    const remaining = s.unansweredCritical();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("q-critical-2");
  });
});

describe("skip applies default", () => {
  it("skip records the default answer", () => {
    const s = new InterviewSession(QUESTIONS);
    s.skip("q-critical-1");
    const ans = s.getAnswer("q-critical-1");
    expect(ans?.answer).toBe("Developers");
    expect(ans?.usedDefault).toBe(true);
  });

  it("skip logs it as usedDefault=true", () => {
    const s = new InterviewSession(QUESTIONS);
    s.skip("q-important-1");
    expect(s.getAnswer("q-important-1")?.usedDefault).toBe(true);
  });
});

describe("answer", () => {
  it("records answer with usedDefault=false", () => {
    const s = new InterviewSession(QUESTIONS);
    s.answer("q-critical-1", "Enterprise teams");
    const ans = s.getAnswer("q-critical-1");
    expect(ans?.answer).toBe("Enterprise teams");
    expect(ans?.usedDefault).toBe(false);
  });

  it("throws on unknown question id", () => {
    const s = new InterviewSession(QUESTIONS);
    expect(() => s.answer("nonexistent", "x")).toThrow("Unknown question id");
  });
});

describe("autoYes mode", () => {
  it("applies all defaults immediately", () => {
    const s = new InterviewSession(QUESTIONS, { autoYes: true });
    expect(s.isComplete()).toBe(true);
    expect(s.allAnswers()).toHaveLength(QUESTIONS.length);
  });

  it("every answer is marked usedDefault=true", () => {
    const s = new InterviewSession(QUESTIONS, { autoYes: true });
    for (const ans of s.allAnswers()) {
      expect(ans.usedDefault).toBe(true);
    }
  });

  it("logs each defaulted answer", () => {
    const s = new InterviewSession(QUESTIONS, { autoYes: true });
    const defaults = s.allAnswers().filter((a) => a.usedDefault);
    expect(defaults).toHaveLength(QUESTIONS.length);
  });
});

describe("save to .agent/interview.md", () => {
  it("writes interview.md with answers", () => {
    const s = new InterviewSession(QUESTIONS);
    s.answer("q-critical-1", "Indie hackers");
    s.skip("q-critical-2");
    s.save(INTERVIEW_FILE);
    expect(existsSync(INTERVIEW_FILE)).toBe(true);
    const content = readFileSync(INTERVIEW_FILE, "utf8");
    expect(content).toContain("Indie hackers");
    expect(content).toContain("used default");
  });

  it("creates parent directory if missing", () => {
    const nested = join(TMP, "deep/nested/.agent/interview.md");
    const s = new InterviewSession(QUESTIONS, { autoYes: true });
    s.save(nested);
    expect(existsSync(nested)).toBe(true);
  });
});

describe("DEFAULT_QUESTIONS", () => {
  it("has at least 3 critical questions", () => {
    const critical = criticalQuestions(DEFAULT_QUESTIONS);
    expect(critical.length).toBeGreaterThanOrEqual(3);
  });

  it("every question has id, text, default, defaultRationale", () => {
    for (const q of DEFAULT_QUESTIONS) {
      expect(q.id).toBeTruthy();
      expect(q.text).toBeTruthy();
      expect(q.default).toBeTruthy();
      expect(q.defaultRationale).toBeTruthy();
    }
  });
});
