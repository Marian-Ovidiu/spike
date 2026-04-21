import type { Opportunity } from "./opportunityTracker.js";
import {
  normalizeOpportunityRejectionReasons,
  pickPrimaryRejectionBlocker,
  REJECTION_REASON_MESSAGES,
  type NormalizedRejectionReason,
} from "./rejectionReasons.js";

const QUOTE_BLOCKERS: ReadonlySet<NormalizedRejectionReason> = new Set([
  "missing_quote_data",
  "invalid_market_prices",
  "market_quotes_too_neutral",
  "missing_binary_quotes",
  "quote_feed_stale",
]);

function normalizedReasons(o: Opportunity): NormalizedRejectionReason[] {
  if (o.status === "valid") return [];
  return normalizeOpportunityRejectionReasons({
    rawReasons: o.entryRejectionReasons,
    movementClassification: o.movementClassification,
  });
}

function passQuoteGate(norm: NormalizedRejectionReason[]): boolean {
  return !norm.some((r) => QUOTE_BLOCKERS.has(r));
}

function passUnstableGate(norm: NormalizedRejectionReason[]): boolean {
  return !norm.includes("hard_reject_unstable_pre_spike_context");
}

function passQualityGate(o: Opportunity): boolean {
  if (o.status === "valid") return true;
  return o.qualityGateDiagnostics?.qualityGatePassed === true;
}

function passPriorRangeGate(norm: NormalizedRejectionReason[]): boolean {
  return !norm.includes("prior_range_too_wide_for_mean_reversion");
}

function passOppositePriceGate(norm: NormalizedRejectionReason[]): boolean {
  return !norm.includes("opposite_side_price_too_high");
}

function primaryBlocker(norm: NormalizedRejectionReason[]): string | null {
  return pickPrimaryRejectionBlocker(norm);
}

function comboKey(norm: NormalizedRejectionReason[]): string {
  if (norm.length <= 1) return norm[0] ?? "";
  return [...norm].sort().join(" + ");
}

export type StrongSpikeGateFunnel = {
  /** Strong-spike opportunity rows (JSONL) — base of the funnel. */
  spikesDetected: number;
  passedQuoteGate: number;
  passedUnstableContextGate: number;
  passedQualityGate: number;
  passedPriorRangeGate: number;
  passedOppositeSidePriceGate: number;
  /** Rows with `status === "valid"` among strong-spike JSONL records only. */
  validOpportunities: number;
  /**
   * Runtime funnel L3 ticks (`enter_immediate` or `promote_borderline_candidate`).
   * Used with {@link validOpportunities} so opened-trade % is not misleading when
   * entries are borderline-promoted (no strong-spike JSON row on that tick).
   */
  strategyApprovedEntryTicks?: number;
  /** Same as runtime `tradesExecuted` (paper opens). */
  openedTrades: number;
  borderlineCandidatesCreated: number;
  rejectedWithMultipleNormalizedReasons: number;
  dominantPrimaryBlocker: { reason: string; label: string; count: number } | null;
  topReasonCombinations: Array<{ combo: string; count: number }>;
};

/**
 * Build nested funnel stats for `opportunityType === "strong_spike"` rows only.
 * Does not affect trading logic — reporting only.
 */
export function computeStrongSpikeGateFunnel(input: {
  opportunities: readonly Opportunity[];
  borderlineCandidatesCreated: number;
  tradesExecuted: number;
  /** When provided (e.g. from runtime stats), included in opened-trade % denominator. */
  strategyApprovedEntryTicks?: number;
}): StrongSpikeGateFunnel {
  const strong = input.opportunities.filter((o) => o.opportunityType === "strong_spike");
  const spikesDetected = strong.length;

  let passedQuoteGate = 0;
  let passedUnstableContextGate = 0;
  let passedQualityGate = 0;
  let passedPriorRangeGate = 0;
  let passedOppositeSidePriceGate = 0;
  let validOpportunities = 0;
  let rejectedWithMultipleNormalizedReasons = 0;

  const primaryCounts = new Map<string, number>();
  const comboCounts = new Map<string, number>();

  for (const o of strong) {
    const norm = normalizedReasons(o);
    if (norm.length > 1) rejectedWithMultipleNormalizedReasons += 1;

    const pq = passQuoteGate(norm);
    if (pq) passedQuoteGate += 1;

    const pu = pq && passUnstableGate(norm);
    if (pu) passedUnstableContextGate += 1;

    const qOk = pu && passQualityGate(o);
    if (qOk) passedQualityGate += 1;

    const prOk = qOk && passPriorRangeGate(norm);
    if (prOk) passedPriorRangeGate += 1;

    const priceOk = prOk && passOppositePriceGate(norm);
    if (priceOk) passedOppositeSidePriceGate += 1;

    if (o.status === "valid") validOpportunities += 1;

    if (o.status === "rejected") {
      const pb = primaryBlocker(norm);
      const pk = pb ?? "(unclassified_rejection)";
      primaryCounts.set(pk, (primaryCounts.get(pk) ?? 0) + 1);
      const ck = comboKey(norm);
      if (ck.length > 0) {
        comboCounts.set(ck, (comboCounts.get(ck) ?? 0) + 1);
      }
    }
  }

  let dominantPrimaryBlocker: StrongSpikeGateFunnel["dominantPrimaryBlocker"] = null;
  for (const [reason, count] of primaryCounts) {
    if (
      dominantPrimaryBlocker === null ||
      count > dominantPrimaryBlocker.count
    ) {
      const label =
        reason === "(unclassified_rejection)"
          ? "unclassified (no mapped rejection code)"
          : (REJECTION_REASON_MESSAGES[reason as NormalizedRejectionReason] ??
            reason);
      dominantPrimaryBlocker = {
        reason,
        label,
        count,
      };
    }
  }

  const topReasonCombinations = [...comboCounts.entries()]
    .filter(([combo]) => combo.includes(" + "))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([combo, count]) => ({ combo, count }));

  return {
    spikesDetected,
    passedQuoteGate,
    passedUnstableContextGate,
    passedQualityGate,
    passedPriorRangeGate,
    passedOppositeSidePriceGate,
    validOpportunities,
    ...(input.strategyApprovedEntryTicks !== undefined
      ? { strategyApprovedEntryTicks: input.strategyApprovedEntryTicks }
      : {}),
    openedTrades: input.tradesExecuted,
    borderlineCandidatesCreated: input.borderlineCandidatesCreated,
    rejectedWithMultipleNormalizedReasons,
    dominantPrimaryBlocker,
    topReasonCombinations,
  };
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${((100 * part) / whole).toFixed(1)}%`;
}

function line(label: string, count: number, convFromPrev: string): string {
  return `  ${label.padEnd(28)} ${String(count).padStart(6)}  (${convFromPrev})`;
}

/**
 * Console lines for the shutdown report (does not replace existing sections).
 */
export function formatGateFunnelSection(f: StrongSpikeGateFunnel): string[] {
  const n0 = f.spikesDetected;
  const n1 = f.passedQuoteGate;
  const n2 = f.passedUnstableContextGate;
  const n3 = f.passedQualityGate;
  const n4 = f.passedPriorRangeGate;
  const n5 = f.passedOppositeSidePriceGate;
  const nv = f.validOpportunities;
  const approvedBaseline = Math.max(nv, f.strategyApprovedEntryTicks ?? 0);
  const openedDenom = Math.max(approvedBaseline, f.openedTrades > 0 ? 1 : 0);
  const out: string[] = [
    "",
    "──────── Gate funnel (strong-spike rows in JSONL) ────────────",
    "  Nested stages: each line is a subset of the line above.",
    line("Spikes detected", n0, "100% base"),
    line("  → quote gate passed", n1, `${pct(n1, n0)} of spikes`),
    line("  → unstable context passed", n2, `${pct(n2, n1)} of quote-pass`),
    line("  → quality gate passed", n3, `${pct(n3, n2)} of unstable-pass`),
    line("  → prior-range gate passed", n4, `${pct(n4, n3)} of quality-pass`),
    line("  → opposite-side price passed", n5, `${pct(n5, n4)} of prior-pass`),
    line("Valid opportunities (strategy)", nv, `${pct(nv, n0)} of spikes`),
    line(
      "Opened trades (paper sim)",
      f.openedTrades,
      `${pct(f.openedTrades, openedDenom)} of max(JSONL-valid, runtime-approved)`
    ),
    `  Borderline watch candidates created   ${String(f.borderlineCandidatesCreated).padStart(6)}`,
    "  Multi-reason rejections (2+ codes)    " +
      String(f.rejectedWithMultipleNormalizedReasons).padStart(6),
  ];
  if (f.dominantPrimaryBlocker !== null) {
    out.push(
      `  Dominant primary blocker (rejected): ${f.dominantPrimaryBlocker.label} (${f.dominantPrimaryBlocker.count}x)`
    );
  } else {
    out.push("  Dominant primary blocker (rejected): —");
  }
  if (f.topReasonCombinations.length > 0) {
    out.push("  Top multi-reason combinations:");
    for (const row of f.topReasonCombinations) {
      out.push(`    - ${row.combo}: ${row.count}`);
    }
  } else {
    out.push("  Top multi-reason combinations: —");
  }
  out.push("──────────────────────────────────────────────────────────────");
  return out;
}
