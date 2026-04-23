/**
 * Minimal historical / snapshot series loaders for futures core replay (mid + synthetic spread).
 */
import { readFile } from "node:fs/promises";

import type { TopOfBookL1 } from "../domain/book.js";

export type FuturesReplayTick = {
  readonly atMs: number;
  readonly mid: number;
  readonly spreadBps: number;
};

export type SyntheticReplayBookOptions = {
  readonly previousMid?: number | null;
  readonly lastMessageAgeMs?: number;
};

/**
 * Symmetric but slightly adaptive L1 book around mid.
 * Keeps the model simple while making stale / choppy replay ticks less ideal.
 */
export function syntheticBookFromMid(
  mid: number,
  spreadBps: number,
  opts: SyntheticReplayBookOptions = {}
): TopOfBookL1 {
  const baseSpreadBps = Number.isFinite(spreadBps)
    ? Math.max(0, spreadBps)
    : 0;
  const previousMid = opts.previousMid;
  const lastMessageAgeMs = Number.isFinite(opts.lastMessageAgeMs ?? NaN)
    ? Math.max(0, opts.lastMessageAgeMs ?? 0)
    : 0;
  const moveBps =
    previousMid !== undefined &&
    previousMid !== null &&
    previousMid > 0 &&
    Number.isFinite(previousMid)
      ? Math.abs((mid - previousMid) / previousMid) * 10_000
      : 0;
  const ageWidenBps = Math.min(12, (lastMessageAgeMs / 1_000) * 0.15);
  const moveWidenBps = Math.min(20, moveBps * 0.2);
  const effectiveSpreadBps = Math.max(
    0.5,
    baseSpreadBps + ageWidenBps + moveWidenBps
  );
  const half = (mid * effectiveSpreadBps) / 10_000 / 2;
  const imbalance =
    previousMid !== undefined &&
    previousMid !== null &&
    previousMid > 0 &&
    Number.isFinite(previousMid)
      ? Math.max(-0.35, Math.min(0.35, ((mid - previousMid) / previousMid) * 4))
      : 0;
  const bidSize = Math.max(0.1, 1 - imbalance * 0.5);
  const askSize = Math.max(0.1, 1 + imbalance * 0.5);
  const bestBid = mid - half;
  const bestAsk = mid + half;
  return {
    bestBid,
    bestAsk,
    midPrice: mid,
    spreadBps: effectiveSpreadBps,
    bestBidSize: bidSize,
    bestAskSize: askSize,
  };
}

export type LoadFuturesReplayOptions = {
  /** When CSV rows omit time, advance by this between rows. */
  readonly stepMs: number;
  /** First synthetic timestamp when CSV has no time column. */
  readonly epochStartMs: number;
  readonly defaultSpreadBps: number;
};

function parseJsonl(content: string, opts: LoadFuturesReplayOptions): FuturesReplayTick[] {
  const out: FuturesReplayTick[] = [];
  let cursorMs = opts.epochStartMs;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const o = JSON.parse(line) as Record<string, unknown>;
    const mid = Number(o.mid ?? o.price);
    const spreadBpsRaw = Number(o.spreadBps ?? o.spread_bps);
    const explicitT = Number(o.atMs ?? o.time_ms ?? o.t);
    if (!Number.isFinite(mid)) continue;
    const spreadBps = Number.isFinite(spreadBpsRaw)
      ? spreadBpsRaw
      : opts.defaultSpreadBps;
    let atMs: number;
    if (Number.isFinite(explicitT)) {
      atMs = explicitT;
      cursorMs = atMs + opts.stepMs;
    } else {
      atMs = cursorMs;
      cursorMs += opts.stepMs;
    }
    out.push({ atMs, mid, spreadBps });
  }
  return out;
}

/** Single-column CSV (no comma) or comma-separated with header row. */
function parseCsv(
  content: string,
  opts: LoadFuturesReplayOptions
): FuturesReplayTick[] {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) return [];

  const out: FuturesReplayTick[] = [];
  const first = lines[0]!;
  const hasComma = first.includes(",");

  if (!hasComma) {
    let t = opts.epochStartMs;
    for (const line of lines) {
      const mid = Number(line);
      if (!Number.isFinite(mid)) continue;
      out.push({
        atMs: t,
        mid,
        spreadBps: opts.defaultSpreadBps,
      });
      t += opts.stepMs;
    }
    return out;
  }

  const headers = first.split(",").map((h) => h.trim().toLowerCase());
  const midCol = headers.findIndex(
    (h) => h === "mid" || h === "price" || h === "close"
  );
  if (midCol < 0) {
    throw new Error(
      "CSV header must include one of: mid, price, close (first row is the header)"
    );
  }
  const timeCol = headers.findIndex(
    (h) =>
      h === "time_ms" ||
      h === "atms" ||
      h === "t" ||
      h === "timestamp_ms"
  );
  const spreadCol = headers.findIndex(
    (h) => h === "spread_bps" || h === "spreadbps"
  );

  let t = opts.epochStartMs;
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i]!.split(",").map((p) => p.trim());
    const mid = Number(parts[midCol]);
    if (!Number.isFinite(mid)) continue;
    let atMs: number;
    if (timeCol >= 0) {
      atMs = Number(parts[timeCol]);
      if (!Number.isFinite(atMs)) atMs = t;
    } else {
      atMs = t;
      t += opts.stepMs;
    }
    let spreadBps = opts.defaultSpreadBps;
    if (spreadCol >= 0 && parts[spreadCol] !== undefined) {
      const s = Number(parts[spreadCol]);
      if (Number.isFinite(s)) spreadBps = s;
    }
    out.push({ atMs, mid, spreadBps });
  }

  return out;
}

export type FuturesReplayFormat = "jsonl" | "csv";

export async function loadFuturesReplayTicks(
  filePath: string,
  format: FuturesReplayFormat,
  opts: LoadFuturesReplayOptions
): Promise<FuturesReplayTick[]> {
  const content = await readFile(filePath, "utf8");
  if (format === "jsonl") {
    return parseJsonl(content, opts);
  }
  return parseCsv(content, opts);
}

export function inferReplayFormat(
  filePath: string,
  explicit: "auto" | FuturesReplayFormat
): FuturesReplayFormat {
  if (explicit !== "auto") return explicit;
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".jsonl")) return "jsonl";
  return "csv";
}
