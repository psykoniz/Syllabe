import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { AdrStore } from "./adr-store";
import { UserMemory } from "./user-memory";
import { LessonCurator } from "./lesson-curator";
import { SkillStore } from "./skill-store";
import { ProjectMemory, assembleContext } from "./project-memory";

const TMP = "/tmp/projectos-memory-test";

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

// ─── AdrStore ────────────────────────────────────────────────────────────────

describe("AdrStore", () => {
  const decisionsDir = () => join(TMP, ".agent/decisions");

  function writeAdr(filename: string, content: string) {
    const dir = decisionsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), content);
  }

  it("returns empty array when decisions dir does not exist", () => {
    const store = new AdrStore(join(TMP, "nonexistent/decisions"));
    expect(store.load()).toHaveLength(0);
  });

  it("loads ADR files from decisions directory", () => {
    writeAdr(
      "ADR-001-use-typescript.md",
      "# ADR-001: Use TypeScript\n\n**Status:** accepted\n\n## Context\n\nc\n\n## Decision\n\nd\n\n## Consequences\n\ne\n"
    );
    const store = new AdrStore(decisionsDir());
    const adrs = store.load();
    expect(adrs).toHaveLength(1);
    expect(adrs[0].number).toBe(1);
    expect(adrs[0].title).toBe("Use TypeScript");
    expect(adrs[0].status).toBe("accepted");
  });

  it("loads multiple ADRs sorted by number", () => {
    writeAdr("ADR-002-use-sqlite.md", "# ADR-002: Use SQLite\n\n**Status:** accepted\n\n## Context\n\nc\n\n## Decision\n\nd\n\n## Consequences\n\ne\n");
    writeAdr("ADR-001-monorepo.md", "# ADR-001: Monorepo\n\n**Status:** accepted\n\n## Context\n\nc\n\n## Decision\n\nd\n\n## Consequences\n\ne\n");
    const store = new AdrStore(decisionsDir());
    const adrs = store.load();
    expect(adrs).toHaveLength(2);
    expect(adrs[0].number).toBe(1);
    expect(adrs[1].number).toBe(2);
  });

  it("get() retrieves ADR by number", () => {
    writeAdr("ADR-001-use-typescript.md", "# ADR-001: Use TypeScript\n\n**Status:** accepted\n\n## Context\n\nc\n\n## Decision\n\nd\n\n## Consequences\n\ne\n");
    const store = new AdrStore(decisionsDir());
    const adr = store.get(1);
    expect(adr).not.toBeNull();
    expect(adr?.title).toBe("Use TypeScript");
  });

  it("get() returns null for missing number", () => {
    const store = new AdrStore(decisionsDir());
    expect(store.get(99)).toBeNull();
  });

  it("toContextBlock includes ADR title and content", () => {
    writeAdr("ADR-001-use-typescript.md", "# ADR-001: Use TypeScript\n\n**Status:** accepted\n\n## Context\n\nc\n\n## Decision\n\nd\n\n## Consequences\n\ne\n");
    const store = new AdrStore(decisionsDir());
    const block = store.toContextBlock();
    expect(block).toContain("Use TypeScript");
    expect(block).toContain("accepted");
  });

  it("persists across two AdrStore instances (run 1 → run 2)", () => {
    writeAdr("ADR-001-use-typescript.md", "# ADR-001: Use TypeScript\n\n**Status:** accepted\n\n## Context\n\nc\n\n## Decision\n\nd\n\n## Consequences\n\ne\n");
    // run 2: new instance loads same directory
    const store2 = new AdrStore(decisionsDir());
    expect(store2.get(1)?.title).toBe("Use TypeScript");
  });
});

// ─── UserMemory ───────────────────────────────────────────────────────────────

describe("UserMemory", () => {
  const prefsFile = () => join(TMP, "prefs.json");

  it("returns undefined for unknown key", () => {
    const m = new UserMemory(prefsFile());
    expect(m.get("stack")).toBeUndefined();
  });

  it("set and get a preference", () => {
    const m = new UserMemory(prefsFile());
    m.set("stack", "TypeScript + Bun");
    expect(m.get("stack")).toBe("TypeScript + Bun");
  });

  it("persists across instances (run 1 → run 2)", () => {
    const m1 = new UserMemory(prefsFile());
    m1.set("deployment", "Hetzner VPS");
    const m2 = new UserMemory(prefsFile());
    expect(m2.get("deployment")).toBe("Hetzner VPS");
  });

  it("delete removes a preference", () => {
    const m = new UserMemory(prefsFile());
    m.set("stack", "TypeScript");
    m.delete("stack");
    expect(m.get("stack")).toBeUndefined();
  });

  it("toContextBlock lists all preferences", () => {
    const m = new UserMemory(prefsFile());
    m.set("stack", "TypeScript + Bun");
    m.set("deployment", "Hetzner");
    const block = m.toContextBlock();
    expect(block).toContain("stack");
    expect(block).toContain("TypeScript + Bun");
    expect(block).toContain("deployment");
  });

  it("toContextBlock returns empty string when no prefs", () => {
    const m = new UserMemory(prefsFile());
    expect(m.toContextBlock()).toBe("");
  });
});

// ─── LessonCurator ────────────────────────────────────────────────────────────

describe("LessonCurator", () => {
  const lessonsFile = () => join(TMP, "lessons.json");

  it("propose creates a pending lesson in interactive mode", () => {
    const c = new LessonCurator(lessonsFile());
    const lesson = c.propose("auth", "Always hash passwords with bcrypt", "run-1");
    expect(lesson.approved).toBe(false);
    expect(c.allPending()).toHaveLength(1);
  });

  it("propose auto-approves with autoYes=true", () => {
    const c = new LessonCurator(lessonsFile(), { autoYes: true });
    const lesson = c.propose("auth", "Always hash passwords with bcrypt", "run-1");
    expect(lesson.approved).toBe(true);
    expect(c.allApproved()).toHaveLength(1);
  });

  it("approve() approves a pending lesson", () => {
    const c = new LessonCurator(lessonsFile());
    const lesson = c.propose("auth", "content", "run-1");
    c.approve(lesson.id);
    expect(c.allApproved()).toHaveLength(1);
    expect(c.allPending()).toHaveLength(0);
  });

  it("approve() throws for unknown id", () => {
    const c = new LessonCurator(lessonsFile());
    expect(() => c.approve("nonexistent")).toThrow("Lesson not found");
  });

  it("matching returns approved lessons whose trigger appears in text", () => {
    const c = new LessonCurator(lessonsFile(), { autoYes: true });
    c.propose("auth", "Hash passwords", "run-1");
    c.propose("billing", "Use Stripe webhooks", "run-1");
    const matched = c.matching("We need to implement auth for the user system");
    expect(matched).toHaveLength(1);
    expect(matched[0].trigger).toBe("auth");
  });

  it("matching does not return pending lessons", () => {
    const c = new LessonCurator(lessonsFile());
    c.propose("auth", "Hash passwords", "run-1");
    const matched = c.matching("auth related context");
    expect(matched).toHaveLength(0);
  });

  it("persists across instances (run 1 → run 2)", () => {
    const c1 = new LessonCurator(lessonsFile(), { autoYes: true });
    c1.propose("database", "Use migrations", "run-1");
    const c2 = new LessonCurator(lessonsFile());
    expect(c2.allApproved()).toHaveLength(1);
    expect(c2.allApproved()[0].trigger).toBe("database");
  });

  it("toContextBlock includes matching lessons", () => {
    const c = new LessonCurator(lessonsFile(), { autoYes: true });
    c.propose("stripe", "Always verify webhook signatures", "run-1");
    const block = c.toContextBlock("add stripe billing");
    expect(block).toContain("Always verify webhook signatures");
  });
});

// ─── SkillStore ───────────────────────────────────────────────────────────────

describe("SkillStore", () => {
  const skillsFile = () => join(TMP, "skills.json");

  it("add and retrieve a skill", () => {
    const s = new SkillStore(skillsFile());
    const skill = s.add("bun-test", "Bun test runner usage", "Use bun:test for...", ["testing"]);
    expect(s.get(skill.id)).not.toBeNull();
    expect(s.get(skill.id)?.name).toBe("bun-test");
  });

  it("get returns null for unknown id", () => {
    const s = new SkillStore(skillsFile());
    expect(s.get("unknown")).toBeNull();
  });

  it("findByTag returns skills with matching tag", () => {
    const s = new SkillStore(skillsFile());
    s.add("skill-a", "desc", "content", ["auth"]);
    s.add("skill-b", "desc", "content", ["billing"]);
    s.add("skill-c", "desc", "content", ["auth", "billing"]);
    const authSkills = s.findByTag("auth");
    expect(authSkills).toHaveLength(2);
  });

  it("persists across instances (run 1 → run 2)", () => {
    const s1 = new SkillStore(skillsFile());
    s1.add("deploy", "Deploy to Hetzner", "ssh ...", ["ops"]);
    const s2 = new SkillStore(skillsFile());
    expect(s2.all()).toHaveLength(1);
    expect(s2.all()[0].name).toBe("deploy");
  });

  it("toContextBlock includes skill names", () => {
    const s = new SkillStore(skillsFile());
    s.add("ci-setup", "GitHub Actions CI", "...", ["ci"]);
    const block = s.toContextBlock();
    expect(block).toContain("ci-setup");
    expect(block).toContain("ci");
  });
});

// ─── ProjectMemory ────────────────────────────────────────────────────────────

describe("ProjectMemory", () => {
  const memFile = () => join(TMP, "project-memory.json");

  it("markAnswered and isAnswered", () => {
    const m = new ProjectMemory(memFile());
    expect(m.isAnswered("q-1")).toBe(false);
    m.markAnswered("q-1");
    expect(m.isAnswered("q-1")).toBe(true);
  });

  it("answered question ids persist across instances (run 1 → run 2)", () => {
    const m1 = new ProjectMemory(memFile());
    m1.markAnswered("q-critical-1");
    m1.markAnswered("q-critical-2");
    const m2 = new ProjectMemory(memFile());
    expect(m2.isAnswered("q-critical-1")).toBe(true);
    expect(m2.isAnswered("q-critical-2")).toBe(true);
  });

  it("answered questions from prior run are not re-asked (ids available)", () => {
    const m1 = new ProjectMemory(memFile());
    m1.markAnswered("target-user");
    m1.markAnswered("core-problem");
    const m2 = new ProjectMemory(memFile());
    const answered = m2.answeredIds();
    expect(answered).toContain("target-user");
    expect(answered).toContain("core-problem");
  });

  it("addCommand and commands()", () => {
    const m = new ProjectMemory(memFile());
    m.addCommand("Always use strict TypeScript");
    expect(m.commands()).toContain("Always use strict TypeScript");
  });

  it("toContextBlock includes commands", () => {
    const m = new ProjectMemory(memFile());
    m.addCommand("Use bun for all scripts");
    const block = m.toContextBlock();
    expect(block).toContain("Use bun for all scripts");
  });
});

// ─── assembleContext priority order ──────────────────────────────────────────

describe("assembleContext", () => {
  it("assembles blocks in priority order: prefs > commands > adrs > lessons > skills", () => {
    const result = assembleContext({
      prefs: "PREFS",
      commands: "COMMANDS",
      adrs: "ADRS",
      lessons: "LESSONS",
      skills: "SKILLS",
    });
    const prefsPos = result.indexOf("PREFS");
    const commandsPos = result.indexOf("COMMANDS");
    const adrsPos = result.indexOf("ADRS");
    const lessonsPos = result.indexOf("LESSONS");
    const skillsPos = result.indexOf("SKILLS");
    expect(prefsPos).toBeLessThan(commandsPos);
    expect(commandsPos).toBeLessThan(adrsPos);
    expect(adrsPos).toBeLessThan(lessonsPos);
    expect(lessonsPos).toBeLessThan(skillsPos);
  });

  it("omits empty blocks", () => {
    const result = assembleContext({
      prefs: "PREFS",
      commands: "",
      adrs: "ADRS",
      lessons: "",
      skills: "",
    });
    expect(result).toContain("PREFS");
    expect(result).toContain("ADRS");
    expect(result).not.toContain("COMMANDS");
  });
});
