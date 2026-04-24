import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  FuturesBalanceHistoryRecord,
  FuturesBalanceProgress,
  FuturesJsonlEvent,
  FuturesSessionProgress,
  FuturesSessionSummary,
} from "./futuresEventTypes.js";
import {
  appendJsonlRecord,
  ensureDirectoryForFile,
  resolveFuturesReportOutputDir,
} from "./jsonlAppend.js";

const EVENTS_FILE = "futures-events.jsonl";
const SESSION_FILE = "futures-session-summary.json";
const PROGRESS_FILE = "futures-session-progress.json";
const BALANCE_PROGRESS_DIR = "output/live";
const BALANCE_PROGRESS_FILE = "futures-balance-progress.json";
const BALANCE_HISTORY_FILE = "futures-balance-history.jsonl";

/**
 * Append-only event log + final session snapshot (futures-neutral schema).
 */
export class FuturesReportingPersistence {
  private readonly dir: string;
  private readonly eventsPath: string;
  private readonly sessionSummaryPath: string;
  private readonly sessionProgressPath: string;
  private readonly balanceProgressPath: string;
  private readonly balanceHistoryPath: string;

  constructor(outputDir?: string) {
    this.dir = outputDir ?? resolveFuturesReportOutputDir();
    this.eventsPath = join(this.dir, EVENTS_FILE);
    this.sessionSummaryPath = join(this.dir, SESSION_FILE);
    this.sessionProgressPath = join(this.dir, PROGRESS_FILE);
    this.balanceProgressPath = join(BALANCE_PROGRESS_DIR, BALANCE_PROGRESS_FILE);
    this.balanceHistoryPath = join(BALANCE_PROGRESS_DIR, BALANCE_HISTORY_FILE);
  }

  getOutputDir(): string {
    return this.dir;
  }

  getBalanceProgressOutputDir(): string {
    return BALANCE_PROGRESS_DIR;
  }

  getEventsPath(): string {
    return this.eventsPath;
  }

  getSessionSummaryPath(): string {
    return this.sessionSummaryPath;
  }

  getSessionProgressPath(): string {
    return this.sessionProgressPath;
  }

  getBalanceProgressPath(): string {
    return this.balanceProgressPath;
  }

  getBalanceHistoryPath(): string {
    return this.balanceHistoryPath;
  }

  /** Append a single {@link FuturesJsonlEvent} line. */
  appendEvent(event: FuturesJsonlEvent): void {
    appendJsonlRecord(this.eventsPath, event);
  }

  /** Write formatted session summary (overwrites prior file for that path). */
  writeSessionSummary(summary: FuturesSessionSummary): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(
      this.sessionSummaryPath,
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8"
    );
  }

  /** Write the latest progress snapshot, overwriting the previous file contents. */
  writeSessionProgress(progress: FuturesSessionProgress): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(
      this.sessionProgressPath,
      `${JSON.stringify(progress, null, 2)}\n`,
      "utf8"
    );
  }

  /** Write the latest balance progress snapshot, overwriting the previous file contents. */
  writeBalanceProgress(progress: FuturesBalanceProgress): void {
    mkdirSync(BALANCE_PROGRESS_DIR, { recursive: true });
    writeFileSync(
      this.balanceProgressPath,
      `${JSON.stringify(progress, null, 2)}\n`,
      "utf8"
    );
  }

  /** Append a single balance history line. */
  appendBalanceHistory(record: FuturesBalanceHistoryRecord): void {
    ensureDirectoryForFile(this.balanceHistoryPath);
    appendFileSync(this.balanceHistoryPath, `${JSON.stringify(record)}\n`, "utf8");
  }
}
