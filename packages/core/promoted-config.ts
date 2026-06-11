import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { LoopBounds } from "./state-machine";

export interface PromotedConfig {
  loopBounds?: Partial<LoopBounds>;
  systemPrompts?: Record<string, string>;
}

interface PromotionRecord {
  candidateId: string;
  config: PromotedConfig & Record<string, unknown>;
  promotedAt: string;
}

/**
 * Load the effective harness configuration from promoted candidates.
 *
 * Promotions are applied in order; any promotion whose config also appears in
 * rejections.json (rolled back after re-validation) is skipped. The result is
 * the merged config the self-improvement loop has validated — used as the
 * default for normal builds so improvements aren't confined to the eval
 * harness.
 */
export function loadPromotedConfig(harnessDir: string): PromotedConfig {
  const promotionsPath = join(harnessDir, "promotions.json");
  if (!existsSync(promotionsPath)) return {};

  let promotions: PromotionRecord[];
  try {
    promotions = JSON.parse(readFileSync(promotionsPath, "utf8"));
  } catch {
    return {};
  }

  const rejected = loadRejectedKeys(join(harnessDir, "rejections.json"));

  const merged: PromotedConfig = {};
  for (const p of promotions) {
    if (!p?.config) continue;
    if (rejected.has(JSON.stringify(p.config))) continue;

    if (p.config.loopBounds) {
      merged.loopBounds = { ...merged.loopBounds, ...p.config.loopBounds };
    }
    if (p.config.systemPrompts) {
      merged.systemPrompts = { ...merged.systemPrompts, ...p.config.systemPrompts };
    }
  }
  return merged;
}

function loadRejectedKeys(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  try {
    const list = JSON.parse(readFileSync(path, "utf8")) as unknown[];
    return new Set(list.map((c) => JSON.stringify(c)));
  } catch {
    return new Set();
  }
}
