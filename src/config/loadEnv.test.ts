import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unmock("dotenv");
});

describe("loadEnv", () => {
  it("loads dotenv at import time", async () => {
    const config = vi.fn();
    vi.doMock("dotenv", () => ({
      default: { config },
    }));

    await import("./loadEnv.js");

    expect(config).toHaveBeenCalledTimes(1);
  });
});
