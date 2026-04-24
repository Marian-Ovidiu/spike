import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCoinbaseJwtDetails,
  buildDeterministicQueryString,
  CoinbaseApiError,
  CoinbaseClient,
} from "./coinbaseClient.js";

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
}

function rawSignatureToDer(signature: Buffer): Buffer {
  if (signature.length !== 64) {
    throw new Error("Expected 64-byte raw ES256 signature.");
  }
  const r = trimLeadingZeros(signature.subarray(0, 32));
  const s = trimLeadingZeros(signature.subarray(32, 64));
  const rEncoded = encodeDerInteger(r);
  const sEncoded = encodeDerInteger(s);
  const sequenceLength = rEncoded.length + sEncoded.length;
  return Buffer.concat([Buffer.from([0x30, sequenceLength]), rEncoded, sEncoded]);
}

function trimLeadingZeros(value: Buffer): Buffer {
  let index = 0;
  while (index < value.length - 1 && value[index] === 0) index += 1;
  return value.subarray(index);
}

function encodeDerInteger(value: Buffer): Buffer {
  const needsLeadingZero = (value[0] ?? 0) & 0x80 ? 1 : 0;
  const encodedValue = needsLeadingZero ? Buffer.concat([Buffer.from([0x00]), value]) : value;
  return Buffer.concat([Buffer.from([0x02, encodedValue.length]), encodedValue]);
}

function decodeJwtPart<T>(token: string, index: 0 | 1): T {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Expected a JWT with three parts.");
  }
  return JSON.parse(decodeBase64Url(parts[index])) as T;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Coinbase client", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const privatePemEscaped = privatePem.replace(/\n/g, "\\n");

  it("builds a deterministic query string", () => {
    const query = buildDeterministicQueryString({
      product_ids: ["ETH-USD", "BTC-USD"],
      contract_expiry_type: "PERPETUAL",
      limit: 10,
    });
    expect(query).toBe("contract_expiry_type=PERPETUAL&limit=10&product_ids=BTC-USD&product_ids=ETH-USD");
  });

  it("builds ES256 JWT details with escaped and multiline private keys", async () => {
    const escaped = await buildCoinbaseJwtDetails({
      apiKeyName: "organizations/abc/apiKeys/def",
      apiPrivateKey: privatePemEscaped,
      requestMethod: "GET",
      requestHost: "api.coinbase.com",
      requestPath: "/api/v3/brokerage/accounts",
      expiresInSec: 120,
    });
    const multiline = await buildCoinbaseJwtDetails({
      apiKeyName: "organizations/abc/apiKeys/def",
      apiPrivateKey: privatePem,
      requestMethod: "GET",
      requestHost: "api.coinbase.com",
      requestPath: "/api/v3/brokerage/products?contract_expiry_type=PERPETUAL&product_type=FUTURE",
      expiresInSec: 120,
    });

    expect(escaped.header.alg).toBe("ES256");
    expect(escaped.header.kid).toBe("organizations/abc/apiKeys/def");
    expect(escaped.header.nonce).toHaveLength(32);
    expect(escaped.payload.sub).toBe("organizations/abc/apiKeys/def");
    expect(escaped.payload.uris).toEqual(["GET api.coinbase.com/api/v3/brokerage/accounts"]);
    expect(escaped.payload.iss).toBe("cdp");

    expect(multiline.payload.uris).toEqual([
      "GET api.coinbase.com/api/v3/brokerage/products?contract_expiry_type=PERPETUAL&product_type=FUTURE",
    ]);
    expect(multiline.payload.exp - multiline.payload.nbf).toBe(120);
    expect(multiline.payload.iat).toBeDefined();
    expect(multiline.payload.iat).toBe(multiline.payload.nbf);

    const header = decodeJwtPart<Record<string, unknown>>(multiline.token, 0);
    expect(header.kid).toBe("organizations/abc/apiKeys/def");
    expect(header.nonce).toBeTruthy();

    const [headerB64, payloadB64, signatureB64] = multiline.token.split(".");
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
    const signature = Buffer.from(
      signatureB64.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (signatureB64.length % 4)) % 4),
      "base64"
    );
    expect(cryptoVerify("sha256", signingInput, publicKey, rawSignatureToDer(signature))).toBe(
      true
    );
  });

  it("surfaces a readable HTTP error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ message: "No access", errors: [{ message: "Bad key" }] }), {
          status: 401,
          statusText: "Unauthorized",
          headers: { "content-type": "application/json" },
        })
      )
    );

    const client = new CoinbaseClient({
      apiKeyName: "organizations/abc/apiKeys/def",
      apiPrivateKey: privatePem,
      baseUrl: "https://api.coinbase.com",
      productId: "",
      derivativesEnabled: true,
      authDebug: false,
      feeMakerBps: 0,
      feeTakerBps: 0,
    });

    await expect(client.getServerTime()).rejects.toMatchObject({
      name: "CoinbaseApiError",
      status: 401,
      responseSummary: "No access | Bad key",
    });
    await expect(client.getServerTime()).rejects.toBeInstanceOf(CoinbaseApiError);
  });
});
