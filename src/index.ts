import { startBotLoop } from "./botLoop.js";
import { config, logConfig } from "./config.js";
import { OpportunityTracker } from "./opportunityTracker.js";
import { RollingPriceBuffer } from "./rollingPriceBuffer.js";
import { SimulationEngine } from "./simulationEngine.js";

logConfig();

const ctx = {
  priceBuffer: new RollingPriceBuffer(config.priceBufferSize),
  simulation: new SimulationEngine({ initialEquity: config.initialCapital }),
  opportunityTracker: new OpportunityTracker(),
  config,
};

startBotLoop(ctx);
