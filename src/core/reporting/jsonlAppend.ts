import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { FuturesJsonlEvent } from "./futuresEventTypes.js";

const DEFAULT_OUTPUT_DIR = "output/futures-monitor";

/**
 * Directory for futures JSONL + session summary (`FUTURES_REPORT_OUTPUT_DIR` overrides).
 */
export function resolveFuturesReportOutputDir(): string {
  const raw = process.env.FUTURES_REPORT_OUTPUT_DIR?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_OUTPUT_DIR;
}

export function ensureDirectoryForFile(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

/**
 * Append one JSON object as a single line (newline-terminated). Idempotent directory creation.
 */
export function appendJsonlRecord(
  filePath: string,
  record: FuturesJsonlEvent
): void {
  ensureDirectoryForFile(filePath);
  const line = `${JSON.stringify(record)}\n`;
  appendFileSync(filePath, line, "utf8");
}
