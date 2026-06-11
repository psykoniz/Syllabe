import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export type QuestionImpact = "critical" | "important" | "optional";

export interface InterviewQuestion {
  id: string;
  text: string;
  impact: QuestionImpact;
  default: string;
  defaultRationale: string;
  options?: string[];
}

export interface InterviewAnswer {
  questionId: string;
  answer: string;
  usedDefault: boolean;
  ts: string;
}

export interface InterviewSessionOptions {
  autoYes?: boolean; // --yes: apply all defaults without prompting
}

export class InterviewSession {
  private answers = new Map<string, InterviewAnswer>();

  constructor(
    private questions: InterviewQuestion[],
    private opts: InterviewSessionOptions = {}
  ) {
    if (opts.autoYes) {
      for (const q of questions) this.skip(q.id);
    }
  }

  answer(questionId: string, value: string): void {
    const q = this.findQuestion(questionId);
    this.answers.set(questionId, {
      questionId,
      answer: value,
      usedDefault: false,
      ts: new Date().toISOString(),
    });
  }

  skip(questionId: string): void {
    const q = this.findQuestion(questionId);
    this.answers.set(questionId, {
      questionId,
      answer: q.default,
      usedDefault: true,
      ts: new Date().toISOString(),
    });
  }

  isComplete(): boolean {
    const critical = this.questions.filter((q) => q.impact === "critical");
    return critical.every((q) => this.answers.has(q.id));
  }

  unansweredCritical(): InterviewQuestion[] {
    return this.questions.filter(
      (q) => q.impact === "critical" && !this.answers.has(q.id)
    );
  }

  getAnswer(questionId: string): InterviewAnswer | null {
    return this.answers.get(questionId) ?? null;
  }

  allAnswers(): InterviewAnswer[] {
    return Array.from(this.answers.values());
  }

  toMarkdown(): string {
    const lines: string[] = ["# Interview\n"];
    for (const q of this.questions) {
      const ans = this.answers.get(q.id);
      const tag = `[${q.impact}]`;
      lines.push(`## ${tag} ${q.text}`);
      if (ans) {
        lines.push(`**Answer:** ${ans.answer}`);
        if (ans.usedDefault) lines.push(`_(used default: ${q.defaultRationale})_`);
      } else {
        lines.push(`_unanswered_`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  save(filePath: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, this.toMarkdown(), "utf8");
  }

  private findQuestion(id: string): InterviewQuestion {
    const q = this.questions.find((q) => q.id === id);
    if (!q) throw new Error(`Unknown question id: ${id}`);
    return q;
  }
}
