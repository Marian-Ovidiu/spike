export type BalanceStakeMode = "fixed" | "compounding";

export type BalanceEngineConfig = {
  enabled: boolean;
  startingBalance: number;
  reserveBalance: number;
  fixedStakeUntilBalance: number;
  minBalanceToContinue: number;
  fixedStakeQuote: number;
};

export type BalanceEngineSnapshot = {
  readonly currentBalance: number;
  readonly currentEquity: number;
  readonly activeStake: number;
  readonly stakeMode: BalanceStakeMode;
  readonly stopRequested: boolean;
  readonly stopReason: string | null;
};

function normalizeNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clampNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export class BalanceEngine {
  private readonly cfg: BalanceEngineConfig;
  private currentBalanceQuote: number;
  private currentUnrealizedPnlQuote = 0;
  private activeStakeQuote: number;
  private stakeModeValue: BalanceStakeMode = "fixed";
  private stopRequestedFlag = false;
  private stopReasonText: string | null = null;

  constructor(config: BalanceEngineConfig) {
    this.cfg = {
      enabled: config.enabled,
      startingBalance: normalizeNumber(config.startingBalance, 110),
      reserveBalance: clampNonNegative(config.reserveBalance),
      fixedStakeUntilBalance: clampNonNegative(config.fixedStakeUntilBalance),
      minBalanceToContinue: clampNonNegative(config.minBalanceToContinue),
      fixedStakeQuote: clampNonNegative(config.fixedStakeQuote),
    };
    this.currentBalanceQuote = this.cfg.startingBalance;
    this.activeStakeQuote = this.cfg.enabled
      ? this.cfg.fixedStakeQuote
      : this.cfg.fixedStakeQuote;
    this.recomputeStake();
  }

  get currentBalance(): number {
    return this.currentBalanceQuote;
  }

  get currentEquity(): number {
    return this.currentBalanceQuote + this.currentUnrealizedPnlQuote;
  }

  get activeStake(): number {
    return this.activeStakeQuote;
  }

  get stakeMode(): BalanceStakeMode {
    return this.stakeModeValue;
  }

  get stopRequested(): boolean {
    return this.stopRequestedFlag;
  }

  get stopReason(): string | null {
    return this.stopReasonText;
  }

  setUnrealizedPnlQuote(unrealizedPnlQuote: number | null): void {
    this.currentUnrealizedPnlQuote = Number.isFinite(unrealizedPnlQuote ?? NaN)
      ? (unrealizedPnlQuote as number)
      : 0;
  }

  applyRealizedNetPnlQuote(netPnlQuote: number): BalanceEngineSnapshot {
    if (Number.isFinite(netPnlQuote)) {
      this.currentBalanceQuote += netPnlQuote;
    }

    if (this.cfg.enabled && this.currentBalanceQuote < this.cfg.minBalanceToContinue) {
      this.stopRequestedFlag = true;
      this.stopReasonText = `balance_below_minimum_after_close(balance=${this.currentBalanceQuote.toFixed(4)}, min=${this.cfg.minBalanceToContinue.toFixed(4)})`;
    }

    this.recomputeStake();
    return this.getSnapshot();
  }

  getSnapshot(): BalanceEngineSnapshot {
    return {
      currentBalance: this.currentBalanceQuote,
      currentEquity: this.currentEquity,
      activeStake: this.activeStakeQuote,
      stakeMode: this.stakeModeValue,
      stopRequested: this.stopRequestedFlag,
      stopReason: this.stopReasonText,
    };
  }

  private recomputeStake(): void {
    if (!this.cfg.enabled) {
      this.stakeModeValue = "fixed";
      this.activeStakeQuote = this.cfg.fixedStakeQuote;
      return;
    }

    if (this.currentBalanceQuote <= this.cfg.fixedStakeUntilBalance) {
      this.stakeModeValue = "fixed";
      this.activeStakeQuote = this.cfg.fixedStakeQuote;
      return;
    }

    this.stakeModeValue = "compounding";
    this.activeStakeQuote = Math.max(0, this.currentBalanceQuote - this.cfg.reserveBalance);
  }
}
