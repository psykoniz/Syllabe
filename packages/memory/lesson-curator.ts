import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";

export interface Lesson {
  id: string;
  trigger: string;
  content: string;
  createdAt: string;
  runId: string;
  approved: boolean;
}

export interface LessonCuratorOptions {
  autoYes?: boolean;
}

export class LessonCurator {
  private lessons: Lesson[] = [];

  constructor(
    private filePath: string,
    private opts: LessonCuratorOptions = {}
  ) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      this.lessons = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      this.lessons = [];
    }
  }

  /** Propose a new lesson. With autoYes it is immediately approved; otherwise pending. */
  propose(trigger: string, content: string, runId: string): Lesson {
    const lesson: Lesson = {
      id: randomUUID(),
      trigger,
      content,
      createdAt: new Date().toISOString(),
      runId,
      approved: this.opts.autoYes === true,
    };
    this.lessons.push(lesson);
    this.persist();
    return lesson;
  }

  /** Approve a pending lesson by id */
  approve(id: string): void {
    const lesson = this.lessons.find((l) => l.id === id);
    if (!lesson) throw new Error(`Lesson not found: ${id}`);
    lesson.approved = true;
    this.persist();
  }

  /** Return approved lessons whose trigger appears in the given context text */
  matching(contextText: string): Lesson[] {
    return this.lessons.filter(
      (l) => l.approved && contextText.toLowerCase().includes(l.trigger.toLowerCase())
    );
  }

  allApproved(): Lesson[] {
    return this.lessons.filter((l) => l.approved);
  }

  allPending(): Lesson[] {
    return this.lessons.filter((l) => !l.approved);
  }

  all(): Lesson[] {
    return [...this.lessons];
  }

  toContextBlock(contextText: string): string {
    const matched = this.matching(contextText);
    if (matched.length === 0) return "";
    const lines = ["## Lessons Learned\n"];
    for (const l of matched) {
      lines.push(`- **[${l.trigger}]** ${l.content}`);
    }
    return lines.join("\n") + "\n";
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.lessons, null, 2), "utf8");
  }
}
