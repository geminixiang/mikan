import { describe, expect, test } from "vitest";
import { getGlobalDispatcher, EnvHttpProxyAgent } from "undici";
import {
  DEFAULT_HTTP_IDLE_TIMEOUT_MS,
  configureHttpDispatcher,
  parseHttpIdleTimeoutMs,
} from "../harness/index.js";

describe("parseHttpIdleTimeoutMs", () => {
  test("accepts non-negative numbers, flooring fractions", () => {
    expect(parseHttpIdleTimeoutMs(0)).toBe(0);
    expect(parseHttpIdleTimeoutMs(30_000)).toBe(30_000);
    expect(parseHttpIdleTimeoutMs(1500.9)).toBe(1500);
  });

  test("accepts numeric strings and the disabled keyword", () => {
    expect(parseHttpIdleTimeoutMs("60000")).toBe(60_000);
    expect(parseHttpIdleTimeoutMs(" disabled ")).toBe(0);
    expect(parseHttpIdleTimeoutMs("Disabled")).toBe(0);
  });

  test("rejects invalid values", () => {
    expect(parseHttpIdleTimeoutMs("")).toBeUndefined();
    expect(parseHttpIdleTimeoutMs("soon")).toBeUndefined();
    expect(parseHttpIdleTimeoutMs(-1)).toBeUndefined();
    expect(parseHttpIdleTimeoutMs(Number.NaN)).toBeUndefined();
    expect(parseHttpIdleTimeoutMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(parseHttpIdleTimeoutMs(null)).toBeUndefined();
    expect(parseHttpIdleTimeoutMs(undefined)).toBeUndefined();
  });
});

const fetchOverride: typeof globalThis.fetch = () => Promise.reject(new Error("stub"));

describe("configureHttpDispatcher", () => {
  test("installs an EnvHttpProxyAgent as the global dispatcher", () => {
    configureHttpDispatcher(DEFAULT_HTTP_IDLE_TIMEOUT_MS);
    expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });

  test("swaps global fetch to undici's and keeps it on reconfigure", () => {
    configureHttpDispatcher();
    const installedFetch = globalThis.fetch;
    configureHttpDispatcher(60_000);
    expect(globalThis.fetch).toBe(installedFetch);
  });

  test("preserves a deliberate fetch override", () => {
    configureHttpDispatcher();
    const installedFetch = globalThis.fetch;
    globalThis.fetch = fetchOverride;
    try {
      configureHttpDispatcher();
      expect(globalThis.fetch).toBe(fetchOverride);
    } finally {
      globalThis.fetch = installedFetch;
    }
  });

  test("throws on an unparseable timeout", () => {
    expect(() => configureHttpDispatcher(-5)).toThrow(/Invalid HTTP idle timeout/);
  });
});
