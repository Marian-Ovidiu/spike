import axios, { type AxiosInstance } from "axios";
import { createHmac } from "node:crypto";
import {
  readBinanceExchangeConfig,
  readExchangeDefaults,
} from "../../config/env.js";

export type BinanceFuturesClientOptions = {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  useTestnet?: boolean;
};

export type BinanceFuturesAccountAsset = {
  asset: string;
  walletBalance: number;
  unrealizedProfit: number;
  marginBalance: number;
  maintMargin: number;
  initialMargin: number;
  positionInitialMargin: number;
  openOrderInitialMargin: number;
  crossWalletBalance: number;
  crossUnPnl: number;
  availableBalance: number;
  maxWithdrawAmount: number;
  marginAvailable?: boolean;
  updateTime?: number;
};

export type BinanceFuturesAccountPosition = {
  symbol: string;
  initialMargin: number;
  maintMargin: number;
  unrealizedProfit: number;
  positionInitialMargin: number;
  openOrderInitialMargin: number;
  leverage: number;
  isolated: boolean;
  positionSide: string;
  entryPrice: number;
  maxNotional: number;
  bidNotional: number;
  askNotional: number;
  positionAmt: number;
  notional: number;
  isolatedWallet: number;
  updateTime: number;
  markPrice: number;
  liquidationPrice: number;
  breakEvenPrice: number;
  marginAsset: string;
  maxQty: number;
  adlQuantile?: number;
};

export type BinanceFuturesAccountInfo = {
  feeBurn: boolean;
  canTrade: boolean;
  canDeposit: boolean;
  canWithdraw: boolean;
  multiAssetsMargin: boolean;
  tradeGroupId: number;
  totalWalletBalance: number;
  totalUnrealizedProfit: number;
  totalMarginBalance: number;
  totalPositionInitialMargin: number;
  totalOpenOrderInitialMargin: number;
  totalCrossWalletBalance: number;
  totalCrossUnPnl: number;
  availableBalance: number;
  maxWithdrawAmount: number;
  assets: BinanceFuturesAccountAsset[];
  positions: BinanceFuturesAccountPosition[];
};

export type BinanceFuturesExchangeInfoSymbolFilter = {
  filterType: string;
  minPrice?: string;
  maxPrice?: string;
  tickSize?: string;
  multiplierUp?: string;
  multiplierDown?: string;
  multiplierDecimal?: string;
  minQty?: string;
  maxQty?: string;
  stepSize?: string;
  minNotional?: string;
  notional?: string;
};

export type BinanceFuturesExchangeInfoSymbol = {
  symbol: string;
  pair: string;
  contractType: string;
  deliveryDate: number;
  onboardDate?: number;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  marginAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  baseAssetPrecision: number;
  quotePrecision: number;
  underlyingType?: string;
  underlyingSubType?: string[];
  triggerProtect?: string;
  liquidationFee?: string;
  marketTakeBound?: string;
  orderTypes?: string[];
  timeInForce?: string[];
  filters: BinanceFuturesExchangeInfoSymbolFilter[];
};

export type BinanceFuturesExchangeInfo = {
  timezone: string;
  serverTime: number;
  symbols: BinanceFuturesExchangeInfoSymbol[];
};

export type BinanceFuturesServerTime = {
  serverTime: number;
};

export type BinanceFuturesSymbolFilters = {
  symbol: string;
  tickSize: number | null;
  stepSize: number | null;
  minQty: number | null;
  maxQty: number | null;
  minNotional: number | null;
};

export type BinanceFuturesBalanceView = {
  asset: string;
  walletBalance: number;
  availableBalance: number;
  unrealizedProfit: number;
  marginBalance: number;
  crossWalletBalance: number;
  crossUnPnl: number;
};

export type BinanceFuturesOpenPositionView = {
  symbol: string;
  positionSide: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unrealizedProfit: number;
  leverage: number;
  isolated: boolean;
  liquidationPrice: number;
  marginAsset: string;
  updateTime: number;
};

function maskKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}***`;
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`;
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.replace(/\/+$/, "") : value;
}

function toSignedQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined);
  entries.sort(([a], [b]) => a.localeCompare(b));
  return new URLSearchParams(
    entries.map(([key, value]) => [key, String(value)])
  ).toString();
}

function parseJsonNumber(value: unknown): number {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : Number.NaN;
}

function pickSymbolFilters(symbol: BinanceFuturesExchangeInfoSymbol): BinanceFuturesSymbolFilters {
  const priceFilter = symbol.filters.find((f) => f.filterType === "PRICE_FILTER");
  const lotSizeFilter = symbol.filters.find((f) => f.filterType === "LOT_SIZE");
  const marketLotSizeFilter = symbol.filters.find((f) => f.filterType === "MARKET_LOT_SIZE");
  const notionalFilter = symbol.filters.find((f) => f.filterType === "MIN_NOTIONAL" || f.filterType === "NOTIONAL");

  return {
    symbol: symbol.symbol,
    tickSize: parseNumber(priceFilter?.tickSize ?? undefined),
    stepSize: parseNumber(lotSizeFilter?.stepSize ?? marketLotSizeFilter?.stepSize ?? undefined),
    minQty: parseNumber(lotSizeFilter?.minQty ?? marketLotSizeFilter?.minQty ?? undefined),
    maxQty: parseNumber(lotSizeFilter?.maxQty ?? marketLotSizeFilter?.maxQty ?? undefined),
    minNotional: parseNumber(notionalFilter?.minNotional ?? notionalFilter?.notional ?? undefined),
  };
}

export class BinanceFuturesClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly http: AxiosInstance;

  constructor(options: BinanceFuturesClientOptions = {}) {
    const defaults = readExchangeDefaults().binance;
    const apiKey = (options.apiKey ?? defaults.apiKey ?? "").trim();
    const apiSecret = (options.apiSecret ?? defaults.apiSecret ?? "").trim();
    const useTestnet = options.useTestnet ?? defaults.useTestnet;
    const baseUrl = trimTrailingSlash(
      (options.baseUrl ?? defaults.baseUrl ?? "").trim() ||
        (useTestnet ? "https://testnet.binancefuture.com" : "https://fapi.binance.com")
    );

    const missing: string[] = [];
    if (!apiKey) missing.push("BINANCE_FUTURES_API_KEY");
    if (!apiSecret) missing.push("BINANCE_FUTURES_API_SECRET");
    if (missing.length > 0) {
      throw new Error(
        `Missing Binance USD-M Futures credentials: ${missing.join(", ")}. Set them in the environment before running the read-only check.`
      );
    }

    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = baseUrl;
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 15_000,
      headers: {
        "X-MBX-APIKEY": this.apiKey,
      },
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getMaskedApiKey(): string {
    return maskKey(this.apiKey);
  }

  getMaskedApiSecret(): string {
    return maskKey(this.apiSecret);
  }

  async getServerTime(): Promise<BinanceFuturesServerTime> {
    const response = await this.http.get<BinanceFuturesServerTime>("/fapi/v1/time");
    return response.data;
  }

  async getExchangeInfo(): Promise<BinanceFuturesExchangeInfo> {
    const response = await this.http.get<BinanceFuturesExchangeInfo>("/fapi/v1/exchangeInfo");
    return response.data;
  }

  async getAccountInfo(recvWindow = 5_000): Promise<BinanceFuturesAccountInfo> {
    const response = await this.signedGet<BinanceFuturesAccountInfo>("/fapi/v2/account", {
      recvWindow,
    });
    return response.data;
  }

  async getBalances(): Promise<BinanceFuturesBalanceView[]> {
    const account = await this.getAccountInfo();
    return account.assets.map((asset) => ({
      asset: asset.asset,
      walletBalance: asset.walletBalance,
      availableBalance: asset.availableBalance,
      unrealizedProfit: asset.unrealizedProfit,
      marginBalance: asset.marginBalance,
      crossWalletBalance: asset.crossWalletBalance,
      crossUnPnl: asset.crossUnPnl,
    }));
  }

  async getOpenPositions(): Promise<BinanceFuturesOpenPositionView[]> {
    const account = await this.getAccountInfo();
    return account.positions
      .filter((position) => Math.abs(position.positionAmt) > 0)
      .map((position) => ({
        symbol: position.symbol,
        positionSide: position.positionSide,
        positionAmt: position.positionAmt,
        entryPrice: position.entryPrice,
        markPrice: position.markPrice,
        unrealizedProfit: position.unrealizedProfit,
        leverage: position.leverage,
        isolated: position.isolated,
        liquidationPrice: position.liquidationPrice,
        marginAsset: position.marginAsset,
        updateTime: position.updateTime,
      }));
  }

  async getSymbolFilters(symbol: string): Promise<BinanceFuturesSymbolFilters | null> {
    const exchangeInfo = await this.getExchangeInfo();
    const normalized = symbol.trim().toUpperCase();
    const found = exchangeInfo.symbols.find((entry) => entry.symbol === normalized);
    return found ? pickSymbolFilters(found) : null;
  }

  private async signedGet<T>(
    path: string,
    params: Record<string, string | number | undefined> = {}
  ): Promise<{ data: T }> {
    const signedParams = {
      ...params,
      timestamp: Date.now(),
    };
    const query = toSignedQuery(signedParams);
    const signature = createHmac("sha256", this.apiSecret).update(query).digest("hex");
    const response = await this.http.get<T>(`${path}?${query}&signature=${signature}`);
    return { data: response.data };
  }
}

export function createBinanceFuturesClient(
  options: BinanceFuturesClientOptions = {}
): BinanceFuturesClient {
  return new BinanceFuturesClient(options);
}

export function resolveBinanceFuturesClientOptionsFromEnv(): BinanceFuturesClientOptions {
  const exchange = readBinanceExchangeConfig();
  const options: BinanceFuturesClientOptions = {
    useTestnet: exchange.useTestnet,
    baseUrl: exchange.baseUrl,
    apiKey: exchange.apiKey,
    apiSecret: exchange.apiSecret,
  };
  return options;
}
