#!/usr/bin/env node
import "./config/loadEnv.js";
/**
 * Offline binary probability calibration: reads `probability-calibration-events.jsonl`
 * under a monitor output directory and prints bucket reliability + verdict.
 *
 * Usage: npm run analyze-probability-calibration -- [dir] [--json-out path]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { resolveMonitorOutputDir } from "./monitorPersistence.js";
import {
  type ProbabilityCalibrationEvent,
  PROBABILITY_CALIBRATION_SCHEMA,
  buildCalibrationReliabilityReport,
  formatCalibrationReportConsole,
} from "./binary/signal/binaryProbabilityCalibration.js";

function parseArgs(argv: string[]): {
  dir: string;
  jsonOut: string | null;
} {
  const rest = argv.slice(2).filter((a) => a !== "--");
  let jsonOut: string | null = null;
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--json-out" && rest[i + 1]) {
      jsonOut = rest[i + 1]!;
      i += 1;
      continue;
    }
    pos.push(rest[i]!);
  }
  return { dir: pos[0] ?? resolveMonitorOutputDir(), jsonOut };
}

function readCalibrationEvents(dir: string): ProbabilityCalibrationEvent[] {
  const path = join(dir, "probability-calibration-events.jsonl");
  if (!existsSync(path)) {
    console.warn(`[analyze-probability-calibration] Missing ${path}`);
    return [];
  }
  const raw = readFileSync(path, "utf8");
  const out: ProbabilityCalibrationEvent[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as ProbabilityCalibrationEvent;
      if (o?.schema === PROBABILITY_CALIBRATION_SCHEMA) out.push(o);
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

function main(): void {
  const { dir, jsonOut } = parseArgs(process.argv);
  const events = readCalibrationEvents(dir);
  const report = buildCalibrationReliabilityReport(events);
  console.log(formatCalibrationReportConsole(report));
  if (jsonOut) {
    writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\nWrote JSON report: ${jsonOut}`);
  }
}

main();
