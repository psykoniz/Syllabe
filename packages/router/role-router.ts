import {
  resolveModel,
  fallbackModel,
  DECISION_ROLES,
  type Role,
  type ModelId,
  type HarnessOptimizerPhase,
} from "./model-router";

export type FailurePolicy = "fallback" | "escalate";

export interface RouteResult {
  modelId: ModelId;
  fallbackUsed: boolean;
}

export interface EscalationEvent {
  role: Role;
  reason: string;
  originalModel: ModelId;
}

export interface RoleRouterOptions {
  onEscalate: (event: EscalationEvent) => void;
}

export class RoleRouter {
  constructor(private opts: RoleRouterOptions) {}

  route(role: Role, phase?: HarnessOptimizerPhase): RouteResult {
    return {
      modelId: resolveModel(role, phase),
      fallbackUsed: false,
    };
  }

  handleModelError(role: Role, error: string, phase?: HarnessOptimizerPhase): RouteResult {
    const originalModel = resolveModel(role, phase);

    if (DECISION_ROLES.has(role)) {
      this.opts.onEscalate({ role, reason: error, originalModel });
      // Return original model — caller must respect escalation and not proceed
      return { modelId: originalModel, fallbackUsed: false };
    }

    const fb = fallbackModel(role);
    if (fb) {
      return { modelId: fb, fallbackUsed: true };
    }

    this.opts.onEscalate({ role, reason: `no fallback available: ${error}`, originalModel });
    return { modelId: originalModel, fallbackUsed: false };
  }
}
