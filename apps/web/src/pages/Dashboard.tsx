import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { RunSummary } from "../types";
import StateBadge from "../components/StateBadge";
import ApprovalQueue from "../components/ApprovalQueue";
import { formatCost, formatDate, formatDuration, formatTokens, truncateId } from "../utils";

export default function Dashboard() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/runs");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as RunSummary[];
        setRuns(data);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    };
    load();
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">ProjectOS</h1>
          <p className="text-sm text-gray-500 mt-0.5">AI Agent Orchestrator Dashboard</p>
        </div>
        <div className="text-xs text-gray-600">
          {runs.length} run{runs.length !== 1 ? "s" : ""}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-24">
          <div className="text-gray-500 text-sm">Loading runs...</div>
        </div>
      )}

      {error && (
        <div className="bg-red-950/50 border border-red-800 rounded-lg px-4 py-3 text-red-300 text-sm mb-6">
          {error}
        </div>
      )}

      {!loading && runs.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <p className="text-gray-600 text-sm">No runs found.</p>
          <p className="text-gray-700 text-xs mt-1">
            Start a run with <code className="bg-gray-900 px-1 rounded">projectos build --task "..."</code>
          </p>
        </div>
      )}

      {runs.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider">
                  Run ID
                </th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider">
                  State
                </th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider">
                  Tokens
                </th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider">
                  Cost
                </th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider">
                  Duration
                </th>
                <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider">
                  Started
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {runs.map((run) => (
                <tr
                  key={run.run_id}
                  onClick={() => navigate(`/runs/${run.run_id}`)}
                  className="hover:bg-gray-800/40 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3">
                    <span className="font-mono text-gray-300 text-xs">{truncateId(run.run_id)}</span>
                    <span className="text-gray-700 text-xs font-mono">…</span>
                  </td>
                  <td className="px-4 py-3">
                    <StateBadge state={run.state} />
                    {run.escalation_reason && (
                      <p className="text-xs text-red-400 mt-0.5 max-w-xs truncate">{run.escalation_reason}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400 tabular-nums">
                    {run.totalInputTokens + run.totalOutputTokens > 0 ? (
                      <span>{formatTokens(run.totalInputTokens + run.totalOutputTokens)}</span>
                    ) : (
                      <span className="text-gray-700">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400 tabular-nums">
                    {run.totalCostUsd > 0 ? (
                      formatCost(run.totalCostUsd)
                    ) : (
                      <span className="text-gray-700">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400 tabular-nums">
                    {run.durationMs > 0 ? (
                      formatDuration(run.durationMs)
                    ) : (
                      <span className="text-gray-700">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {formatDate(run.startedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ApprovalQueue />
    </div>
  );
}
