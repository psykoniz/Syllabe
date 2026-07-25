import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";

export const BLUEPRINT_FILES = [
  "product.md",
  "architecture.md",
  "implementation-plan.md",
  "test-plan.md",
] as const;

export type BlueprintFile = (typeof BLUEPRINT_FILES)[number];

export interface BlueprintContent {
  product: string;
  architecture: string;
  implementationPlan: string;
  testPlan: string;
}

export interface AdrEntry {
  number: number;
  title: string;
  status: "proposed" | "accepted" | "deprecated" | "superseded";
  context: string;
  decision: string;
  consequences: string;
}

export interface BlueprintSessionOptions {
  /** Path to .agent/interview.md to read context from */
  interviewFile?: string;
}

export class BlueprintSession {
  private saved = new Set<BlueprintFile>();
  private adrSaved = false;
  private content: Partial<BlueprintContent> = {};

  constructor(private opts: BlueprintSessionOptions = {}) {}

  /** Load interview answers markdown from file */
  loadInterview(filePath: string): string {
    if (!existsSync(filePath)) throw new Error(`Interview file not found: ${filePath}`);
    return readFileSync(filePath, "utf8");
  }

  setContent(content: BlueprintContent): void {
    this.content = content;
  }

  /** Save all 4 blueprint files into agentDir (the .agent directory) */
  saveBlueprint(agentDir: string, content: BlueprintContent): void {
    mkdirSync(agentDir, { recursive: true });
    const fileMap: Record<BlueprintFile, string> = {
      "product.md": content.product,
      "architecture.md": content.architecture,
      "implementation-plan.md": content.implementationPlan,
      "test-plan.md": content.testPlan,
    };
    for (const [filename, body] of Object.entries(fileMap) as [BlueprintFile, string][]) {
      writeFileSync(join(agentDir, filename), body, "utf8");
      this.saved.add(filename);
    }
    this.content = content;
  }

  /** Save an ADR file into agentDir/decisions/ */
  saveAdr(agentDir: string, adr: AdrEntry): string {
    const decisionsDir = join(agentDir, "decisions");
    mkdirSync(decisionsDir, { recursive: true });
    const slug = adr.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const filename = `ADR-${String(adr.number).padStart(3, "0")}-${slug}.md`;
    const filePath = join(decisionsDir, filename);
    writeFileSync(filePath, formatAdr(adr), "utf8");
    this.adrSaved = true;
    return filePath;
  }

  /** Check that all 4 blueprint files exist and are non-empty in agentDir */
  validate(agentDir: string): { valid: boolean; missing: string[] } {
    const missing: string[] = [];
    for (const f of BLUEPRINT_FILES) {
      const p = join(agentDir, f);
      if (!existsSync(p)) {
        missing.push(f);
        continue;
      }
      try {
        // A file of whitespace-only bytes is structurally non-empty but
        // semantically empty — it must not pass validation, or the DESIGN
        // retry never fires and PLAN extracts work units from a blank plan.
        const body = readFileSync(p, "utf8");
        if (body.trim().length === 0) missing.push(f);
      } catch {
        missing.push(f);
      }
    }
    return { valid: missing.length === 0, missing };
  }

  /** Find first ADR file in agentDir/decisions/ matching ADR-NNN-* */
  findAdr(agentDir: string, number: number): string | null {
    const decisionsDir = join(agentDir, "decisions");
    if (!existsSync(decisionsDir)) return null;
    const prefix = `ADR-${String(number).padStart(3, "0")}-`;
    const { readdirSync } = require("fs");
    const files: string[] = readdirSync(decisionsDir);
    const match = files.find((f: string) => f.startsWith(prefix) && f.endsWith(".md"));
    return match ? join(decisionsDir, match) : null;
  }
}

function formatAdr(adr: AdrEntry): string {
  return [
    `# ADR-${String(adr.number).padStart(3, "0")}: ${adr.title}`,
    "",
    `**Status:** ${adr.status}`,
    "",
    "## Context",
    "",
    adr.context,
    "",
    "## Decision",
    "",
    adr.decision,
    "",
    "## Consequences",
    "",
    adr.consequences,
    "",
  ].join("\n");
}
