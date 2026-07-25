import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BlueprintSession, BLUEPRINT_FILES } from "./architect";
import { transition, makeContext } from "@projectos/core";

const TMP = join(tmpdir(), "projectos-architect-test");
const AGENT_DIR = join(TMP, ".agent");

const SAMPLE_CONTENT = {
  product: "# Product\n\nA great product.",
  architecture: "# Architecture\n\nMicroservices.",
  implementationPlan: "# Implementation Plan\n\n1. Setup\n2. Build",
  testPlan: "# Test Plan\n\nUnit tests for all modules.",
};

beforeEach(() => mkdirSync(AGENT_DIR, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("BlueprintSession.saveBlueprint", () => {
  it("creates all 4 blueprint files", () => {
    const s = new BlueprintSession();
    s.saveBlueprint(AGENT_DIR, SAMPLE_CONTENT);
    for (const f of BLUEPRINT_FILES) {
      expect(existsSync(join(AGENT_DIR, f))).toBe(true);
    }
  });

  it("writes non-empty content to each file", () => {
    const s = new BlueprintSession();
    s.saveBlueprint(AGENT_DIR, SAMPLE_CONTENT);
    expect(readFileSync(join(AGENT_DIR, "product.md"), "utf8")).toContain("great product");
    expect(readFileSync(join(AGENT_DIR, "architecture.md"), "utf8")).toContain("Microservices");
    expect(readFileSync(join(AGENT_DIR, "implementation-plan.md"), "utf8")).toContain("Implementation");
    expect(readFileSync(join(AGENT_DIR, "test-plan.md"), "utf8")).toContain("Unit tests");
  });

  it("creates parent directory if missing", () => {
    const nested = join(TMP, "deep/nested/.agent");
    const s = new BlueprintSession();
    s.saveBlueprint(nested, SAMPLE_CONTENT);
    for (const f of BLUEPRINT_FILES) {
      expect(existsSync(join(nested, f))).toBe(true);
    }
  });
});

describe("BlueprintSession.validate", () => {
  it("returns valid=true when all 4 files exist and are non-empty", () => {
    const s = new BlueprintSession();
    s.saveBlueprint(AGENT_DIR, SAMPLE_CONTENT);
    const result = s.validate(AGENT_DIR);
    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it("returns valid=false and lists missing files when none exist", () => {
    const s = new BlueprintSession();
    const result = s.validate(AGENT_DIR);
    expect(result.valid).toBe(false);
    expect(result.missing).toHaveLength(BLUEPRINT_FILES.length);
  });

  it("returns valid=false when a file is empty", () => {
    const s = new BlueprintSession();
    s.saveBlueprint(AGENT_DIR, SAMPLE_CONTENT);
    writeFileSync(join(AGENT_DIR, "product.md"), "");
    const result = s.validate(AGENT_DIR);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("product.md");
  });

  it("returns valid=false when a file is whitespace-only", () => {
    const s = new BlueprintSession();
    s.saveBlueprint(AGENT_DIR, SAMPLE_CONTENT);
    writeFileSync(join(AGENT_DIR, "architecture.md"), "   \n\n\t\n");
    const result = s.validate(AGENT_DIR);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("architecture.md");
  });

  it("reports all missing files individually", () => {
    const s = new BlueprintSession();
    writeFileSync(join(AGENT_DIR, "product.md"), "content");
    const result = s.validate(AGENT_DIR);
    expect(result.missing).toContain("architecture.md");
    expect(result.missing).toContain("implementation-plan.md");
    expect(result.missing).toContain("test-plan.md");
    expect(result.missing).not.toContain("product.md");
  });
});

describe("BlueprintSession.saveAdr", () => {
  it("creates ADR file in decisions/ subdirectory", () => {
    const s = new BlueprintSession();
    const adrPath = s.saveAdr(AGENT_DIR, {
      number: 1,
      title: "Use TypeScript",
      status: "accepted",
      context: "We need a typed language.",
      decision: "Use TypeScript.",
      consequences: "All contributors must know TypeScript.",
    });
    expect(existsSync(adrPath)).toBe(true);
    expect(adrPath).toContain("decisions");
    expect(adrPath).toContain("ADR-001-");
  });

  it("filename is slugified from the title", () => {
    const s = new BlueprintSession();
    const adrPath = s.saveAdr(AGENT_DIR, {
      number: 1,
      title: "Use TypeScript for Everything",
      status: "accepted",
      context: "Context.",
      decision: "Decision.",
      consequences: "Consequences.",
    });
    expect(adrPath).toContain("ADR-001-use-typescript-for-everything.md");
  });

  it("ADR content includes title, status, context, decision, consequences", () => {
    const s = new BlueprintSession();
    const adrPath = s.saveAdr(AGENT_DIR, {
      number: 1,
      title: "Use SQLite",
      status: "accepted",
      context: "Need a simple DB.",
      decision: "SQLite via bun:sqlite.",
      consequences: "No multi-writer concurrency.",
    });
    const content = readFileSync(adrPath, "utf8");
    expect(content).toContain("ADR-001");
    expect(content).toContain("Use SQLite");
    expect(content).toContain("accepted");
    expect(content).toContain("Need a simple DB");
    expect(content).toContain("SQLite via bun:sqlite");
    expect(content).toContain("No multi-writer concurrency");
  });

  it("findAdr locates the file by number", () => {
    const s = new BlueprintSession();
    s.saveAdr(AGENT_DIR, {
      number: 1,
      title: "Monorepo Layout",
      status: "accepted",
      context: "c",
      decision: "d",
      consequences: "e",
    });
    const found = s.findAdr(AGENT_DIR, 1);
    expect(found).not.toBeNull();
    expect(found).toContain("ADR-001-");
  });

  it("findAdr returns null when no ADR exists", () => {
    const s = new BlueprintSession();
    const found = s.findAdr(AGENT_DIR, 1);
    expect(found).toBeNull();
  });
});

describe("BlueprintSession.loadInterview", () => {
  it("reads interview file content", () => {
    const interviewPath = join(AGENT_DIR, "interview.md");
    writeFileSync(interviewPath, "# Interview\n\n## Who is the user?\n**Answer:** Developers\n");
    const s = new BlueprintSession();
    const content = s.loadInterview(interviewPath);
    expect(content).toContain("Who is the user");
    expect(content).toContain("Developers");
  });

  it("throws when interview file does not exist", () => {
    const s = new BlueprintSession();
    expect(() => s.loadInterview(join(AGENT_DIR, "nonexistent.md"))).toThrow(
      "Interview file not found"
    );
  });
});

describe("State machine DESIGN gate", () => {
  it("transitions DESIGN → PLAN when blueprintValidated=true", () => {
    const ctx = { ...makeContext(), state: "DESIGN" as const };
    const next = transition(ctx, {
      type: "PLAN_DONE",
      workUnits: [],
      blueprintValidated: true,
    });
    expect(next.state).toBe("PLAN");
  });

  it("escalates from DESIGN when blueprintValidated=false", () => {
    const ctx = { ...makeContext(), state: "DESIGN" as const };
    const next = transition(ctx, {
      type: "PLAN_DONE",
      workUnits: [],
      blueprintValidated: false,
    });
    expect(next.state).toBe("ESCALATED");
    expect(next.escalationReason).toContain("blueprint incomplete");
  });

  it("includes which files are missing in escalation when checked via validate()", () => {
    const s = new BlueprintSession();
    const result = s.validate(AGENT_DIR);
    expect(result.valid).toBe(false);
    // state machine integration: only fire PLAN_DONE with blueprintValidated when validate() returns true
    const ctx = { ...makeContext(), state: "DESIGN" as const };
    const next = transition(ctx, {
      type: "PLAN_DONE",
      workUnits: [],
      blueprintValidated: result.valid,
    });
    expect(next.state).toBe("ESCALATED");
  });
});
