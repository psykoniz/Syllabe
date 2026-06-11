import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

export interface ProjectMemoryData {
  answeredQuestionIds: string[];
  commands: string[];
}

/** Persists project-level state: which interview questions have been answered,
 *  and any per-project commands/notes to inject into context. */
export class ProjectMemory {
  private data: ProjectMemoryData = { answeredQuestionIds: [], commands: [] };

  constructor(private filePath: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      this.data = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      this.data = { answeredQuestionIds: [], commands: [] };
    }
  }

  markAnswered(questionId: string): void {
    if (!this.data.answeredQuestionIds.includes(questionId)) {
      this.data.answeredQuestionIds.push(questionId);
      this.persist();
    }
  }

  isAnswered(questionId: string): boolean {
    return this.data.answeredQuestionIds.includes(questionId);
  }

  answeredIds(): string[] {
    return [...this.data.answeredQuestionIds];
  }

  addCommand(command: string): void {
    this.data.commands.push(command);
    this.persist();
  }

  commands(): string[] {
    return [...this.data.commands];
  }

  toContextBlock(): string {
    const lines: string[] = [];
    if (this.data.commands.length > 0) {
      lines.push("## Project Commands\n");
      for (const c of this.data.commands) {
        lines.push(`- ${c}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
  }
}

/** Priority-ordered memory loader.
 *  Order: prefs > commands > ADRs > lessons > skills */
export interface MemoryBlocks {
  prefs: string;
  commands: string;
  adrs: string;
  lessons: string;
  skills: string;
}

export function assembleContext(blocks: MemoryBlocks): string {
  return [blocks.prefs, blocks.commands, blocks.adrs, blocks.lessons, blocks.skills]
    .filter(Boolean)
    .join("\n");
}
