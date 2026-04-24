import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBybitSignature, createBybitClient } from "./bybitClient.js";

describe("BybitClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails clearly when API credentials are missing", () => {
    expect(() =>
      createBybitClient({
        enabled: true,
        testnet: true,
        apiKey: "",
        apiSecret: "",
      })
    ).toThrowError(/Missing Bybit V5 credentials/);
  });

  it("rejects disabled read-only mode", () => {
    expect(() =>
      createBybitClient({
        enabled: false,
        apiKey: "a",
        apiSecret: "b",
      })
    ).toThrowError(/BYBIT_ENABLED is not true/);
  });

  it("builds the expected HMAC signature deterministically", () => {
    expect(
      buildBybitSignature({
        apiKey: "test-key",
        apiSecret: "test-secret",
        timestamp: "1658384314791",
        recvWindow: "5000",
        queryOrBody: "accountType=UNIFIED",
      })
    ).toBe("edbffe3f3eeb9baf6b94d4564b43c1ab691113041c2c533b9ccb6ce114c0e930");
  });
});
