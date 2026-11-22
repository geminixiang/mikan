import { describe, expect, test } from "vitest";
import { allowsAmbientDefaultSharedVault } from "../vault/index.js";

describe("allowsAmbientDefaultSharedVault", () => {
  test("membership + image allows ambient copy", () => {
    expect(allowsAmbientDefaultSharedVault("membership")).toBe(true);
  });

  test("defaults omitted trustModel to membership", () => {
    expect(allowsAmbientDefaultSharedVault()).toBe(true);
  });

  test("open-trigger never allows ambient copy", () => {
    expect(allowsAmbientDefaultSharedVault("open-trigger")).toBe(false);
  });
});
