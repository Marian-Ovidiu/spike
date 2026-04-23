import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FuturesJsonlEvent, FuturesSessionSummary } from "./futuresEventTypes.js";
import {
  appendJsonlRecord,
  resolveFuturesReportOutputDir,
} from "./jsonlAppend.js";

const EVENTS_FILE = "futures-events.jsonl";
const SESSION_FILE = "futures-session-summary.json";

/**
 * Append-only event log + final session snapshot (futures-neutral schema).
 */
export class FuturesReportingPersistence {
  private readonly dir: string;
  private readonly eventsPath: string;
  private readonly sessionSummaryPath: string;

  constructor(outputDir?: string) {
    this.dir = outputDir ?? resolveFuturesReportOutputDir();
    this.eventsPath = join(this.dir, EVENTS_FILE);
    this.sessionSummaryPath = join(this.dir, SESSION_FILE);
  }

  getOutputDir(): string {
    return this.dir;
  }

  getEventsPath(): string {
    return this.eventsPath;
  }

  getSessionSummaryPath(): string {
    return this.sessionSummaryPath;
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
}
