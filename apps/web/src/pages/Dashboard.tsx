import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { RunSummary } from "../types";
import { isRunning } from "../types";
import StateBadge from "../components/StateBadge";
import ApprovalQueue from "../components/ApprovalQueue";
import NewRunModal from "../components/NewRunModal";
import { formatCost, formatDate, formatDuration, formatTokens, truncateId } from "../utils";

export default function Dashboard() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNewRun, setShowNewRun] = useState(false);
  const navigate = useNavigate();

  const load = async () => {
    try {
      const res = await fetch("/api/runs");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as RunSummary[];
      setRuns(data);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  const activeCount = runs.filter((r) => isRunning(r.state)).length;

  return (
    <div className="min-h-screen bg-gray-950">
      <nav className="border-b border-gray-800/70 bg-gray-950/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 bg-blue-600 rounded-lg flex items-center justify-center text-xs font-bold text-white">P</div>
            <span className="font-semibold text-gray-100 text-sm">ProjectOS</span>
            {activeCount > 0 && (
              <span className="flex items-center gap-1.5 text-xs text-amber-400 bg-amber-400/10 border border-amber-400/20 px-2 py-0.5 rounded-full">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 bg-amber-400" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-400" />
                </span>
                {activeCount} running
              </span>
            )}
          </div>
          <button
            onClick={() => setShowNewRun(true)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <span className="text-base leading-none">+</span> New Run
          </button>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-4 py-6">
        {error && (
          <div className="bg-red-950/40 border border-red-800/60 rounded-xl px-4 py-3 text-red-300 text-sm mb-5">
            ⚠ {error}
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center py-32">
            <div className="flex items-center gap-2 text-gray-600 text-sm">
              <div className="w-4 h-4 border-2 border-gray-700 border-t-blue-500 rounded-full animate-spin" />
              Loading…
            </div>
          </div>
        )}

        {!loading && runs.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center py-32 text-center">
            <div className="w-16 h-16 bg-gray-900 border border-gray-800 rounded-2xl flex items-center justify-center text-2xl mb-4">🤖</div>
            <h2 className="text-gray-300 font-medium mb-1">No runs yet</h2>
            <p className="text-gray-600 text-sm mb-6">Start your first AI agent run</p>
            <button
              onClick={() => setShowNewRun(true)}
              className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl transition-colors"
            >
              + New Run
            </button>
          </div>
        )}

        {runs.length > 0 && (
          <div className="bg-gray-900/60 border border-gray-800/60 rounded-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-gray-800/60">
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                {runs.length} run{runs.length !== 1 ? "s" : ""}
              </span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800/40">
                  <th className="text-left px-5 py-2.5 text-gray-600 font-medium text-xs uppercase tracking-wider">Task</th>
                  <th className="text-left px-4 py-2.5 text-gray-600 font-medium text-xs uppercase tracking-wider">State</th>
                  <th className="text-right px-4 py-2.5 text-gray-600 font-medium text-xs uppercase tracking-wider">Tokens</th>
                  <th className="text-right px-4 py-2.5 text-gray-600 font-medium text-xs uppercase tracking-wider">Cost</th>
                  <th className="text-right px-4 py-2.5 text-gray-600 font-medium text-xs uppercase tracking-wider">Duration</th>
                  <th className="text-right px-5 py-2.5 text-gray-600 font-medium text-xs uppercase tracking-wider">Started</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/30">
                {runs.map((run) => (
                  <tr
                    key={run.run_id}
                    onClick={() => navigate(`/runs/${run.run_id}`)}
                    className="hover:bg-gray-800/30 cursor-pointer transition-colors group"
                  >
                    <td className="px-5 py-3.5">
                      <div className="max-w-xs">
                        {run.task ? (
                          <p className="text-gray-200 text-sm truncate group-hover:text-white transition-colors">{run.task}</p>
                        ) : (
                          <span className="font-mono text-gray-500 text-xs">{truncateId(run.run_id)}…</span>
                        )}
                        <p className="font-mono text-gray-700 text-xs mt-0.5">{truncateId(run.run_id)}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <StateBadge state={run.state} />
                      {run.escalation_reason && (
                        <p className="text-xs text-red-400 mt-1 max-w-[12rem] truncate">{run.escalation_reason}</p>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-right text-gray-400 tabular-nums text-xs">
                      {run.totalInputTokens + run.totalOutputTokens > 0
                        ? formatTokens(run.totalInputTokens + run.totalOutputTokens)
                        : <span className="text-gray-700">—</span>}
                    </td>
                    <td className="px-4 py-3.5 text-right text-gray-400 tabular-nums text-xs">
                      {run.totalCostUsd > 0 ? formatCost(run.totalCostUsd) : <span className="text-gray-700">—</span>}
                    </td>
                    <td className="px-4 py-3.5 text-right text-gray-400 tabular-nums text-xs">
                      {run.durationMs > 0 ? formatDuration(run.durationMs) : <span className="text-gray-700">—</span>}
                    </td>
                    <td className="px-5 py-3.5 text-right text-gray-600 text-xs">{formatDate(run.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ApprovalQueue />
      {showNewRun && <NewRunModal onClose={() => setShowNewRun(false)} />}
    </div>
  );
}
