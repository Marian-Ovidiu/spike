import { startBotLoop } from "./botLoop.js";
import { assertBinaryOnlyRuntime } from "./binaryOnlyRuntime.js";
import { assertLegacySpotMarketModeAcknowledged } from "./legacy/spot/assertLegacySpotMarketMode.js";
import { config, logConfig } from "./config.js";
import { ensureAutoDiscoveredBinaryMarketSlug } from "./binary/venue/discoverBtc5mUpDownMarket.js";
import { createSignalAndExecutionFeeds } from "./market/marketFeedFactory.js";
import { OpportunityTracker } from "./opportunityTracker.js";
import { RollingPriceBuffer } from "./rollingPriceBuffer.js";
import { SimulationEngine } from "./simulationEngine.js";

async function main(): Promise<void> {
  logConfig();
  assertLegacySpotMarketModeAcknowledged(config.marketMode);
  assertBinaryOnlyRuntime(config.marketMode);
  await ensureAutoDiscoveredBinaryMarketSlug(config.marketMode);

  const { signalFeed, executionFeed } = createSignalAndExecutionFeeds(
    config.marketMode,
    {
      paper: true,
      binarySignalSource: config.binarySignalSource,
      binarySignalSymbol: config.binarySignalSymbol,
    }
  );

  const ctx = {
    priceBuffer: new RollingPriceBuffer(config.priceBufferSize),
    simulation: new SimulationEngine({ initialEquity: config.initialCapital }),
    opportunityTracker: new OpportunityTracker(),
    config,
    signalFeed,
    executionFeed,
    tradeSymbol: executionFeed.getSymbol(),
  };

  const sameFeed = signalFeed === executionFeed;
  if (sameFeed) {
    void signalFeed.bootstrapRest().then(() => {
      signalFeed.start();
      startBotLoop(ctx);
    });
  } else {
    void Promise.all([signalFeed.bootstrapRest(), executionFeed.bootstrapRest()]).then(() => {
      signalFeed.start();
      executionFeed.start();
      startBotLoop(ctx);
    });
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
