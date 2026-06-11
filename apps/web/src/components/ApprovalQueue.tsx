import { useEffect, useState, useRef } from "react";
import type { PendingApproval } from "../types";

function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function notifyApproval(approval: PendingApproval) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("ProjectOS — approval needed", {
      body: `${approval.tool} · run ${approval.runId.slice(0, 8)}`,
      icon: "/favicon.ico",
      tag: `approval-${approval.runId}`,
    });
  }
}

export default function ApprovalQueue() {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [open, setOpen] = useState(false);
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  const knownIds = useRef(new Set<string>());

  useEffect(() => {
    requestNotificationPermission();
  }, []);

  useEffect(() => {
    const fetchApprovals = async () => {
      try {
        const res = await fetch("/api/approvals");
        if (!res.ok) return;
        const data = (await res.json()) as PendingApproval[];
        setApprovals(data);

        // Notify for newly arrived approvals
        for (const a of data) {
          const key = `${a.runId}-${a.id}`;
          if (!knownIds.current.has(key)) {
            knownIds.current.add(key);
            notifyApproval(a);
          }
        }

        // Auto-open panel when new approvals arrive
        if (data.length > 0) setOpen(true);
      } catch {
        // ignore
      }
    };
    fetchApprovals();
    const interval = setInterval(fetchApprovals, 2000);
    return () => clearInterval(interval);
  }, []);

  const decide = async (runId: string, decision: "approve" | "deny") => {
    const key = `${runId}-${decision}`;
    setProcessing((p) => new Set(p).add(key));
    try {
      await fetch(`/api/runs/${runId}/${decision}`, { method: "POST" });
      setApprovals((prev) => prev.filter((a) => a.runId !== runId));
      if (approvals.length <= 1) setOpen(false);
    } finally {
      setProcessing((p) => { const next = new Set(p); next.delete(key); return next; });
    }
  };

  if (approvals.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50">
      {/* Badge */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-gray-950 font-semibold px-4 py-2.5 rounded-full shadow-lg shadow-amber-900/40 transition-colors"
      >
        <span className="w-5 h-5 bg-gray-950/30 text-gray-950 rounded-full text-xs flex items-center justify-center font-bold">
          {approvals.length}
        </span>
        Approval needed
      </button>

      {open && (
        <div className="absolute bottom-14 right-0 w-[22rem] bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
            <span className="text-sm font-semibold text-amber-300">Pending approvals</span>
            <button
              onClick={() => setOpen(false)}
              className="text-gray-500 hover:text-gray-300 transition-colors text-xl leading-none"
            >×</button>
          </div>
          <div className="divide-y divide-gray-800/60 max-h-96 overflow-y-auto">
            {approvals.map((a) => (
              <div key={`${a.runId}-${a.id}`} className="px-4 py-3.5">
                <p className="text-xs text-gray-500 mb-1">
                  Run <span className="text-gray-400 font-mono">{a.runId.slice(0, 8)}</span>
                </p>
                <p className="text-sm font-semibold text-amber-300 mb-2">{a.tool}</p>
                {a.args !== undefined && (
                  <pre className="text-xs text-gray-400 bg-gray-950 rounded-lg p-2.5 mb-3 overflow-x-auto max-h-20 overflow-y-auto">
                    {typeof a.args === "string" ? a.args : JSON.stringify(a.args, null, 2)}
                  </pre>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => decide(a.runId, "approve")}
                    disabled={processing.has(`${a.runId}-approve`)}
                    className="flex-1 bg-green-700/80 hover:bg-green-600 border border-green-600/50 disabled:opacity-50 text-white text-xs font-medium py-1.5 rounded-lg transition-colors"
                  >
                    ✓ Approve
                  </button>
                  <button
                    onClick={() => decide(a.runId, "deny")}
                    disabled={processing.has(`${a.runId}-deny`)}
                    className="flex-1 bg-red-900/50 hover:bg-red-800/60 border border-red-700/50 disabled:opacity-50 text-white text-xs font-medium py-1.5 rounded-lg transition-colors"
                  >
                    ✗ Deny
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
