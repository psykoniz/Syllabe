#!/usr/bin/env bun
/**
 * CLI entry point for SWE-bench Lite evaluation.
 *
 * Examples:
 *   # Quick smoke test — 5 instances, gpt-5.5
 *   bun evals/swe-bench/run.ts --limit 5 --model-override gpt-5.5
 *
 *   # Subset of a single repo
 *   bun evals/swe-bench/run.ts --repo astropy/astropy --limit 10
 *
 *   # Full Lite (300 instances) — expensive, ~$150 at gpt-5.5 rates
 *   bun evals/swe-bench/run.ts --limit 300 --cost-cap 200
 *
 *   # Single instance for debugging
 *   bun evals/swe-bench/run.ts --instance-id astropy__astropy-12907
 *
 *   # With auto-steering critic
 *   bun evals/swe-bench/run.ts --limit 20 --auto-steering
 *
 * This is the SOLVE phase only: it produces a predictions JSONL. Score it
 * with the official Docker harness:
 *   bash evals/swe-bench/run-official-eval.sh <predictions.jsonl>
 */

import { loadSweBenchLite } from "./loader";
import { runSWEBenchSuite, formatSummary } from "./runner";

const args = process.argv.slice(2);

function flag(name: string): boolean {
  return args.includes(`--${name}`);
}

function opt(name: string, fallback?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const limit = parseInt(opt("limit", "10") as string, 10);
const offset = parseInt(opt("offset", "0") as string, 10);
const repoFilter = opt("repo") ? [opt("repo") as string] : undefined;
const instanceId = opt("instance-id");
const modelOverride = opt("model-override") ?? process.env.PROJECTOS_MODEL_OVERRIDE;
const costCap = parseFloat(opt("cost-cap", "50") as string);
const autoSteering = flag("auto-steering");

console.log("SWE-bench Lite — ProjectOS (solve phase → predictions)");
console.log(`Model:         ${modelOverride ?? "default (from env)"}`);
console.log(`Limit:         ${instanceId ? 1 : limit} instance(s)`);
console.log(`Cost cap:      $${costCap}`);
console.log(`Auto-steering: ${autoSteering}`);

const allInstances = await loadSweBenchLite({ limit: instanceId ? undefined : limit + offset, offset: 0, repoFilter });

const instances = instanceId
  ? allInstances.filter((i) => i.instance_id === instanceId)
  : allInstances.slice(offset, offset + limit);

if (instances.length === 0) {
  console.error(`No instances found (instanceId=${instanceId}, repoFilter=${repoFilter})`);
  process.exit(1);
}

console.log(`\nRunning ${instances.length} instance(s)...\n`);

const suite = await runSWEBenchSuite(instances, {
  modelOverride,
  autoSteering,
  costCapUsd: costCap,
  maxIterationsPerState: 15,
});

console.log("\n" + formatSummary(suite));
