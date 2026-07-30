import { describe, expect, test } from "vitest";
import { allowsAmbientDefaultSharedVault } from "../vault/index.js";

describe("allowsAmbientDefaultSharedVault", () => {
  test("membership + image allows ambient copy", () => {
    expect(
      allowsAmbientDefaultSharedVault({ trustModel: "membership", sandboxType: "image" }),
    ).toBe(true);
  });

  test("membership + cloudflare allows ambient copy", () => {
    expect(
      allowsAmbientDefaultSharedVault({ trustModel: "membership", sandboxType: "cloudflare" }),
    ).toBe(true);
  });

  test("defaults omitted trustModel to membership", () => {
    expect(allowsAmbientDefaultSharedVault({ sandboxType: "image" })).toBe(true);
  });

  test("open-trigger never allows ambient copy", () => {
    expect(
      allowsAmbientDefaultSharedVault({ trustModel: "open-trigger", sandboxType: "image" }),
    ).toBe(false);
    expect(
      allowsAmbientDefaultSharedVault({ trustModel: "open-trigger", sandboxType: "cloudflare" }),
    ).toBe(false);
  });

  test("host / container / firecracker never use ambient copy path", () => {
    for (const sandboxType of ["host", "container", "firecracker"] as const) {
      expect(allowsAmbientDefaultSharedVault({ trustModel: "membership", sandboxType })).toBe(
        false,
      );
    }
  });
});
