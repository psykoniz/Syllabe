export type PhaseGroup = "planning" | "working" | "quality" | "finishing" | "error";

export function getPhaseGroup(state: string): PhaseGroup {
  switch (state) {
    case "INTAKE":
    case "CLARIFY":
    case "DESIGN":
    case "PLAN":
      return "planning";
    case "IMPLEMENT":
    case "TEST":
    case "REPAIR":
      return "working";
    case "REVIEW":
      return "quality";
    case "DOCUMENT":
    case "LEARN":
    case "COMPLETE":
      return "finishing";
    case "ESCALATED":
    default:
      return "error";
  }
}

export function getBadgeClasses(state: string): string {
  const group = getPhaseGroup(state);
  switch (group) {
    case "planning":
      return "bg-blue-900/60 text-blue-300 border border-blue-700/50";
    case "working":
      return "bg-amber-900/60 text-amber-300 border border-amber-700/50";
    case "quality":
      return "bg-purple-900/60 text-purple-300 border border-purple-700/50";
    case "finishing":
      return "bg-green-900/60 text-green-300 border border-green-700/50";
    case "error":
      return "bg-red-900/60 text-red-300 border border-red-700/50";
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function formatCost(usd: number): string {
  if (usd < 0.001) return "<$0.001";
  return `$${usd.toFixed(4)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function truncateId(id: string): string {
  return id.slice(0, 8);
}

export function formatDate(ts: string): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}
