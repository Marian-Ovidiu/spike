import { createPrivateKey } from "node:crypto";
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { readCoinbaseExchangeConfig, type CoinbaseExchangeDefaults } from "../../config/env.js";

export type CoinbaseQueryValue =
  | string
  | number
  | boolean
  | readonly (string | number | boolean)[];

export type CoinbaseQueryParams = Record<string, CoinbaseQueryValue | undefined | null>;

export type CoinbaseServerTime = {
  iso?: string;
  epochSeconds?: string;
  epochMillis?: string;
};

export type CoinbaseProduct = {
  product_id: string;
  product_type?: string;
  contract_expiry_type?: string;
  base_increment?: string;
  quote_increment?: string;
  base_min_size?: string;
  quote_min_size?: string;
  price?: string;
  price_percentage_change_24h?: string;
  volume_24h?: string;
  volume_percentage_change_24h?: string;
  future_product_details?: {
    product_id?: string;
    contract_expiry_type?: string;
    product_type?: string;
    perpetual_details?: Record<string, unknown>;
    expiring_details?: Record<string, unknown>;
  };
  [key: string]: unknown;
};

export type CoinbaseProductListResponse = {
  products?: CoinbaseProduct[];
  has_next?: boolean;
  cursor?: string;
  [key: string]: unknown;
};

export type CoinbaseProductBookResponse = {
  pricebook?: {
    product_id?: string;
    bids?: Array<{ price: string; size: string }>;
    asks?: Array<{ price: string; size: string }>;
    time?: string;
  };
  last?: string;
  mid_market?: string;
  spread_bps?: string;
  spread_absolute?: string;
  [key: string]: unknown;
};

export type CoinbasePublicTickerResponse = {
  price?: string;
  best_bid?: string;
  best_ask?: string;
  trade_id?: string;
  volume_24h?: string;
  [key: string]: unknown;
};

export type CoinbaseBestBidAskResponse = {
  pricebooks?: Array<{
    product_id?: string;
    bids?: Array<{ price: string; size: string }>;
    asks?: Array<{ price: string; size: string }>;
    time?: string;
  }>;
  [key: string]: unknown;
};

export type CoinbaseTransactionSummary = {
  total_fees?: number | string;
  fee_tier?: {
    maker_fee_rate?: string;
    taker_fee_rate?: string;
    pricing_tier?: string;
    volume_types_and_range?: unknown[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type CoinbaseAccountsResponse = {
  accounts?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type CoinbasePortfoliosResponse = {
  portfolios?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type CoinbaseFuturesPositionResponse = {
  position?: Record<string, unknown>;
  positions?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type CoinbaseFeeSchedule = {
  makerFeeBps: number;
  takerFeeBps: number;
  source: "api" | "fallback";
  pricingTier?: string | undefined;
};

type CoinbaseJwtHeader = {
  alg: string;
  kid: string;
  nonce?: string;
  typ?: string;
  [key: string]: unknown;
};

type CoinbaseJwtPayload = {
  iss: string;
  sub: string;
  nbf: number;
  exp: number;
  uris: string[];
  iat?: number;
  aud?: string[];
  [key: string]: unknown;
};

export type CoinbaseJwtDetails = {
  token: string;
  header: CoinbaseJwtHeader;
  payload: CoinbaseJwtPayload;
  requestMethod: string;
  requestHost: string;
  requestPath: string;
  uri: string;
};

export class CoinbaseApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly responseBody: string;
  readonly requestPath: string;
  readonly responseSummary: string | undefined;

  constructor(opts: {
    status: number;
    statusText: string;
    responseBody: string;
    requestPath: string;
    responseSummary?: string;
  }) {
    super(
      `Coinbase request failed for ${opts.requestPath}: ${opts.status} ${opts.statusText}${
        opts.responseSummary ? ` - ${opts.responseSummary}` : ""
      }`
    );
    this.name = "CoinbaseApiError";
    this.status = opts.status;
    this.statusText = opts.statusText;
    this.responseBody = opts.responseBody;
    this.requestPath = opts.requestPath;
    this.responseSummary = opts.responseSummary;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizePrivateKey(privateKey: string): string {
  return privateKey.replace(/\\n/g, "\n").trim();
}

function toPkcs8EcPrivateKey(privateKey: string): string {
  const keyObject = createPrivateKey(normalizePrivateKey(privateKey));
  if (keyObject.asymmetricKeyType !== "ec") {
    throw new Error(
      "Coinbase Advanced Trade JWT requires an EC private key compatible with ES256."
    );
  }
  return keyObject.export({ format: "pem", type: "pkcs8" }).toString();
}

function decodeJwtPart(part: string): unknown {
  const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return JSON.parse(Buffer.from(`${normalized}${padding}`, "base64").toString("utf8")) as unknown;
}

function extractErrorSummary(responseJson: unknown): string | undefined {
  if (!responseJson || typeof responseJson !== "object") return undefined;
  const summaryParts: string[] = [];
  const asRecord = responseJson as Record<string, unknown>;
  const values = [
    asRecord.message,
    asRecord.error,
    asRecord.error_message,
    asRecord.detail,
    asRecord.description,
  ];
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      summaryParts.push(value.trim());
    }
  }
  if (Array.isArray(asRecord.errors)) {
    for (const entry of asRecord.errors) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        summaryParts.push(entry.trim());
      } else if (entry && typeof entry === "object") {
        const nested = entry as Record<string, unknown>;
        for (const field of [nested.message, nested.error, nested.detail]) {
          if (typeof field === "string" && field.trim().length > 0) {
            summaryParts.push(field.trim());
          }
        }
      }
    }
  }
  return summaryParts.length > 0 ? summaryParts.join(" | ") : undefined;
}

function toReadableBodySummary(bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) return "(empty body)";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const summary = extractErrorSummary(parsed);
    if (summary) return summary;
    if (parsed && typeof parsed === "object") {
      return JSON.stringify(parsed);
    }
  } catch {
    // Fall through to raw body.
  }
  return trimmed;
}

export function maskSecret(value: string | undefined | null): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}***`;
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`;
}

export function buildDeterministicQueryString(
  params: CoinbaseQueryParams | undefined
): string {
  if (!params) return "";

  const searchParams = new URLSearchParams();
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right));

  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      const sortedItems = value
        .map((item) => String(item))
        .filter((item) => item.length > 0)
        .sort((left, right) => left.localeCompare(right));
      for (const item of sortedItems) {
        searchParams.append(key, item);
      }
      continue;
    }
    searchParams.append(key, String(value));
  }

  return searchParams.toString();
}

async function signJwt(input: {
  apiKeyName: string;
  apiPrivateKey: string;
  requestMethod: string;
  requestHost: string;
  requestPath: string;
  nowMs?: number;
  expiresInSec?: number;
}): Promise<CoinbaseJwtDetails> {
  const requestMethod = input.requestMethod.toUpperCase();
  const requestHost = input.requestHost;
  const requestPath = input.requestPath;
  const uri = `${requestMethod} ${requestHost}${requestPath}`;
  const expiresInSec = input.expiresInSec ?? 120;

  const normalizedPrivateKey = toPkcs8EcPrivateKey(input.apiPrivateKey);
  const token = await generateJwt({
    apiKeyId: input.apiKeyName,
    apiKeySecret: normalizedPrivateKey,
    requestMethod,
    requestHost,
    requestPath,
    expiresIn: expiresInSec,
  });

  const [headerPart, payloadPart] = token.split(".");
  if (!headerPart || !payloadPart) {
    throw new Error("Coinbase JWT generation returned an invalid token.");
  }

  const header = decodeJwtPart(headerPart) as CoinbaseJwtHeader;
  const payload = decodeJwtPart(payloadPart) as CoinbaseJwtPayload;
  if (header.alg !== "ES256") {
    throw new Error(`Coinbase JWT must use ES256, received ${String(header.alg)}.`);
  }
  if (payload.iss !== "cdp") {
    throw new Error(`Coinbase JWT must use iss=cdp, received ${String(payload.iss)}.`);
  }
  if (payload.sub !== input.apiKeyName) {
    throw new Error("Coinbase JWT subject does not match the API key name.");
  }
  if (!Array.isArray(payload.uris) || payload.uris.length === 0 || payload.uris[0] !== uri) {
    throw new Error("Coinbase JWT uri claim does not match the signed request.");
  }

  return {
    token,
    header,
    payload,
    requestMethod,
    requestHost,
    requestPath,
    uri,
  };
}

export async function buildCoinbaseJwt(input: {
  apiKeyName: string;
  apiPrivateKey: string;
  requestMethod: string;
  requestHost: string;
  requestPath: string;
  nowMs?: number;
  expiresInSec?: number;
}): Promise<string> {
  return (await signJwt(input)).token;
}

export async function buildCoinbaseJwtDetails(input: {
  apiKeyName: string;
  apiPrivateKey: string;
  requestMethod: string;
  requestHost: string;
  requestPath: string;
  nowMs?: number;
  expiresInSec?: number;
}): Promise<CoinbaseJwtDetails> {
  return signJwt(input);
}

export class CoinbaseClient {
  readonly config: CoinbaseExchangeDefaults;
  readonly baseUrl: string;
  readonly host: string;

  constructor(config: CoinbaseExchangeDefaults = readCoinbaseExchangeConfig()) {
    this.config = config;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.host = new URL(this.baseUrl).host;
  }

  private buildRequestPath(path: string, query?: CoinbaseQueryParams): string {
    const queryString = buildDeterministicQueryString(query);
    return queryString ? `${path}?${queryString}` : path;
  }

  private async buildAuthDetails(
    requestMethod: string,
    requestPath: string
  ): Promise<CoinbaseJwtDetails> {
    return buildCoinbaseJwtDetails({
      apiKeyName: this.config.apiKeyName,
      apiPrivateKey: this.config.apiPrivateKey,
      requestMethod,
      requestHost: this.host,
      requestPath,
    });
  }

  private async requestJsonPublic<T>(requestPath: string, query?: CoinbaseQueryParams): Promise<T> {
    const pathWithQuery = this.buildRequestPath(requestPath, query);
    const url = new URL(pathWithQuery, `${this.baseUrl}/`);
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new CoinbaseApiError({
        status: response.status,
        statusText: response.statusText,
        responseBody: responseText,
        requestPath: pathWithQuery,
        responseSummary: toReadableBodySummary(responseText),
      });
    }

    if (!responseText.trim()) return {} as T;
    return JSON.parse(responseText) as T;
  }

  private async requestJsonAuthenticated<T>(
    requestPath: string,
    query?: CoinbaseQueryParams
  ): Promise<T> {
    const pathWithQuery = this.buildRequestPath(requestPath, query);
    const url = new URL(pathWithQuery, `${this.baseUrl}/`);
    const authDetails = await this.buildAuthDetails("GET", pathWithQuery);
    if (this.config.authDebug) {
      console.log(
        JSON.stringify({
          exchange: "coinbase",
          method: authDetails.requestMethod,
          host: authDetails.requestHost,
          path: authDetails.requestPath,
          keyName: maskSecret(this.config.apiKeyName),
          header: authDetails.header,
          payload: authDetails.payload,
        })
      );
    }
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${authDetails.token}`,
        Accept: "application/json",
      },
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new CoinbaseApiError({
        status: response.status,
        statusText: response.statusText,
        responseBody: responseText,
        requestPath: pathWithQuery,
        responseSummary: toReadableBodySummary(responseText),
      });
    }

    if (!responseText.trim()) return {} as T;
    return JSON.parse(responseText) as T;
  }

  getServerTime(): Promise<CoinbaseServerTime> {
    return this.requestJsonPublic<CoinbaseServerTime>("/api/v3/brokerage/time");
  }

  listProducts(options: {
    limit?: number;
    offset?: number;
    productType?: "SPOT" | "FUTURE" | "UNKNOWN_PRODUCT_TYPE";
    contractExpiryType?: "EXPIRING" | "PERPETUAL" | "UNKNOWN_CONTRACT_EXPIRY_TYPE";
    productIds?: string[];
  } = {}): Promise<CoinbaseProductListResponse> {
    return this.requestJsonPublic<CoinbaseProductListResponse>("/api/v3/brokerage/products", {
      limit: options.limit,
      offset: options.offset,
      product_type: options.productType,
      contract_expiry_type: options.contractExpiryType,
      product_ids: options.productIds,
    });
  }

  getProduct(productId: string): Promise<CoinbaseProduct> {
    return this.requestJsonPublic<CoinbaseProduct>(
      `/api/v3/brokerage/products/${encodeURIComponent(productId)}`
    );
  }

  getProductBook(productId: string): Promise<CoinbaseProductBookResponse> {
    return this.requestJsonPublic<CoinbaseProductBookResponse>("/api/v3/brokerage/product_book", {
      product_id: productId,
    });
  }

  getPublicProductBook(productId: string): Promise<CoinbaseProductBookResponse> {
    return this.requestJsonPublic<CoinbaseProductBookResponse>(
      "/api/v3/brokerage/market/product_book",
      {
        product_id: productId,
      }
    );
  }

  getBestBidAsk(productIds: string[]): Promise<CoinbaseBestBidAskResponse> {
    return this.requestJsonPublic<CoinbaseBestBidAskResponse>(
      "/api/v3/brokerage/best_bid_ask",
      productIds.length > 0 ? { product_ids: productIds } : undefined
    );
  }

  getPublicMarketTicker(productId: string): Promise<CoinbasePublicTickerResponse> {
    return this.requestJsonPublic<CoinbasePublicTickerResponse>(
      `/api/v3/brokerage/market/products/${encodeURIComponent(productId)}/ticker`
    );
  }

  getTransactionSummary(): Promise<CoinbaseTransactionSummary> {
    return this.requestJsonAuthenticated<CoinbaseTransactionSummary>(
      "/api/v3/brokerage/transaction_summary"
    );
  }

  listAccounts(): Promise<CoinbaseAccountsResponse> {
    return this.requestJsonAuthenticated<CoinbaseAccountsResponse>("/api/v3/brokerage/accounts");
  }

  listPortfolios(): Promise<CoinbasePortfoliosResponse> {
    return this.requestJsonAuthenticated<CoinbasePortfoliosResponse>("/api/v3/brokerage/portfolios");
  }

  getFuturesPosition(productId: string): Promise<CoinbaseFuturesPositionResponse> {
    return this.requestJsonAuthenticated<CoinbaseFuturesPositionResponse>(
      `/api/v3/brokerage/cfm/positions/${encodeURIComponent(productId)}`
    );
  }

  async getFeeSchedule(): Promise<CoinbaseFeeSchedule> {
    try {
      const summary = await this.getTransactionSummary();
      const makerRate = parseFeeRate(summary.fee_tier?.maker_fee_rate);
      const takerRate = parseFeeRate(summary.fee_tier?.taker_fee_rate);
      if (makerRate !== undefined && takerRate !== undefined) {
        return {
          makerFeeBps: makerRate * 10_000,
          takerFeeBps: takerRate * 10_000,
          source: "api",
          pricingTier: summary.fee_tier?.pricing_tier,
        };
      }
    } catch {
      // Fallback below.
    }

    return {
      makerFeeBps: this.config.feeMakerBps ?? 0,
      takerFeeBps: this.config.feeTakerBps ?? 0,
      source: "fallback",
      pricingTier: undefined,
    };
  }

  resolveDefaultProductId(productId?: string): string | undefined {
    return productId?.trim() || this.config.productId.trim() || undefined;
  }

  pickDiscoveryProduct(products: CoinbaseProduct[]): string | undefined {
    const sorted = [...products].filter((product) => Boolean(product.product_id));
    if (this.config.derivativesEnabled) {
      const derivative = sorted.find((product) => {
        const productType = String(product.product_type ?? "").toUpperCase();
        const expiryType = String(product.contract_expiry_type ?? "").toUpperCase();
        const nestedProductType = String(product.future_product_details?.product_type ?? "").toUpperCase();
        const nestedExpiryType = String(
          product.future_product_details?.contract_expiry_type ?? ""
        ).toUpperCase();
        return (
          productType === "FUTURE" ||
          nestedProductType === "FUTURE" ||
          expiryType === "PERPETUAL" ||
          nestedExpiryType === "PERPETUAL"
        );
      });
      if (derivative) {
        return derivative.product_id;
      }
    }
    return sorted[0]?.product_id;
  }
}

function parseFeeRate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/%$/, "");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed > 1 ? parsed / 100 : parsed;
}
