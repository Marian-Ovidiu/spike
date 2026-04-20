// Replay monitor opportunities JSONL with current strategy gates (analysis-only, no trading).
// Use after the priorRangeFraction persistence fix to compare stored rejections vs re-evaluated logic.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "./config.js";
import type { EntryEvaluation } from "./entryConditions.js";
import {
  applyUnstableSoftOverlayOnQualityGate,
  evaluateHardRejectContext,
} from "./hardRejectEngine.js";
import type { MovementAnalysis } from "./movementAnalysis.js";
import { evaluatePreEntryQualityGate } from "./preEntryQualityGate.js";
import { evaluateBinaryPaperEntryQuotes } from "./binary/entry/binaryQuoteEntryFilter.js";
import {
  evaluateExecutionBookPipeline,
  syntheticExecutableBookFromMid,
  type ExecutableBookQuote,
} from "./executionSpreadFilter.js";
import type { StableRangeQuality } from "./stableRangeQuality.js";

type JsonlRow = {
  marketMode?: string;
  yesPrice?: number;
  noPrice?: number;
  entryOutcomeSide?: "YES" | "NO" | null;
  btcPrice?: number;
  underlyingSignalPrice?: number;
  movementClassification?: string;
  spikePercent?: number;
  spikeDirection?: "UP" | "DOWN" | null;
  spikeSource?: string | null;
  /** Current JSONL: relative range as a fraction. */
  priorRangeFraction?: number;
  /** Legacy key; may have been mis-scaled pre-fix — use --prior-unit. */
  priorRangePercent?: number;
  bestBid?: number;
  bestAsk?: number;
  midPrice?: number;
  spreadBps?: number;
  /** Legacy binary JSONL */
  upSidePrice?: number;
  downSidePrice?: number;
  stableRangeDetected?: boolean;
  stableRangeQuality?: StableRangeQuality;
  spikeDetected?: boolean;
  movementThresholdRatio?: number;
  thresholdRatio?: number;
  entryRejectionReasons?: readonly string[];
  qualityGateDiagnostics?: {
    qualityGateReasons?: readonly string[];
    weakPrimaryReasons?: readonly string[];
    downgradeChain?: readonly { reasonCode?: string }[];
    inputs?: { entryReasonCodes?: readonly string[] };
  };
};

function priorFractionFromStored(
  raw: number | undefined,
  mode: "auto" | "legacy" | "current"
): number {
  const v = Number.isFinite(raw) ? (raw as number) : 0;
  if (mode === "legacy") return v / 100;
  if (mode === "current") return v;
  // auto: legacy monitor stored priorFraction×100 (e.g. 0.16 for ~0.16% chop); corrected files store fraction (~0.0016).
  if (v > 0.05) return v / 100;
  return v;
}

function resolvePriorFractionFromRow(
  row: JsonlRow,
  mode: "auto" | "legacy" | "current"
): number {
  const f = row.priorRangeFraction;
  if (typeof f === "number" && Number.isFinite(f)) {
    return f;
  }
  return priorFractionFromStored(row.priorRangePercent, mode);
}

function storedPriorRangeTooWide(row: JsonlRow): boolean {
  const d = row.qualityGateDiagnostics;
  if (!d) return false;
  if (d.qualityGateReasons?.includes("prior_range_too_wide_for_mean_reversion")) {
    return true;
  }
  if (d.weakPrimaryReasons?.includes("prior_range_too_wide_for_mean_reversion")) {
    return true;
  }
  return (
    d.downgradeChain?.some(
      (c) => c.reasonCode === "prior_range_too_wide_for_mean_reversion"
    ) ?? false
  );
}

function storedHardRejectUnstable(row: JsonlRow): boolean {
  return row.entryRejectionReasons?.includes("hard_reject_unstable_pre_spike_context") ?? false;
}

/** Reconstruct venue top-of-book from JSONL (binary YES/NO columns or legacy spot bid/ask). */
function executionBookQuoteFromJsonlRow(row: JsonlRow): ExecutableBookQuote | null {
  if (
    row.bestBid !== undefined &&
    row.bestAsk !== undefined &&
    row.midPrice !== undefined &&
    row.spreadBps !== undefined &&
    Number.isFinite(row.bestBid) &&
    Number.isFinite(row.bestAsk)
  ) {
    return {
      bestBid: row.bestBid,
      bestAsk: row.bestAsk,
      midPrice: row.midPrice,
      spreadBps: row.spreadBps,
    };
  }
  const mid = row.underlyingSignalPrice ?? row.btcPrice;
  if (typeof mid === "number" && Number.isFinite(mid)) {
    return syntheticExecutableBookFromMid(mid, 5);
  }
  return null;
}

function contrarianDirection(
  spike: "UP" | "DOWN" | null | undefined
): "UP" | "DOWN" | null {
  if (spike === "UP") return "DOWN";
  if (spike === "DOWN") return "UP";
  return null;
}

function isBinaryRow(row: JsonlRow): boolean {
  if (row.marketMode === "binary") return true;
  return (
    typeof row.yesPrice === "number" &&
    typeof row.noPrice === "number" &&
    Number.isFinite(row.yesPrice) &&
    Number.isFinite(row.noPrice) &&
    row.yesPrice > 0 &&
    row.noPrice > 0
  );
}

function binaryOutcomesFromRow(
  row: JsonlRow
): { yesPrice: number; noPrice: number } | null {
  if (
    typeof row.yesPrice === "number" &&
    typeof row.noPrice === "number" &&
    Number.isFinite(row.yesPrice) &&
    Number.isFinite(row.noPrice) &&
    row.yesPrice > 0 &&
    row.noPrice > 0
  ) {
    return { yesPrice: row.yesPrice, noPrice: row.noPrice };
  }
  return null;
}

/** Direction that would buy the named outcome leg (UP→YES, DOWN→NO). */
function directionForBinaryQuoteGate(row: JsonlRow): "UP" | "DOWN" | null {
  if (row.entryOutcomeSide === "YES") return "UP";
  if (row.entryOutcomeSide === "NO") return "DOWN";
  return contrarianDirection(row.spikeDirection ?? null);
}

function buildEntryFromRow(row: JsonlRow, priorFraction: number): EntryEvaluation {
  const spikePct = Number.isFinite(row.spikePercent) ? row.spikePercent! : 0;
  const strongestMovePercent = spikePct / 100;
  const movement: MovementAnalysis = {
    strongestMovePercent,
    strongestMoveAbsolute: 0,
    strongestMoveDirection: row.spikeDirection ?? null,
    thresholdPercent: 0,
    thresholdRatio:
      row.movementThresholdRatio ?? row.thresholdRatio ?? 0,
    classification:
      row.movementClassification === "borderline"
        ? "borderline"
        : row.movementClassification === "strong_spike"
          ? "strong_spike"
          : "no_signal",
    sourceWindowLabel: row.spikeSource ?? null,
  };

  const entryReasonCodes = row.qualityGateDiagnostics?.inputs?.entryReasonCodes ?? [];

  return {
    shouldEnter: false,
    direction: contrarianDirection(row.spikeDirection ?? null),
    reasons: [...entryReasonCodes],
    stableRangeDetected: row.stableRangeDetected ?? false,
    priorRangeFraction: priorFraction,
    stableRangeQuality: row.stableRangeQuality ?? "poor",
    rangeDecisionNote: "replay",
    movementClassification: movement.classification,
    spikeDetected: row.spikeDetected ?? false,
    movement,
    windowSpike: undefined,
  };
}

function parseArgs(argv: string[]): {
  file: string;
  priorMode: "auto" | "legacy" | "current";
  marketMode: "auto" | "spot" | "binary";
} {
  let file = resolve("output/monitor/opportunities.jsonl");
  let priorMode: "auto" | "legacy" | "current" = "auto";
  let marketMode: "auto" | "spot" | "binary" = "auto";
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file" || a === "-f") {
      file = resolve(argv[++i] ?? "");
      continue;
    }
    if (a === "--prior-unit") {
      const v = (argv[++i] ?? "").toLowerCase();
      if (v === "auto" || v === "legacy" || v === "current") priorMode = v;
      else
        throw new Error(
          `--prior-unit expects auto|legacy|current, got ${JSON.stringify(v)}`
        );
      continue;
    }
    if (a === "--market-mode") {
      const v = (argv[++i] ?? "").toLowerCase();
      if (v === "auto" || v === "spot" || v === "binary") marketMode = v;
      else
        throw new Error(
          `--market-mode expects auto|spot|binary, got ${JSON.stringify(v)}`
        );
      continue;
    }
    if (a === "--help" || a === "-h") {
      console.log(`Usage: node dist/replayOpportunities.js [options]

Re-read monitor opportunities JSONL and re-run hard-reject + pre-entry quality gate
+ quote check (exceptional same-tick path). Does not connect to markets or trading.

Options:
  --file, -f <path>   JSONL file (default: output/monitor/opportunities.jsonl)
  --prior-unit <m>    Legacy priorRangePercent column only: how it maps to a fraction:
                        legacy  — divide by 100 (buggy ×100 persistence)
                        current — value is already a fraction
                        auto    — if value > 0.05 treat as legacy, else fraction (default)
                        When JSONL has priorRangeFraction, it is used as-is.
  --market-mode <m>   auto (default) — infer spot vs binary from JSONL row;
                        spot — always use synthetic bid/ask spread gate;
                        binary — use YES/NO binary quote gate when row has prices.
  --help, -h          Show this help
`);
      process.exit(0);
    }
  }
  return { file, priorMode, marketMode };
}

function main(): void {
  const { file, priorMode, marketMode: marketModeArg } = parseArgs(process.argv);
  const raw = readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const jsonlLines = lines.length;

  const gateOpts = {
    tradableSpikeMinPercent: config.tradableSpikeMinPercent,
    exceptionalSpikeMinPercent: config.exceptionalSpikePercent,
    maxPriorRangeForNormalEntry: config.maxPriorRangeForNormalEntry,
    allowWeakQualityEntries: config.allowWeakQualityEntries,
    allowWeakQualityOnlyForStrongSpikes: config.allowWeakQualityOnlyForStrongSpikes,
    allowAcceptableQualityStrongSpikes: config.allowAcceptableQualityStrongSpikes,
  };

  let strongSpikeRows = 0;
  let storedPriorWide = 0;
  let storedHardUnstable = 0;
  let replayQualityPass = 0;
  let replayQuoteBlocked = 0;
  let replaySameTickValid = 0;

  const cohort = {
    n: 0,
    /** Replay still applies unstable hard reject or prior_range too wide. */
    stillPriorRelated: 0,
    /** Prior-related failure gone (unit fix or true range now under threshold). */
    priorUnlocked: 0,
    /** Unlocked but quality gate still fails (non-prior rules). */
    unlockedQualityFail: 0,
    /** Unlocked + gate pass + exceptional but quote filter blocks. */
    unlockedQuoteBlocked: 0,
    /** Unlocked + gate pass + exceptional + quotes OK (same-tick immediate path). */
    unlockedSameTickValid: 0,
    /** Unlocked + gate pass but not exceptional (pipeline waits confirmation tick). */
    unlockedWaitsStrongSpikeConfirmation: 0,
  };

  for (const line of lines) {
    let row: JsonlRow;
    try {
      row = JSON.parse(line) as JsonlRow;
    } catch {
      continue;
    }
    if (row.movementClassification !== "strong_spike" || row.spikeDetected !== true) {
      continue;
    }
    strongSpikeRows++;

    const hadStoredPriorWide = storedPriorRangeTooWide(row);
    const hadStoredHardUnstable = storedHardRejectUnstable(row);
    if (hadStoredPriorWide) storedPriorWide++;
    if (hadStoredHardUnstable) storedHardUnstable++;

    const priorFraction = resolvePriorFractionFromRow(row, priorMode);
    const entry = buildEntryFromRow(row, priorFraction);

    const gateBase = evaluatePreEntryQualityGate(entry, gateOpts);
    const hardReject = evaluateHardRejectContext({
      entry,
      hardRejectPriorRangePercent: config.hardRejectPriorRangePercent,
      unstableContextMode: config.unstableContextMode,
    });

    const qualityGate = applyUnstableSoftOverlayOnQualityGate(gateBase, hardReject);

    const replayPriorWide =
      qualityGate.qualityGateReasons.includes(
        "prior_range_too_wide_for_mean_reversion"
      ) ||
      qualityGate.diagnostics.weakPrimaryReasons.includes(
        "prior_range_too_wide_for_mean_reversion"
      );

    if (qualityGate.qualityGatePassed) replayQualityPass++;

    const exceptional = qualityGate.qualityProfile === "exceptional";
    const rowIsBinary =
      marketModeArg === "binary" ||
      (marketModeArg === "auto" && isBinaryRow(row));
    const rowIsSpot = marketModeArg === "spot" || (marketModeArg === "auto" && !rowIsBinary);

    if (exceptional && qualityGate.qualityGatePassed && entry.direction !== null) {
      let quoteBlocked = false;
      if (rowIsBinary) {
        const bo = binaryOutcomesFromRow(row);
        const dirGate = directionForBinaryQuoteGate(row);
        const br =
          bo === null || dirGate === null
            ? "missing_binary_quotes"
            : evaluateBinaryPaperEntryQuotes({
                binaryOutcomes: bo,
                direction: dirGate,
                maxOppositeSideEntryPrice: config.binaryMaxOppositeSideEntryPrice,
                maxEntrySidePrice: config.binaryMaxEntrySidePrice,
                neutralBandMin: config.binaryNeutralQuoteBandMin,
                neutralBandMax: config.binaryNeutralQuoteBandMax,
              });
        quoteBlocked = br !== null;
      } else if (rowIsSpot) {
        const book = executionBookQuoteFromJsonlRow(row);
        const quoteBlocker =
          book === null
            ? "invalid_book"
            : evaluateExecutionBookPipeline(book, config.maxEntrySpreadBps);
        quoteBlocked = quoteBlocker !== null;
      }
      if (quoteBlocked) {
        replayQuoteBlocked++;
      } else if (
        !config.strongSpikeHardRejectPoorRange ||
        entry.stableRangeQuality !== "poor"
      ) {
        replaySameTickValid++;
      }
    }

    const inCohort = hadStoredPriorWide || hadStoredHardUnstable;
    if (inCohort) {
      cohort.n++;
      const priorStillBad = hardReject.hardRejectApplied || replayPriorWide;
      if (priorStillBad) {
        cohort.stillPriorRelated++;
      } else {
        cohort.priorUnlocked++;
        if (!qualityGate.qualityGatePassed) {
          cohort.unlockedQualityFail++;
        } else if (!exceptional) {
          cohort.unlockedWaitsStrongSpikeConfirmation++;
        } else if (entry.direction === null) {
          cohort.unlockedQuoteBlocked++;
        } else {
          const cohortRowBinary =
            marketModeArg === "binary" ||
            (marketModeArg === "auto" && isBinaryRow(row));
          const cohortRowSpot =
            marketModeArg === "spot" ||
            (marketModeArg === "auto" && !cohortRowBinary);
          let qb: string | null = null;
          if (cohortRowBinary) {
            const bo = binaryOutcomesFromRow(row);
            const dirGate = directionForBinaryQuoteGate(row);
            qb =
              bo === null || dirGate === null
                ? "missing_binary_quotes"
                : evaluateBinaryPaperEntryQuotes({
                    binaryOutcomes: bo,
                    direction: dirGate,
                    maxOppositeSideEntryPrice: config.binaryMaxOppositeSideEntryPrice,
                    maxEntrySidePrice: config.binaryMaxEntrySidePrice,
                    neutralBandMin: config.binaryNeutralQuoteBandMin,
                    neutralBandMax: config.binaryNeutralQuoteBandMax,
                  });
          } else if (cohortRowSpot) {
            const book = executionBookQuoteFromJsonlRow(row);
            qb =
              book === null
                ? "invalid_book"
                : evaluateExecutionBookPipeline(book, config.maxEntrySpreadBps);
          }
          if (qb !== null) {
            cohort.unlockedQuoteBlocked++;
          } else if (
            config.strongSpikeHardRejectPoorRange &&
            entry.stableRangeQuality === "poor"
          ) {
            cohort.unlockedQuoteBlocked++;
          } else {
            cohort.unlockedSameTickValid++;
          }
        }
      }
    }
  }

  const afterPriorThenOtherRules =
    cohort.unlockedQualityFail +
    cohort.unlockedWaitsStrongSpikeConfirmation +
    cohort.unlockedQuoteBlocked;

  const linesOut = [
    `══════════════════════════════════════════════════════════════`,
    `Replay diagnostic (analysis-only — no live trading)`,
    `══════════════════════════════════════════════════════════════`,
    `File: ${file}`,
    `JSONL data lines: ${jsonlLines} | strong_spike ∧ spikeDetected: ${strongSpikeRows}`,
    `Prior column mapping: ${priorMode} (use --prior-unit legacy for pre-fix JSONL that only had mis-scaled priorRangePercent)`,
    `Market mode: ${marketModeArg} (quote gate: ${marketModeArg === "binary" ? "binary YES/NO" : marketModeArg === "spot" ? "legacy spot L1 spread" : "per-row infer"})`,
    ``,
    `Active config (.env): maxPriorRangeForNormalEntry=${config.maxPriorRangeForNormalEntry} hardRejectPriorRangePercent=${config.hardRejectPriorRangePercent} unstableContextMode=${config.unstableContextMode}`,
    ``,
    `── BEFORE: counts from saved record (what the session logged) ──`,
    `  rejected with prior_range_too_wide… in qualityGateDiagnostics: ${storedPriorWide}`,
    `  rejected with hard_reject_unstable_pre_spike_context in entryRejectionReasons: ${storedHardUnstable}`,
    `  (a row can contribute to both if both applied)`,
    ``,
    `── AFTER: same rows re-evaluated with current gates + resolved prior fraction ──`,
    `  quality gate pass: ${replayQualityPass}`,
    `  quote gate blocks (exceptional + gate pass): ${replayQuoteBlocked}`,
    `  same-tick “valid” (exceptional + gate pass + quotes OK, no poor-range hard reject): ${replaySameTickValid}`,
    ``,
    `── Impact: rows that had prior-wide and/or unstable hard-reject in the file ──`,
    `  cohort size: ${cohort.n}`,
    `  still fail prior / unstable hard-reject on replay: ${cohort.stillPriorRelated}`,
    `  prior path clears on replay (no longer prior-wide ∧ no unstable hard reject): ${cohort.priorUnlocked}`,
    `    └─ then blocked only by other strategy rules (quality / confirmation / quotes / poor-range): ${afterPriorThenOtherRules}`,
    `       · quality gate still fails: ${cohort.unlockedQualityFail}`,
    `       · gate OK, waits strong-spike confirmation (non-exceptional): ${cohort.unlockedWaitsStrongSpikeConfirmation}`,
    `       · gate OK + exceptional but quote or poor-range hard reject: ${cohort.unlockedQuoteBlocked}`,
    `       · same-tick immediate valid (exceptional + quotes): ${cohort.unlockedSameTickValid}`,
    ``,
    `Interpretation: “prior path clears” counts opportunities where the unit-consistent replay removes the`,
    `prior/unstable blocker; remaining failures in that bucket are from other rules, not the prior-range bug.`,
    `══════════════════════════════════════════════════════════════`,
  ];
  console.log(linesOut.join("\n"));
}

main();
