import { describe, expect, test } from "vitest";
import { allowsAmbientDefaultSharedVault } from "../src/vault/policy.js";

describe("allowsAmbientDefaultSharedVault", () => {
  test("membership + image allows ambient copy", () => {
    expect(
      allowsAmbientDefaultSharedVault({ trustModel: "membership", sandboxType: "image" }),
    ).toBe(true);
  });

  test("defaults omitted trustModel to membership", () => {
    expect(allowsAmbientDefaultSharedVault({ sandboxType: "image" })).toBe(true);
  });

  test("open-trigger never allows ambient copy", () => {
    expect(
      allowsAmbientDefaultSharedVault({ trustModel: "open-trigger", sandboxType: "image" }),
    ).toBe(false);
  });

  test("image is the only mode that inherits the shared vault", () => {
    // A trust rule, not a topology rule. gondolin is isolated and
    // per-conversation exactly like image, and must still be excluded: its
    // purpose is running code from people the workspace does not trust.
    for (const sandboxType of ["host", "container", "firecracker", "gondolin"] as const) {
      expect(allowsAmbientDefaultSharedVault({ trustModel: "membership", sandboxType })).toBe(
        false,
      );
    }
  });
});
