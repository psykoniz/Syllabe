import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

const ANTHROPIC_MODELS = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6  (fast, $3/M)" },
  { id: "claude-opus-4-8",   label: "Opus 4.8  (best, $5/M)" },
  { id: "claude-haiku-4-5",  label: "Haiku 4.5  (cheap, $1/M)" },
];

const OPENAI_MODELS = [
  { id: "gpt-5.5",    label: "GPT-5.5  (latest)" },
  { id: "gpt-4o",     label: "GPT-4o" },
  { id: "gpt-4o-mini", label: "GPT-4o mini  (cheap)" },
];

interface Props {
  onClose: () => void;
}

export default function NewRunModal({ onClose }: Props) {
  const [task, setTask] = useState("");
  const [provider, setProvider] = useState<"anthropic" | "openai">("openai");
  const [model, setModel] = useState("gpt-5.5");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://codex-everywhere.com");
  const [repoUrl, setRepoUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [autoYes, setAutoYes] = useState(true);
  const [sandbox, setSandbox] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();

  // Reset model when provider changes
  useEffect(() => {
    setModel(provider === "openai" ? "gpt-5.5" : "claude-sonnet-4-6");
  }, [provider]);

  useEffect(() => {
    textareaRef.current?.focus();
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const submit = async () => {
    if (!task.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { task: task.trim(), model, autoYes, sandbox };
      if (repoUrl.trim()) {
        body.repoUrl = repoUrl.trim();
        body.baseBranch = baseBranch.trim() || "main";
      }
      if (provider === "openai") {
        body.provider = "openai";
        if (apiKey.trim()) body.apiKey = apiKey.trim();
        if (baseUrl.trim()) body.baseUrl = baseUrl.trim();
      }
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const { runId } = await res.json() as { runId: string };
      onClose();
      navigate(`/runs/${runId}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
  };

  const models = provider === "openai" ? OPENAI_MODELS : ANTHROPIC_MODELS;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-lg">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-800">
          <div>
            <h2 className="text-base font-semibold text-gray-100">New Run</h2>
            <p className="text-xs text-gray-500 mt-0.5">Describe what you want to build</p>
          </div>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors text-xl leading-none">
            ×
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {/* Task */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Task</label>
            <textarea
              ref={textareaRef}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={handleKey}
              rows={4}
              placeholder="e.g. Build a REST API with CRUD endpoints for a todo app using TypeScript and Bun..."
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 resize-none transition-colors"
            />
            <p className="text-xs text-gray-600 mt-1">⌘ + Enter to launch</p>
          </div>

          {/* Existing repository */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Repository (optional)</label>
            <input
              type="text"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/org/repo.git or /abs/local/path — leave blank for empty workspace"
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors font-mono"
            />
            {repoUrl.trim() && (
              <div className="mt-2">
                <label className="block text-xs font-medium text-gray-400 mb-1.5">Base branch</label>
                <input
                  type="text"
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.target.value)}
                  className="w-40 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors font-mono"
                />
                <p className="text-xs text-gray-600 mt-1">Credentials in the URL are used for cloning only and never stored.</p>
              </div>
            )}
          </div>

          {/* Provider toggle */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Provider</label>
            <div className="flex items-center gap-1 bg-gray-950 border border-gray-700 rounded-lg p-1 w-fit">
              <button
                onClick={() => setProvider("openai")}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  provider === "openai"
                    ? "bg-green-700 text-green-100"
                    : "text-gray-400 hover:text-gray-200"
                }`}
              >
                OpenAI
              </button>
              <button
                onClick={() => setProvider("anthropic")}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  provider === "anthropic"
                    ? "bg-blue-700 text-blue-100"
                    : "text-gray-400 hover:text-gray-200"
                }`}
              >
                Anthropic
              </button>
            </div>
          </div>

          {/* Model */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>

          {/* OpenAI credentials (collapsible) */}
          {provider === "openai" && (
            <div className="space-y-2 bg-gray-950/50 border border-gray-800 rounded-lg px-3 py-3">
              <p className="text-xs text-gray-500">Leave blank to use server env vars (OPENAI_API_KEY / OPENAI_BASE_URL)</p>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="API Key (optional)"
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500/30 transition-colors font-mono"
              />
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="Base URL (optional, e.g. https://proxy.example.com)"
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500/30 transition-colors"
              />
            </div>
          )}

          {/* Options */}
          <div className="flex gap-6">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoYes}
                onChange={(e) => setAutoYes(e.target.checked)}
                className="w-4 h-4 rounded bg-gray-800 border-gray-600 text-blue-500 focus:ring-blue-500/30"
              />
              <span className="text-sm text-gray-300">Auto-approve</span>
              <span className="text-xs text-gray-600">(skip confirmation prompts)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={sandbox}
                onChange={(e) => setSandbox(e.target.checked)}
                className="w-4 h-4 rounded bg-gray-800 border-gray-600 text-blue-500 focus:ring-blue-500/30"
              />
              <span className="text-sm text-gray-300">Docker sandbox</span>
            </label>
          </div>

          {error && (
            <div className="bg-red-950/50 border border-red-800 rounded-lg px-3 py-2 text-red-300 text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!task.trim() || loading}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
          >
            {loading ? "Launching…" : "Launch Run →"}
          </button>
        </div>
      </div>
    </div>
  );
}
