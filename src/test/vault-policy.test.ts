import { describe, expect, test } from "vitest";
import { allowsAmbientDefaultSharedVault } from "../vault/index.js";

describe("allowsAmbientDefaultSharedVault", () => {
  test("membership + ambient-capable sandbox allows ambient copy", () => {
    expect(
      allowsAmbientDefaultSharedVault({ trustModel: "membership", ambientSharedVault: true }),
    ).toBe(true);
  });

  test("membership + non-ambient sandbox never allows ambient copy", () => {
    expect(
      allowsAmbientDefaultSharedVault({ trustModel: "membership", ambientSharedVault: false }),
    ).toBe(false);
  });

  test("defaults omitted trustModel to membership", () => {
    expect(allowsAmbientDefaultSharedVault({ ambientSharedVault: true })).toBe(true);
  });

  test("open-trigger never allows ambient copy", () => {
    expect(
      allowsAmbientDefaultSharedVault({ trustModel: "open-trigger", ambientSharedVault: true }),
    ).toBe(false);
    expect(
      allowsAmbientDefaultSharedVault({ trustModel: "open-trigger", ambientSharedVault: false }),
    ).toBe(false);
  });
});
