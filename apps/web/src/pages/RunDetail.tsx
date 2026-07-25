import { useEffect, useState, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { RunDetail, TraceEvent, DiffResponse } from "../types";
import StateBadge from "../components/StateBadge";
import { formatCost, formatDate, formatDuration, formatTokens } from "../utils";

export default function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<TraceEvent[]>([]);
  const [sseConnected, setSseConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const timelineEndRef = useRef<HTMLDivElement>(null);

  // Replay mode state
  const [replayMode, setReplayMode] = useState(false);
  const [scrubberIndex, setScrubberIndex] = useState(0);

  // Repo diff state
  const [diffData, setDiffData] = useState<DiffResponse | null>(null);

  // Mid-run steering
  const [steerText, setSteerText] = useState("");
  const [steerStatus, setSteerStatus] = useState<"idle" | "sending" | "queued" | "error">("idle");

  const sendSteering = async () => {
    const text = steerText.trim();
    if (!text || !id) return;
    setSteerStatus("sending");
    try {
      const res = await fetch(`/api/runs/${id}/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSteerText("");
      setSteerStatus("queued");
      setTimeout(() => setSteerStatus("idle"), 3000);
    } catch {
      setSteerStatus("error");
      setTimeout(() => setSteerStatus("idle"), 3000);
    }
  };

  const loadDiff = async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/runs/${id}/diff`);
      if (res.ok) setDiffData((await res.json()) as DiffResponse);
    } catch {
      // diff is best-effort
    }
  };

  useEffect(() => {
    if (!id) return;

    const load = async () => {
      try {
        const res = await fetch(`/api/runs/${id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as RunDetail;
        setDetail(data);
        // Seed live events from initial load
        setLiveEvents(data.traces);
        // Initialize scrubber to last event
        if (data.traces.length > 0) {
          setScrubberIndex(data.traces.length - 1);
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    };
    load();
    loadDiff();

    // SSE
    const es = new EventSource(`/api/runs/${id}/events`);
    eventSourceRef.current = es;
    setSseConnected(true);

    const seen = new Set<string>();
    es.onmessage = (event) => {
      try {
        const trace = JSON.parse(event.data as string) as TraceEvent;
        const key = `${trace.ts}-${trace.phase}`;
        if (!seen.has(key)) {
          seen.add(key);
          setLiveEvents((prev) => {
            const exists = prev.some((e) => e.ts === trace.ts && e.phase === trace.phase);
            if (exists) return prev;
            const next = [...prev, trace];
            // Advance scrubber in live mode
            setScrubberIndex(next.length - 1);
            return next;
          });
        }
      } catch {
        // ignore
      }
    };

    es.onerror = () => {
      setSseConnected(false);
    };

    return () => {
      es.close();
    };
  }, [id]);

  // Auto-scroll timeline in live mode
  useEffect(() => {
    if (!replayMode) {
      timelineEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [liveEvents, replayMode]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <span className="text-gray-500 text-sm">Loading run...</span>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <button onClick={() => navigate("/")} className="text-gray-500 hover:text-gray-300 text-sm mb-6">
          &larr; Back
        </button>
        <div className="bg-red-950/50 border border-red-800 rounded-lg px-4 py-3 text-red-300 text-sm">
          {error ?? "Run not found"}
        </div>
      </div>
    );
  }

  const { run, checkpoints, cost } = detail;

  // Replay helpers
  const displayEvents = replayMode ? liveEvents.slice(0, scrubberIndex + 1) : liveEvents;
  const maxIndex = Math.max(0, liveEvents.length - 1);

  // Price table kept in sync with @projectos/telemetry MODEL_PRICES.
  // Duplicated here (not imported) to keep the browser bundle free of the
  // telemetry package's fs-backed modules (traces/replay). Update both together.
  const MODEL_PRICES: Record<string, [number, number]> = {
    "claude-fable-5":    [10, 50],
    "claude-opus-4-8":   [5,  25],
    "claude-sonnet-4-6": [3,  15],
    "claude-haiku-4-5":  [1,   5],
    "gpt-5.5":           [10, 40],
    "gpt-5.4":           [10, 40],
    "gpt-4o":            [2.5, 10],
    "gpt-4o-mini":       [0.15, 0.6],
  };

  function calcEventCost(model: string, inputTokens: number, outputTokens: number): number {
    // Unknown model → 0 (matches server priceFor) rather than guessing sonnet rates.
    const [inRate, outRate] = MODEL_PRICES[model] ?? [0, 0];
    return (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate;
  }

  const cumStats = displayEvents.reduce(
    (acc, ev) => ({
      inputTokens: acc.inputTokens + ev.inputTokens,
      outputTokens: acc.outputTokens + ev.outputTokens,
      costUsd: acc.costUsd + calcEventCost(ev.model, ev.inputTokens, ev.outputTokens),
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 }
  );

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => navigate("/")}
          className="text-gray-500 hover:text-gray-300 text-sm transition-colors"
        >
          &larr; Back
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-mono text-gray-300">{id}</h1>
            <StateBadge state={run.state} />
            {sseConnected && !replayMode && (
              <span className="flex items-center gap-1.5 text-xs text-green-400">
                <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
                Live
              </span>
            )}
          </div>
          {run.escalation_reason && (
            <p className="text-sm text-red-400 mt-1">{run.escalation_reason}</p>
          )}
        </div>
        {/* Live / Replay toggle */}
        <div className="flex items-center gap-1 bg-gray-900 border border-gray-700 rounded-lg p-1">
          <button
            onClick={() => setReplayMode(false)}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              !replayMode
                ? "bg-green-700 text-green-100"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            Live
          </button>
          <button
            onClick={() => {
              setReplayMode(true);
              setScrubberIndex(maxIndex);
            }}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              replayMode
                ? "bg-amber-700 text-amber-100"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            Replay
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Total Cost" value={formatCost(cost.totalUsd)} />
        <StatCard
          label="Total Tokens"
          value={formatTokens(
            Object.values(cost.byModel).reduce((s, m) => s + m.inputTokens + m.outputTokens, 0)
          )}
        />
        <StatCard label="Phases" value={String(checkpoints.length)} />
        <StatCard label="Work Unit" value={String(run.work_unit_index + 1)} />
      </div>

      {/* Replay controls */}
      {replayMode && liveEvents.length > 0 && (
        <div className="bg-gray-900 border border-amber-800/50 rounded-xl px-4 py-3 space-y-3">
          {/* Mini summary bar */}
          <div className="flex items-center gap-6 text-xs text-gray-400">
            <span className="text-amber-300 font-medium">
              Event {scrubberIndex + 1} / {liveEvents.length}
            </span>
            <span>
              In: <span className="text-gray-200 tabular-nums">{formatTokens(cumStats.inputTokens)}</span>
            </span>
            <span>
              Out: <span className="text-gray-200 tabular-nums">{formatTokens(cumStats.outputTokens)}</span>
            </span>
            <span>
              Cost: <span className="text-green-400 tabular-nums">{formatCost(cumStats.costUsd)}</span>
            </span>
          </div>

          {/* Scrubber */}
          <input
            type="range"
            min={0}
            max={maxIndex}
            value={scrubberIndex}
            onChange={(e) => setScrubberIndex(Number(e.target.value))}
            className="w-full accent-amber-500 cursor-pointer"
          />

          {/* Step controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setScrubberIndex((i) => Math.max(0, i - 1))}
              disabled={scrubberIndex === 0}
              className="px-3 py-1 text-xs rounded bg-gray-800 border border-gray-700 text-gray-300 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              &larr; Prev
            </button>
            <button
              onClick={() => setScrubberIndex((i) => Math.min(maxIndex, i + 1))}
              disabled={scrubberIndex === maxIndex}
              className="px-3 py-1 text-xs rounded bg-gray-800 border border-gray-700 text-gray-300 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Next &rarr;
            </button>
            <button
              onClick={() => setScrubberIndex(0)}
              className="px-3 py-1 text-xs rounded bg-gray-800 border border-gray-700 text-gray-400 hover:bg-gray-700 transition-colors"
            >
              &#8676; Start
            </button>
            <button
              onClick={() => setScrubberIndex(maxIndex)}
              className="px-3 py-1 text-xs rounded bg-gray-800 border border-gray-700 text-gray-400 hover:bg-gray-700 transition-colors"
            >
              End &#8677;
            </button>
          </div>
        </div>
      )}

      {/* Mid-run steering — visible while the run is active */}
      {!["COMPLETE", "ESCALATED"].includes(run.state.toUpperCase()) && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={steerText}
            onChange={(e) => setSteerText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") sendSteering(); }}
            placeholder="Send an instruction to the agent (applied at the next step)…"
            className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500/30 transition-colors"
          />
          <button
            onClick={sendSteering}
            disabled={!steerText.trim() || steerStatus === "sending"}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
          >
            {steerStatus === "sending" ? "Sending…" : "Steer"}
          </button>
          {steerStatus === "queued" && <span className="text-xs text-green-400">✓ queued</span>}
          {steerStatus === "error" && <span className="text-xs text-red-400">failed</span>}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Timeline */}
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
            {replayMode ? "Replay Events" : "Trace Events"}
          </h2>
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            {displayEvents.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-600 text-sm">No trace events yet</div>
            ) : (
              <div className="divide-y divide-gray-800/50 max-h-[600px] overflow-y-auto">
                {displayEvents.map((ev, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-3 px-4 py-3 hover:bg-gray-800/30 transition-colors ${
                      replayMode && i === scrubberIndex ? "bg-amber-900/20 border-l-2 border-amber-500" : ""
                    }`}
                  >
                    <div className="flex-shrink-0 w-20 text-xs text-gray-600 pt-0.5 tabular-nums">
                      {new Date(ev.ts).toLocaleTimeString()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-xs font-medium text-amber-300">{ev.phase}</span>
                        <span className="text-gray-700 text-xs">/</span>
                        <span className="text-xs text-gray-400">{ev.role}</span>
                      </div>
                      <div className="text-xs text-gray-500 font-mono truncate">{ev.model}</div>
                    </div>
                    <div className="flex-shrink-0 text-right text-xs text-gray-600 tabular-nums space-y-0.5">
                      <div>{formatTokens(ev.inputTokens + ev.outputTokens)} tok</div>
                      <div>{formatDuration(ev.durationMs)}</div>
                    </div>
                  </div>
                ))}
                <div ref={timelineEndRef} />
              </div>
            )}
          </div>

        {/* Changes — only for repo-backed runs */}
          {run.git_url && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                  Changes
                  {diffData?.workBranch && (
                    <span className="ml-2 font-mono text-xs text-blue-400 normal-case">{diffData.workBranch}</span>
                  )}
                </h2>
                <button
                  onClick={loadDiff}
                  className="px-3 py-1 text-xs rounded bg-gray-800 border border-gray-700 text-gray-400 hover:bg-gray-700 transition-colors"
                >
                  ↻ Refresh
                </button>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                {!diffData?.diff ? (
                  <div className="px-4 py-8 text-center text-gray-600 text-sm">No changes yet</div>
                ) : (
                  <>
                    {diffData.stat && (
                      <pre className="px-4 py-3 text-xs text-gray-400 border-b border-gray-800 overflow-x-auto">{diffData.stat}</pre>
                    )}
                    <pre className="px-4 py-3 text-xs leading-relaxed overflow-x-auto max-h-[500px] overflow-y-auto">
                      {diffData.diff.split("\n").map((line, i) => (
                        <div key={i} className={diffLineClass(line)}>{line || " "}</div>
                      ))}
                    </pre>
                    {diffData.truncated && (
                      <div className="px-4 py-2 text-xs text-amber-400 border-t border-gray-800">Diff truncated (1 MB cap)</div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="space-y-6">
          {/* Phase history */}
          <div>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Phase History
            </h2>
            <div className="space-y-1">
              {checkpoints.map((cp, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <StateBadge state={cp.state} />
                  <span className="text-gray-600">{new Date(cp.ts).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Cost breakdown */}
          {Object.keys(cost.byModel).length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
                Cost Breakdown
              </h2>
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-800">
                      <th className="text-left px-3 py-2 text-gray-600">Model</th>
                      <th className="text-right px-3 py-2 text-gray-600">In</th>
                      <th className="text-right px-3 py-2 text-gray-600">Out</th>
                      <th className="text-right px-3 py-2 text-gray-600">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/50">
                    {Object.entries(cost.byModel).map(([model, m]) => (
                      <tr key={model} className="hover:bg-gray-800/30">
                        <td className="px-3 py-2 text-gray-400 font-mono truncate max-w-[120px]">
                          {model.replace("claude-", "")}
                        </td>
                        <td className="px-3 py-2 text-right text-gray-500 tabular-nums">
                          {formatTokens(m.inputTokens)}
                        </td>
                        <td className="px-3 py-2 text-right text-gray-500 tabular-nums">
                          {formatTokens(m.outputTokens)}
                        </td>
                        <td className="px-3 py-2 text-right text-green-400 tabular-nums">
                          {formatCost(m.usd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-gray-700">
                      <td colSpan={3} className="px-3 py-2 text-gray-400 font-medium">Total</td>
                      <td className="px-3 py-2 text-right text-green-300 font-semibold tabular-nums">
                        {formatCost(cost.totalUsd)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-green-400";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-red-400";
  if (line.startsWith("@@") || line.startsWith("diff --git")) return "text-gray-500";
  return "text-gray-300";
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-lg font-semibold text-gray-100 tabular-nums">{value}</p>
    </div>
  );
}
