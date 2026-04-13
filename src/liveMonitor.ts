import {

  BOT_TICK_INTERVAL_MS,

  MIN_SAMPLES_FOR_STRATEGY,

  runStrategyTick,

  type BotContext,

} from "./botLoop.js";

import { config, logConfig } from "./config.js";

import {

  buildMonitorSessionSummary,

  MonitorFilePersistence,

} from "./monitorPersistence.js";

import {

  formatMonitorTickLine,

  logPaperTradeClosedBlock,

  logValidOpportunityBlock,

  printLiveMonitorBanner,

  printPeriodicRuntimeSummary,

  printShutdownReport,

} from "./monitorConsole.js";

import { MonitorRuntimeStats } from "./monitorRuntimeStats.js";

import { RollingPriceBuffer } from "./rollingPriceBuffer.js";

import type { SimulatedTrade } from "./simulationEngine.js";

import { SimulationEngine } from "./simulationEngine.js";

import { isPolymarketGammaEnabled } from "./polymarketGamma.js";

import { OpportunityTracker } from "./opportunityTracker.js";
import { evaluateSession, printSessionEvaluationReport } from "./sessionEvaluator.js";



const runtimeStats = new MonitorRuntimeStats();

const persistence = new MonitorFilePersistence();



let monitorStartedAtMs = 0;

let tickTimer: ReturnType<typeof setInterval> | undefined;

let statsTimer: ReturnType<typeof setInterval> | undefined;

let shutdownInProgress = false;



function gracefulShutdown(): void {

  if (shutdownInProgress) return;

  shutdownInProgress = true;

  if (statsTimer !== undefined) clearInterval(statsTimer);

  if (tickTimer !== undefined) clearInterval(tickTimer);

  printShutdownReport(monitorStartedAtMs, {

    ticksObserved: runtimeStats.ticksObserved,

    validOpportunities: runtimeStats.validOpportunities,

    rejectedOpportunities: runtimeStats.rejectedOpportunities,

  }, simulation.getPerformanceStats());

  const perfForEval = simulation.getPerformanceStats();
  printSessionEvaluationReport(
    evaluateSession({
      opportunities: ctx.opportunityTracker.getOpportunities(),
      trades: simulation.getTradeHistory(),
      totalProfit: perfForEval.totalProfit,
      winRate: perfForEval.winRate,
    })
  );

  const endedAt = Date.now();

  try {

    persistence.writeSessionSummary(

      buildMonitorSessionSummary({

        outputDirectory: persistence.getOutputDir(),

        startedAtMs: monitorStartedAtMs,

        endedAtMs: endedAt,

        ticksObserved: runtimeStats.ticksObserved,

        btcFetchFailures: runtimeStats.btcFetchFailures,

        spikeEventsDetected: runtimeStats.spikeEventsDetected,

        candidateOpportunities: runtimeStats.candidateOpportunities,

        validOpportunities: runtimeStats.validOpportunities,

        rejectedOpportunities: runtimeStats.rejectedOpportunities,

        perf: simulation.getPerformanceStats(),

      })

    );

  } catch (err) {

    console.error("[monitor] Failed to write session-summary.json:", err);

  }

  process.exit(0);

}



function onPaperTradeClosed(trade: SimulatedTrade): void {

  try {

    persistence.appendTradeLine(trade);

  } catch (err) {

    console.error("[monitor] Failed to append trades.jsonl:", err);

  }



  logPaperTradeClosedBlock(trade);



  const closedCount = simulation.getTradeHistory().length;

  if (closedCount > 0 && closedCount % 10 === 0) {

    printPeriodicRuntimeSummary(

      `Runtime stats (${closedCount} closed trades)`,

      {

        ticksObserved: runtimeStats.ticksObserved,

        btcFetchFailures: runtimeStats.btcFetchFailures,

        spikeEventsDetected: runtimeStats.spikeEventsDetected,

        candidateOpportunities: runtimeStats.candidateOpportunities,

        validOpportunities: runtimeStats.validOpportunities,

        rejectedOpportunities: runtimeStats.rejectedOpportunities,

      },

      simulation

    );

  }

}



async function runMonitorTick(ctx: BotContext): Promise<void> {

  const tick = await runStrategyTick(ctx);

  const sim = ctx.simulation;



  runtimeStats.observeTick(tick);



  console.log(

    formatMonitorTickLine(tick, sim, MIN_SAMPLES_FOR_STRATEGY)

  );



  if (tick.kind !== "ready") {

    return;

  }



  const now = Date.now();

  sim.onTick({

    now,

    entry: tick.entry,

    sides: tick.sides,

    config: {

      exitPrice: ctx.config.exitPrice,

      stopLoss: ctx.config.stopLoss,

      exitTimeoutMs: ctx.config.exitTimeoutMs,

      entryCooldownMs: ctx.config.entryCooldownMs,

      riskPercentPerTrade: ctx.config.riskPercentPerTrade,

    },

  });



  const recorded = ctx.opportunityTracker.recordFromReadyTick({

    timestamp: now,

    btcPrice: tick.btc,

    prices: tick.prices,

    previousPrice: tick.prev,

    currentPrice: tick.last,

    sides: tick.sides,

    entry: tick.entry,

    config: ctx.config,

  });

  if (recorded?.entryAllowed) {

    logValidOpportunityBlock(recorded);

  }



  runtimeStats.observeOpportunityRecord(recorded);



  if (recorded !== null) {

    try {

      persistence.appendOpportunityLine(recorded);

    } catch (err) {

      console.error("[monitor] Failed to append opportunities.jsonl:", err);

    }

  }

}



function startLiveMonitor(ctx: BotContext): void {

  monitorStartedAtMs = Date.now();

  persistence.ensureReady();

  logConfig();

  printLiveMonitorBanner({

    quotesDetail: isPolymarketGammaEnabled()

      ? "Polymarket Gamma YES/NO"

      : "UP_SIDE_PRICE / DOWN_SIDE_PRICE (env)",

    tickIntervalSec: BOT_TICK_INTERVAL_MS / 1000,

    bufferSlots: config.priceBufferSize,

    minSamples: MIN_SAMPLES_FOR_STRATEGY,

    persistPath: `${persistence.getOutputDir()} (JSONL + session-summary on exit)`,

  });



  statsTimer = setInterval(() => {

    printPeriodicRuntimeSummary(

      "Runtime stats (5 min)",

      {

        ticksObserved: runtimeStats.ticksObserved,

        btcFetchFailures: runtimeStats.btcFetchFailures,

        spikeEventsDetected: runtimeStats.spikeEventsDetected,

        candidateOpportunities: runtimeStats.candidateOpportunities,

        validOpportunities: runtimeStats.validOpportunities,

        rejectedOpportunities: runtimeStats.rejectedOpportunities,

      },

      ctx.simulation

    );

  }, 5 * 60 * 1000);

  void runMonitorTick(ctx);

  tickTimer = setInterval(() => {

    void runMonitorTick(ctx);

  }, BOT_TICK_INTERVAL_MS);

  process.once("SIGINT", gracefulShutdown);

  process.once("SIGTERM", gracefulShutdown);

}



const simulation = new SimulationEngine({

  silent: true,

  initialEquity: config.initialCapital,

  onTradeClosed: onPaperTradeClosed,

});



const ctx: BotContext = {

  priceBuffer: new RollingPriceBuffer(config.priceBufferSize),

  simulation,

  opportunityTracker: new OpportunityTracker(),

  config,

};



startLiveMonitor(ctx);


