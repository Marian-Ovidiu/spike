import { startBotLoop } from "./botLoop.js";
import { PaperBinanceFeed } from "./adapters/binanceSpotFeed.js";
import { config, logConfig } from "./config.js";
import { OpportunityTracker } from "./opportunityTracker.js";
import { RollingPriceBuffer } from "./rollingPriceBuffer.js";
import { SimulationEngine } from "./simulationEngine.js";

logConfig();

const paperFeed = new PaperBinanceFeed();

const ctx = {
  priceBuffer: new RollingPriceBuffer(config.priceBufferSize),
  simulation: new SimulationEngine({ initialEquity: config.initialCapital }),
  opportunityTracker: new OpportunityTracker(),
  config,
  marketFeed: paperFeed,
  tradeSymbol: paperFeed.getSymbol(),
};

void paperFeed.bootstrapRest().then(() => {
  paperFeed.start();
  startBotLoop(ctx);
});
