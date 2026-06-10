export const MODEL_IDS = {
  fable:  "claude-fable-5",
  opus:   "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
  haiku:  "claude-haiku-4-5",
} as const;

export type ModelTier = keyof typeof MODEL_IDS;
export type ModelId = (typeof MODEL_IDS)[ModelTier];

export type Role =
  | "product-strategist"
  | "architect"
  | "reviewer"
  | "implementer"
  | "test-engineer"
  | "memory-curator"
  | "harness-optimizer";

export type HarnessOptimizerPhase = "analysis" | "implementation";

// Decision roles: never silently downgrade
export const DECISION_ROLES = new Set<Role>([
  "product-strategist",
  "architect",
  "reviewer",
]);

const ROLE_TIER: Record<Exclude<Role, "harness-optimizer">, ModelTier> = {
  "product-strategist": "fable",
  "architect":          "fable",
  "reviewer":           "fable",
  "implementer":        "sonnet",
  "test-engineer":      "sonnet",
  "memory-curator":     "haiku",
};

const FALLBACK_TIER: Partial<Record<ModelTier, ModelTier>> = {
  sonnet: "haiku",
  haiku:  "haiku", // already cheapest, stay
};

export function resolveModel(role: Role, phase?: HarnessOptimizerPhase): ModelId {
  if (role === "harness-optimizer") {
    return MODEL_IDS[phase === "implementation" ? "sonnet" : "fable"];
  }
  return MODEL_IDS[ROLE_TIER[role]];
}

export function fallbackModel(role: Role): ModelId | null {
  if (DECISION_ROLES.has(role)) return null; // no fallback for decision roles
  if (role === "harness-optimizer") return MODEL_IDS.haiku;
  const tier = ROLE_TIER[role as Exclude<Role, "harness-optimizer">];
  const fallback = FALLBACK_TIER[tier];
  return fallback ? MODEL_IDS[fallback] : null;
}
