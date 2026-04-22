#!/usr/bin/env node
/**
 * Multi-session binary rollup: reads `session-summary.json` + optional `sessions/*.json`
 * under the monitor output directory, merges `binaryRunAnalytics` and optional `trades.jsonl`
 * for stability metrics.
 *
 * Usage:
 *   npm run analyze-sessions
 *   npm run analyze-sessions -- output/monitor
 *   npm run analyze-sessions -- output/monitor --json-out output/monitor/multi-session-aggregate.json
 *
 * Archive prior runs for multi-session analysis:
 *   output/monitor/sessions/2026-04-21-run-a.json   (copy of session-summary.json)
 *   output/monitor/sessions/run-b/trades.jsonl        (optional; per-session trade history)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  computeBinaryMultiSessionAggregate,
  formatBinaryMultiSessionAggregateConsole,
} from "./analyze/binaryMultiSessionAggregate.js";
import { resolveMonitorOutputDir } from "./monitorPersistence.js";

function parseArgs(argv: string[]): { dir: string; jsonOut: string | null } {
  const rest = argv.slice(2).filter((a) => a !== "--");
  let jsonOut: string | null = null;
  const filtered: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--json-out" || a === "--jsonOut") {
      jsonOut = rest[i + 1] ?? null;
      i += 1;
      continue;
    }
    filtered.push(a);
  }
  const dir = filtered[0] ?? resolveMonitorOutputDir();
  return { dir: resolve(dir), jsonOut };
}

const { dir, jsonOut } = parseArgs(process.argv);
const report = computeBinaryMultiSessionAggregate(dir);

if (report === null) {
  console.error(
    `[analyze-sessions] No binary session-summary.json under ${dir} (or empty).`
  );
  process.exit(1);
}

const defaultOut = resolve(dir, "multi-session-aggregate.json");
const outPath = jsonOut !== null && jsonOut.length > 0 ? resolve(jsonOut) : defaultOut;

try {
  mkdirSync(dirname(outPath), { recursive: true });
} catch {
  /* ignore */
}
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(formatBinaryMultiSessionAggregateConsole(report));
console.log(`Wrote: ${outPath}`);
