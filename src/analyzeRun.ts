#!/usr/bin/env node
/**
 * Offline binary run analytics: reads opportunities.jsonl, trades.jsonl, session-summary.json.
 *
 * Usage:
 *   npm run analyze-run -- output/monitor
 *   npm run analyze-run -- output/monitor --json-out output/monitor/analyze-report.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  analyzeRunDirectory,
  formatBinaryRunAnalyticsConsole,
} from "./analyze/binaryRunAnalytics.js";
import { resolveMonitorOutputDir } from "./monitorPersistence.js";

function parseArgs(argv: string[]): {
  dir: string;
  jsonOut: string | null;
} {
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
const report = analyzeRunDirectory(dir);
const text = formatBinaryRunAnalyticsConsole(dir, report);
console.log(text);

if (jsonOut !== null && jsonOut.length > 0) {
  const outPath = resolve(jsonOut);
  try {
    mkdirSync(dirname(outPath), { recursive: true });
  } catch {
    /* ignore */
  }
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Wrote JSON report: ${outPath}`);
}
