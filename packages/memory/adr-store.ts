import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

export interface AdrSummary {
  number: number;
  title: string;
  status: string;
  filePath: string;
  content: string;
}

/** Reads all ADR-NNN-*.md files from a decisions directory */
export class AdrStore {
  constructor(private decisionsDir: string) {}

  load(): AdrSummary[] {
    if (!existsSync(this.decisionsDir)) return [];
    const files = readdirSync(this.decisionsDir)
      .filter((f) => /^ADR-\d{3}-.*\.md$/.test(f))
      .sort();
    return files.map((f) => {
      const filePath = join(this.decisionsDir, f);
      const content = readFileSync(filePath, "utf8");
      const number = parseInt(f.slice(4, 7), 10);
      const title = extractAdrTitle(content) ?? f;
      const status = extractAdrStatus(content) ?? "unknown";
      return { number, title, status, filePath, content };
    });
  }

  get(number: number): AdrSummary | null {
    return this.load().find((a) => a.number === number) ?? null;
  }

  toContextBlock(): string {
    const adrs = this.load();
    if (adrs.length === 0) return "";
    const lines = ["## Architecture Decision Records\n"];
    for (const a of adrs) {
      lines.push(`### ADR-${String(a.number).padStart(3, "0")}: ${a.title} [${a.status}]\n`);
      lines.push(a.content.trim());
      lines.push("");
    }
    return lines.join("\n");
  }
}

function extractAdrTitle(content: string): string | null {
  const m = content.match(/^#\s+ADR-\d+:\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function extractAdrStatus(content: string): string | null {
  const m = content.match(/\*\*Status:\*\*\s+(\w+)/);
  return m ? m[1].trim() : null;
}
