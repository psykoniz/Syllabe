import type { InterviewQuestion } from "./interview";

// Default question bank — used when no model-generated questions are available.
// For a real run the product-strategist agent generates these from the brief.
export const DEFAULT_QUESTIONS: InterviewQuestion[] = [
  {
    id: "target-user",
    text: "Who is the primary user of this product?",
    impact: "critical",
    default: "Individual developers / small teams",
    defaultRationale: "Most SaaS products target this segment without further specification",
  },
  {
    id: "core-problem",
    text: "What is the single most important problem this product solves?",
    impact: "critical",
    default: "Reducing manual, repetitive work",
    defaultRationale: "The most common motivation for building tooling products",
  },
  {
    id: "success-metric",
    text: "How will you measure whether this product is successful in 3 months?",
    impact: "critical",
    default: "Weekly active users > 10",
    defaultRationale: "Minimal traction threshold for early-stage products",
  },
  {
    id: "tech-stack",
    text: "Is there a preferred technology stack?",
    impact: "important",
    default: "TypeScript + Node/Bun, SQLite for persistence",
    defaultRationale: "Matches the ProjectOS harness stack for minimal friction",
  },
  {
    id: "auth-required",
    text: "Does the product require user authentication?",
    impact: "important",
    default: "Yes — email + password, no OAuth for MVP",
    defaultRationale: "Simplest auth that covers most MVP use cases",
    options: ["Yes — email + password", "Yes — OAuth (Google/GitHub)", "No auth for MVP"],
  },
  {
    id: "deployment-target",
    text: "Where will this product be deployed?",
    impact: "important",
    default: "Single VPS (e.g. Hetzner CX22)",
    defaultRationale: "Lowest-cost deployment for early products",
    options: ["Single VPS", "Vercel / Netlify", "AWS / GCP / Azure", "Local only"],
  },
  {
    id: "billing",
    text: "Will the product have paid plans?",
    impact: "optional",
    default: "No billing for MVP",
    defaultRationale: "Deferring billing reduces scope and avoids Stripe complexity at MVP stage",
    options: ["No billing for MVP", "One-time purchase", "Subscription (Stripe)"],
  },
];

export function buildQuestions(overrides: Partial<InterviewQuestion>[] = []): InterviewQuestion[] {
  if (overrides.length === 0) return DEFAULT_QUESTIONS;
  return DEFAULT_QUESTIONS.map((q) => {
    const override = overrides.find((o) => o.id === q.id);
    return override ? { ...q, ...override } : q;
  });
}

export function criticalQuestions(questions: InterviewQuestion[]): InterviewQuestion[] {
  return questions.filter((q) => q.impact === "critical");
}
