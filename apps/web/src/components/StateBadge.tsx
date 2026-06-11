import { phaseGroup, isRunning } from "../types";

const GROUP_CLASSES: Record<string, string> = {
  planning:  "bg-blue-500/15 text-blue-300 border border-blue-500/30",
  working:   "bg-amber-500/15 text-amber-300 border border-amber-500/30",
  quality:   "bg-purple-500/15 text-purple-300 border border-purple-500/30",
  finishing: "bg-green-500/15 text-green-300 border border-green-500/30",
  escalated: "bg-red-500/15 text-red-300 border border-red-500/30",
};

export default function StateBadge({ state }: { state: string }) {
  const group = phaseGroup(state);
  const running = isRunning(state) && group !== "finishing";
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${GROUP_CLASSES[group]}`}>
      {running && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 bg-current" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-current" />
        </span>
      )}
      {state}
    </span>
  );
}
