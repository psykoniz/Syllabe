import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";

export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  tags: string[];
  createdAt: string;
}

export class SkillStore {
  private skills: Skill[] = [];

  constructor(private filePath: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      this.skills = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      this.skills = [];
    }
  }

  add(name: string, description: string, content: string, tags: string[] = []): Skill {
    const skill: Skill = {
      id: randomUUID(),
      name,
      description,
      content,
      tags,
      createdAt: new Date().toISOString(),
    };
    this.skills.push(skill);
    this.persist();
    return skill;
  }

  get(id: string): Skill | null {
    return this.skills.find((s) => s.id === id) ?? null;
  }

  findByTag(tag: string): Skill[] {
    return this.skills.filter((s) => s.tags.includes(tag));
  }

  all(): Skill[] {
    return [...this.skills];
  }

  toContextBlock(): string {
    if (this.skills.length === 0) return "";
    const lines = ["## Skills\n"];
    for (const s of this.skills) {
      const tags = s.tags.length > 0 ? ` [${s.tags.join(", ")}]` : "";
      lines.push(`### ${s.name}${tags}\n`);
      lines.push(s.description);
      lines.push("");
    }
    return lines.join("\n");
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.skills, null, 2), "utf8");
  }
}
