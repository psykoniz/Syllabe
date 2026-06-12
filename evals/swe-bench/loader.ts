/**
 * SWE-bench Lite dataset loader.
 * Fetches instances from the HuggingFace dataset API and caches them locally.
 *
 * Dataset: princeton-nlp/SWE-bench_Lite (~300 instances from real GitHub issues)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const CACHE_DIR = join(process.env.HOME ?? "~", ".projectos", "swe-bench-cache");
const HF_BASE = "https://datasets-server.huggingface.co/rows";
const HF_DATASET = "princeton-nlp/SWE-bench_Lite";

export interface SweBenchInstance {
  instance_id: string;
  repo: string;           // e.g. "astropy/astropy"
  base_commit: string;    // commit to checkout before applying fix
  problem_statement: string;
  hints_text: string;
  test_patch: string;     // the tests that must now pass
  patch: string;          // gold patch (only used for reference, never shown to agent)
  FAIL_TO_PASS: string;   // JSON array of test ids that must go green
  PASS_TO_PASS: string;   // JSON array of test ids that must stay green
  environment_setup_commit: string;
  version: string;
}

export async function loadSweBenchLite(opts: {
  limit?: number;
  offset?: number;
  forceRefresh?: boolean;
  repoFilter?: string[]; // only include these repos e.g. ["astropy/astropy"]
} = {}): Promise<SweBenchInstance[]> {
  const cachePath = join(CACHE_DIR, "swe-bench-lite.json");

  let rows: SweBenchInstance[];

  if (!opts.forceRefresh && existsSync(cachePath)) {
    rows = JSON.parse(readFileSync(cachePath, "utf8"));
  } else {
    rows = [];
    let offset = 0;
    const pageSize = 100;
    console.log("Fetching SWE-bench Lite from HuggingFace (paginated)...");
    while (true) {
      const url = `${HF_BASE}?dataset=${encodeURIComponent(HF_DATASET)}&config=default&split=test&offset=${offset}&length=${pageSize}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HuggingFace fetch failed: ${res.status} ${res.statusText}`);
      const json = await res.json() as { rows: Array<{ row: SweBenchInstance }>; num_rows_total: number };
      const page = json.rows.map((r) => r.row);
      rows.push(...page);
      offset += pageSize;
      if (offset >= json.num_rows_total || page.length < pageSize) break;
    }
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(rows, null, 2));
    console.log(`Cached ${rows.length} instances to ${cachePath}`);
  }

  if (opts.repoFilter?.length) {
    rows = rows.filter((r) => opts.repoFilter!.includes(r.repo));
  }

  const start = opts.offset ?? 0;
  const end = start + (opts.limit ?? rows.length);
  return rows.slice(start, end);
}

/** Build the task prompt for an instance — never includes the gold patch. */
export function buildTaskPrompt(instance: SweBenchInstance): string {
  return [
    `You are working on the GitHub repository \`${instance.repo}\`.`,
    "",
    "## Issue to fix",
    instance.problem_statement,
    ...(instance.hints_text ? ["", "## Hints", instance.hints_text] : []),
    "",
    "## Requirements",
    "- Fix the issue described above.",
    "- Do NOT modify any test files.",
    "- Make sure existing tests still pass.",
    "- Do not add new dependencies unless strictly necessary.",
  ].join("\n");
}

/** Parse the FAIL_TO_PASS / PASS_TO_PASS JSON fields (stored as JSON strings in the dataset). */
export function parseTestList(raw: string): string[] {
  try {
    return JSON.parse(raw);
  } catch {
    return raw ? [raw] : [];
  }
}
