import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadPromotedConfig } from "./promoted-config";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "promoted-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePromotions(records: unknown[]): void {
  writeFileSync(join(dir, "promotions.json"), JSON.stringify(records), "utf8");
}

function writeRejections(configs: unknown[]): void {
  writeFileSync(join(dir, "rejections.json"), JSON.stringify(configs), "utf8");
}

describe("loadPromotedConfig", () => {
  it("returns empty config when no promotions file exists", () => {
    expect(loadPromotedConfig(dir)).toEqual({});
  });

  it("merges loopBounds from a promotion", () => {
    writePromotions([
      { candidateId: "c1", config: { loopBounds: { maxReview: 3 } }, promotedAt: "t" },
    ]);
    expect(loadPromotedConfig(dir).loopBounds).toEqual({ maxReview: 3 });
  });

  it("merges systemPrompts from a promotion", () => {
    writePromotions([
      { candidateId: "c1", config: { systemPrompts: { implementer: "be careful" } }, promotedAt: "t" },
    ]);
    expect(loadPromotedConfig(dir).systemPrompts).toEqual({ implementer: "be careful" });
  });

  it("skips promotions whose config was later rejected (rollback)", () => {
    writePromotions([
      { candidateId: "c1", config: { loopBounds: { maxReview: 3 } }, promotedAt: "t1" },
      { candidateId: "c2", config: { systemPrompts: { implementer: "converge" } }, promotedAt: "t2" },
    ]);
    writeRejections([{ loopBounds: { maxReview: 3 } }]);

    const cfg = loadPromotedConfig(dir);
    expect(cfg.loopBounds).toBeUndefined();
    expect(cfg.systemPrompts).toEqual({ implementer: "converge" });
  });

  it("later promotions override earlier ones for the same key", () => {
    writePromotions([
      { candidateId: "c1", config: { systemPrompts: { implementer: "v1" } }, promotedAt: "t1" },
      { candidateId: "c2", config: { systemPrompts: { implementer: "v2" } }, promotedAt: "t2" },
    ]);
    expect(loadPromotedConfig(dir).systemPrompts).toEqual({ implementer: "v2" });
  });

  it("tolerates corrupt promotions.json", () => {
    writeFileSync(join(dir, "promotions.json"), "{not json", "utf8");
    expect(loadPromotedConfig(dir)).toEqual({});
  });
});
