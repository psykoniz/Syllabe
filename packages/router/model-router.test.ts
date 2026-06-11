import { describe, it, expect } from "bun:test";
import { resolveModel, fallbackModel, MODEL_IDS, DECISION_ROLES } from "./model-router";
import type { Role } from "./model-router";

describe("resolveModel", () => {
  it("product-strategist → opus", () => {
    expect(resolveModel("product-strategist")).toBe(MODEL_IDS.opus);
  });
  it("architect → opus", () => {
    expect(resolveModel("architect")).toBe(MODEL_IDS.opus);
  });
  it("reviewer → opus", () => {
    expect(resolveModel("reviewer")).toBe(MODEL_IDS.opus);
  });
  it("implementer → sonnet", () => {
    expect(resolveModel("implementer")).toBe(MODEL_IDS.sonnet);
  });
  it("test-engineer → sonnet", () => {
    expect(resolveModel("test-engineer")).toBe(MODEL_IDS.sonnet);
  });
  it("memory-curator → haiku", () => {
    expect(resolveModel("memory-curator")).toBe(MODEL_IDS.haiku);
  });
  it("harness-optimizer analysis → opus", () => {
    expect(resolveModel("harness-optimizer", "analysis")).toBe(MODEL_IDS.opus);
  });
  it("harness-optimizer implementation → sonnet", () => {
    expect(resolveModel("harness-optimizer", "implementation")).toBe(MODEL_IDS.sonnet);
  });
  it("harness-optimizer default (no phase) → opus", () => {
    expect(resolveModel("harness-optimizer")).toBe(MODEL_IDS.opus);
  });
});

describe("fallbackModel", () => {
  it("implementer falls back to haiku", () => {
    expect(fallbackModel("implementer")).toBe(MODEL_IDS.haiku);
  });
  it("test-engineer falls back to haiku", () => {
    expect(fallbackModel("test-engineer")).toBe(MODEL_IDS.haiku);
  });
  it("memory-curator stays on haiku (already cheapest)", () => {
    expect(fallbackModel("memory-curator")).toBe(MODEL_IDS.haiku);
  });
  it("architect returns null (decision role — no fallback)", () => {
    expect(fallbackModel("architect")).toBeNull();
  });
  it("reviewer returns null (decision role — no fallback)", () => {
    expect(fallbackModel("reviewer")).toBeNull();
  });
  it("product-strategist returns null (decision role — no fallback)", () => {
    expect(fallbackModel("product-strategist")).toBeNull();
  });
});

describe("DECISION_ROLES", () => {
  it("contains architect, reviewer, product-strategist", () => {
    expect(DECISION_ROLES.has("architect")).toBe(true);
    expect(DECISION_ROLES.has("reviewer")).toBe(true);
    expect(DECISION_ROLES.has("product-strategist")).toBe(true);
  });
  it("does not contain implementer or test-engineer", () => {
    expect(DECISION_ROLES.has("implementer")).toBe(false);
    expect(DECISION_ROLES.has("test-engineer")).toBe(false);
  });
});
