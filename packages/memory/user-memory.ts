import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export type UserPreferences = Record<string, string>;

export class UserMemory {
  private prefs: UserPreferences = {};

  constructor(private filePath: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      this.prefs = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      this.prefs = {};
    }
  }

  get(key: string): string | undefined {
    return this.prefs[key];
  }

  set(key: string, value: string): void {
    this.prefs[key] = value;
    this.persist();
  }

  delete(key: string): void {
    delete this.prefs[key];
    this.persist();
  }

  all(): UserPreferences {
    return { ...this.prefs };
  }

  toContextBlock(): string {
    const entries = Object.entries(this.prefs);
    if (entries.length === 0) return "";
    const lines = ["## User Preferences\n"];
    for (const [k, v] of entries) {
      lines.push(`- **${k}**: ${v}`);
    }
    return lines.join("\n") + "\n";
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.prefs, null, 2), "utf8");
  }
}
