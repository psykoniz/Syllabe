import { useEffect, useState } from "react";
import type { PendingApproval } from "../types";

export default function ApprovalQueue() {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [open, setOpen] = useState(false);
  const [processing, setProcessing] = useState<Set<string>>(new Set());

  useEffect(() => {
    const fetchApprovals = async () => {
      try {
        const res = await fetch("/api/approvals");
        if (res.ok) {
          const data = (await res.json()) as PendingApproval[];
          setApprovals(data);
        }
      } catch {
        // ignore
      }
    };
    fetchApprovals();
    const interval = setInterval(fetchApprovals, 3000);
    return () => clearInterval(interval);
  }, []);

  const decide = async (runId: string, decision: "approve" | "deny") => {
    const key = `${runId}-${decision}`;
    setProcessing((p) => new Set(p).add(key));
    try {
      await fetch(`/api/runs/${runId}/${decision}`, { method: "POST" });
      setApprovals((prev) => prev.filter((a) => a.runId !== runId));
    } finally {
      setProcessing((p) => {
        const next = new Set(p);
        next.delete(key);
        return next;
      });
    }
  };

  if (approvals.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50">
      {/* Badge */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-gray-950 font-semibold px-4 py-2 rounded-full shadow-lg transition-colors"
      >
        <span className="w-5 h-5 bg-gray-950 text-amber-400 rounded-full text-xs flex items-center justify-center font-bold">
          {approvals.length}
        </span>
        Pending Approvals
      </button>

      {open && (
        <div className="absolute bottom-12 right-0 w-96 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-200">Approval Queue</span>
            <button
              onClick={() => setOpen(false)}
              className="text-gray-500 hover:text-gray-300 text-lg leading-none"
            >
              &times;
            </button>
          </div>
          <div className="divide-y divide-gray-800 max-h-96 overflow-y-auto">
            {approvals.map((a) => (
              <div key={`${a.runId}-${a.id}`} className="px-4 py-3">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-400 mb-0.5">
                      Run: <span className="text-gray-300 font-mono">{a.runId.slice(0, 8)}</span>
                    </p>
                    <p className="text-sm font-medium text-amber-300">{a.tool}</p>
                  </div>
                </div>
                {a.args !== undefined && (
                  <pre className="text-xs text-gray-400 bg-gray-950 rounded p-2 mb-3 overflow-x-auto max-h-24 overflow-y-auto">
                    {typeof a.args === "string" ? a.args : JSON.stringify(a.args, null, 2)}
                  </pre>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => decide(a.runId, "approve")}
                    disabled={processing.has(`${a.runId}-approve`)}
                    className="flex-1 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-xs font-medium py-1.5 rounded transition-colors"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => decide(a.runId, "deny")}
                    disabled={processing.has(`${a.runId}-deny`)}
                    className="flex-1 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-xs font-medium py-1.5 rounded transition-colors"
                  >
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
