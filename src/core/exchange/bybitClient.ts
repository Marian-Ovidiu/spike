import axios, { type AxiosInstance } from "axios";
import { createHmac } from "node:crypto";
import {
  readBybitExchangeConfig,
  readExchangeDefaults,
} from "../../config/env.js";

export type BybitClientOptions = {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  enabled?: boolean;
  testnet?: boolean;
  category?: string;
  symbol?: string;
  recvWindow?: number;
};

export type BybitApiTime = {
  timeSecond: number;
  timeNano?: string;
};

export type BybitInstrumentPriceFilter = {
  tickSize: number | null;
  minPrice: number | null;
  maxPrice: number | null;
};

export type BybitInstrumentLotSizeFilter = {
  qtyStep: number | null;
  minOrderQty: number | null;
  maxOrderQty: number | null;
  minNotionalValue: number | null;
};

export type BybitInstrumentInfoView = {
  symbol: string;
  category: string;
  status: string;
  priceFilter: BybitInstrumentPriceFilter;
  lotSizeFilter: BybitInstrumentLotSizeFilter;
};

export type BybitWalletBalanceCoin = {
  coin: string;
  walletBalance: number | null;
  equity: number | null;
  availableToWithdraw: number | null;
  availableBalance: number | null;
  unrealisedPnl: number | null;
};

export type BybitWalletBalanceAccount = {
  accountType: string;
  totalWalletBalance: number | null;
  totalEquity: number | null;
  totalMarginBalance: number | null;
  totalAvailableBalance: number | null;
  totalPerpUPL: number | null;
  coins: BybitWalletBalanceCoin[];
};

export type BybitPositionView = {
  symbol: string;
  side: string;
  size: number | null;
  avgPrice: number | null;
  markPrice: number | null;
  positionValue: number | null;
  leverage: number | null;
  liqPrice: number | null;
  unrealisedPnl: number | null;
  updatedTime: number | null;
};

export type BybitInstrumentFilters = {
  symbol: string;
  tickSize: number | null;
  qtyStep: number | null;
  minOrderQty: number | null;
  maxOrderQty: number | null;
  minNotionalValue: number | null;
};

export type BybitApiResponse<T> = {
  retCode: number;
  retMsg: string;
  result: T;
  time?: number;
};

export type BybitInstrumentInfoResponse = BybitApiResponse<{
  category: string;
  list: Array<{
    symbol: string;
    status: string;
    category?: string;
    priceFilter?: {
      minPrice?: string;
      maxPrice?: string;
      tickSize?: string;
    };
    lotSizeFilter?: {
      minOrderQty?: string;
      maxOrderQty?: string;
      qtyStep?: string;
      minNotionalValue?: string;
    };
  }>;
}>;

export type BybitWalletBalanceResponse = BybitApiResponse<{
  list: Array<{
    accountType: string;
    totalWalletBalance?: string;
    totalEquity?: string;
    totalMarginBalance?: string;
    totalAvailableBalance?: string;
    totalPerpUPL?: string;
    coin?: Array<{
      coin: string;
      walletBalance?: string;
      equity?: string;
      availableToWithdraw?: string;
      availableBalance?: string;
      unrealisedPnl?: string;
    }>;
  }>;
}>;

export type BybitPositionListResponse = BybitApiResponse<{
  category: string;
  list: Array<{
    symbol: string;
    side: string;
    size?: string;
    avgPrice?: string;
    markPrice?: string;
    positionValue?: string;
    leverage?: string;
    liqPrice?: string;
    unrealisedPnl?: string;
    updatedTime?: string;
  }>;
}>;

function maskKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}***`;
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.replace(/\/+$/, "") : value;
}

function parseNumber(value: string | number | undefined): number | null {
  if (value === undefined || value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toSortedQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined);
  entries.sort(([a], [b]) => a.localeCompare(b));
  return new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString();
}

export function buildBybitSignature(input: {
  apiKey: string;
  apiSecret: string;
  timestamp: string;
  recvWindow: string;
  queryOrBody: string;
}): string {
  return createHmac("sha256", input.apiSecret)
    .update(`${input.timestamp}${input.apiKey}${input.recvWindow}${input.queryOrBody}`)
    .digest("hex");
}

function maskSignature(signature: string): string {
  if (signature.length <= 10) {
    return `${signature.slice(0, 2)}***`;
  }
  return `${signature.slice(0, 8)}***${signature.slice(-6)}`;
}

function isBybitAuthDebugEnabled(): boolean {
  return readExchangeDefaults().bybit.authDebug;
}

function formatBybitErrorBody(body: unknown): string {
  if (body === null || body === undefined) {
    return "body=<empty>";
  }
  if (typeof body === "string") {
    return `body=${body}`;
  }
  if (typeof body !== "object") {
    return `body=${String(body)}`;
  }

  const typed = body as { retCode?: unknown; retMsg?: unknown };
  const parts: string[] = [];
  if (typed.retCode !== undefined) parts.push(`retCode=${String(typed.retCode)}`);
  if (typed.retMsg !== undefined) parts.push(`retMsg=${String(typed.retMsg)}`);
  const summary = parts.join(" ");
  const serialized = (() => {
    try {
      return JSON.stringify(body);
    } catch {
      return "[unserializable body]";
    }
  })();
  return summary.length > 0 ? `${summary} body=${serialized}` : `body=${serialized}`;
}

function pickInstrumentFilters(entry: {
  symbol: string;
  category?: string;
  status: string;
  priceFilter?: {
    minPrice?: string;
    maxPrice?: string;
    tickSize?: string;
  };
  lotSizeFilter?: {
    minOrderQty?: string;
    maxOrderQty?: string;
    qtyStep?: string;
    minNotionalValue?: string;
  };
}): BybitInstrumentFilters {
  return {
    symbol: entry.symbol,
    tickSize: parseNumber(entry.priceFilter?.tickSize),
    qtyStep: parseNumber(entry.lotSizeFilter?.qtyStep),
    minOrderQty: parseNumber(entry.lotSizeFilter?.minOrderQty),
    maxOrderQty: parseNumber(entry.lotSizeFilter?.maxOrderQty),
    minNotionalValue: parseNumber(entry.lotSizeFilter?.minNotionalValue),
  };
}

export class BybitClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly category: string;
  private readonly symbol: string;
  private readonly recvWindow: number;
  private readonly http: AxiosInstance;

  constructor(options: BybitClientOptions = {}) {
    const defaults = readExchangeDefaults().bybit;
    const enabled = options.enabled ?? defaults.enabled;
    if (!enabled) {
      throw new Error("BYBIT_ENABLED is not true. Bybit read-only checks are disabled.");
    }

    const apiKey = (options.apiKey ?? defaults.apiKey ?? "").trim();
    const apiSecret = (options.apiSecret ?? defaults.apiSecret ?? "").trim();
    const testnet = options.testnet ?? defaults.testnet;
    const baseUrl = trimTrailingSlash(
      (options.baseUrl ?? defaults.baseUrl ?? "").trim() ||
        (testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com")
    );
    const category = (options.category ?? defaults.category ?? "linear").trim();
    const symbol = (options.symbol ?? defaults.symbol ?? "BTCUSDT").trim().toUpperCase();
    const recvWindow = options.recvWindow ?? defaults.recvWindow;

    const missing: string[] = [];
    if (!apiKey) missing.push("BYBIT_API_KEY");
    if (!apiSecret) missing.push("BYBIT_API_SECRET");
    if (missing.length > 0) {
      throw new Error(
        `Missing Bybit V5 credentials: ${missing.join(", ")}. Set them in the environment before running the read-only check.`
      );
    }

    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = baseUrl;
    this.category = category;
    this.symbol = symbol;
    this.recvWindow = recvWindow;
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 15_000,
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getCategory(): string {
    return this.category;
  }

  getSymbol(): string {
    return this.symbol;
  }

  getRecvWindow(): number {
    return this.recvWindow;
  }

  getMaskedApiKey(): string {
    return maskKey(this.apiKey);
  }

  getMaskedApiSecret(): string {
    return maskKey(this.apiSecret);
  }

  async getMarketTime(): Promise<BybitApiTime> {
    const response = await this.http.get<BybitApiResponse<{ timeSecond: string; timeNano?: string }>>(
      "/v5/market/time"
    );
    const result: BybitApiTime = {
      timeSecond: parseNumber(response.data.result.timeSecond) ?? 0,
    };
    const timeNano = response.data.result.timeNano?.trim();
    if (timeNano) result.timeNano = timeNano;
    return result;
  }

  async getInstrumentsInfo(
    category = this.category,
    symbol = this.symbol
  ): Promise<BybitInstrumentInfoResponse["result"]> {
    const response = await this.http.get<BybitInstrumentInfoResponse>(
      "/v5/market/instruments-info",
      { params: { category, symbol } }
    );
    return response.data.result;
  }

  async getInstrumentFilters(
    category = this.category,
    symbol = this.symbol
  ): Promise<BybitInstrumentFilters | null> {
    const info = await this.getInstrumentsInfo(category, symbol);
    const found = info.list.find((entry) => entry.symbol === symbol.toUpperCase());
    return found ? pickInstrumentFilters(found) : null;
  }

  async getWalletBalance(
    accountType = "UNIFIED"
  ): Promise<BybitWalletBalanceAccount[]> {
    const response = await this.signedGet<BybitWalletBalanceResponse>(
      "/v5/account/wallet-balance",
      { accountType }
    );
    return response.data.result.list.map((account) => ({
      accountType: account.accountType,
      totalWalletBalance: parseNumber(account.totalWalletBalance),
      totalEquity: parseNumber(account.totalEquity),
      totalMarginBalance: parseNumber(account.totalMarginBalance),
      totalAvailableBalance: parseNumber(account.totalAvailableBalance),
      totalPerpUPL: parseNumber(account.totalPerpUPL),
      coins: (account.coin ?? []).map((coin) => ({
        coin: coin.coin,
        walletBalance: parseNumber(coin.walletBalance),
        equity: parseNumber(coin.equity),
        availableToWithdraw: parseNumber(coin.availableToWithdraw),
        availableBalance: parseNumber(coin.availableBalance),
        unrealisedPnl: parseNumber(coin.unrealisedPnl),
      })),
    }));
  }

  async getOpenPositions(
    category = this.category,
    symbol = this.symbol
  ): Promise<BybitPositionView[]> {
    const response = await this.signedGet<BybitPositionListResponse>("/v5/position/list", {
      category,
      symbol,
    });
    return response.data.result.list
      .filter((position) => {
        const size = parseNumber(position.size);
        return size !== null && size !== 0;
      })
      .map((position) => ({
        symbol: position.symbol,
        side: position.side,
        size: parseNumber(position.size),
        avgPrice: parseNumber(position.avgPrice),
        markPrice: parseNumber(position.markPrice),
        positionValue: parseNumber(position.positionValue),
        leverage: parseNumber(position.leverage),
        liqPrice: parseNumber(position.liqPrice),
        unrealisedPnl: parseNumber(position.unrealisedPnl),
        updatedTime: parseNumber(position.updatedTime),
      }));
  }

  private async signedGet<T>(
    path: string,
    params: Record<string, string | number | undefined> = {}
  ): Promise<{ data: T }> {
    const timestamp = String(Date.now());
    const recvWindow = String(this.recvWindow);
    const queryOrBody = toSortedQuery(params);
    const signature = buildBybitSignature({
      apiKey: this.apiKey,
      apiSecret: this.apiSecret,
      timestamp,
      recvWindow,
      queryOrBody,
    });
    const url = queryOrBody.length > 0 ? `${path}?${queryOrBody}` : path;
    if (isBybitAuthDebugEnabled()) {
      const preSign = `${timestamp}${this.apiKey}${recvWindow}${queryOrBody}`;
      console.log(
        [
          "bybit auth debug",
          `path=${path}`,
          `timestamp=${timestamp}`,
          `recvWindow=${recvWindow}`,
          `queryString=${queryOrBody || "<empty>"}`,
          `preSignLength=${preSign.length}`,
          `apiKey=${this.getMaskedApiKey()}`,
          `signature=${maskSignature(signature)}`,
        ].join(" ")
      );
    }

    try {
      const response = await this.http.get<T>(url, {
        headers: {
          "X-BAPI-API-KEY": this.apiKey,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
          "X-BAPI-SIGN-TYPE": "2",
          "X-BAPI-SIGN": signature,
        },
      });
      return { data: response.data };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        const status = error.response.status;
        const body = error.response.data;
        const detail = formatBybitErrorBody(body);
        console.error(`Bybit signed request failed: method=GET path=${path} status=${status} ${detail}`);
        throw new Error(`Bybit signed request failed: GET ${path} returned HTTP ${status}. ${detail}`);
      }
      throw error;
    }
  }
}

export function createBybitClient(options: BybitClientOptions = {}): BybitClient {
  return new BybitClient(options);
}

export function resolveBybitClientOptionsFromEnv(): BybitClientOptions {
  const exchange = readBybitExchangeConfig();
  const options: BybitClientOptions = {
    enabled: exchange.enabled,
    testnet: exchange.testnet,
    baseUrl: exchange.baseUrl,
    category: exchange.category,
    symbol: exchange.symbol,
    recvWindow: exchange.recvWindow,
  };
  options.apiKey = exchange.apiKey;
  options.apiSecret = exchange.apiSecret;
  return options;
}
