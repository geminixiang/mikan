import { describe, expect, test } from "vitest";
import {
  assertGondolinRemotePlatformIsolation,
  credentialAuthorizationKey,
  legacyExactCredentialAuthorizationKey,
  runtimeResourceKey,
  sanitizeIdentitySegment,
  scopeCloudflareSandboxId,
} from "../src/sandbox/identity.js";

const image = { type: "image", image: "ubuntu" } as const;

describe("sandbox identity", () => {
  test("fails closed for Discord and Telegram gondolin:remote ID overlap", () => {
    expect(() =>
      assertGondolinRemotePlatformIsolation({ type: "gondolin", profile: "remote" }, [
        "telegram",
        "discord",
      ]),
    ).toThrow("cannot run Discord and Telegram together");
    expect(() =>
      assertGondolinRemotePlatformIsolation({ type: "gondolin", profile: "remote" }, [
        "slack",
        "github",
      ]),
    ).not.toThrow();
    expect(() =>
      assertGondolinRemotePlatformIsolation(
        { type: "gondolin", profile: "remote" },
        ["telegram", "discord"],
        true,
      ),
    ).not.toThrow();
    expect(() =>
      assertGondolinRemotePlatformIsolation(image, ["telegram", "discord"]),
    ).not.toThrow();
  });

  test("keeps readable segments while adding collision-safe identity", () => {
    const first = runtimeResourceKey(image, { userId: "U1", conversationId: "A/B" });
    const second = runtimeResourceKey(image, { userId: "U1", conversationId: "A-B" });

    expect(first).toMatch(/^a-b-[a-f0-9]{12}$/);
    expect(second).toMatch(/^a-b-[a-f0-9]{12}$/);
    expect(first).not.toBe(second);
  });

  test("separates credential authorization and resource derivation", () => {
    const ids = { userId: "U1", conversationId: "C1" };
    expect(credentialAuthorizationKey(image, ids)).toMatch(/^c1-[a-f0-9]{12}$/);
    expect(runtimeResourceKey(image, ids)).toMatch(/^c1-[a-f0-9]{12}$/);
    expect(credentialAuthorizationKey({ type: "host" }, ids)).toMatch(/^u1-[a-f0-9]{12}$/);
  });

  test("only retains exact legacy credential identities", () => {
    const ids = { userId: "U1", conversationId: "A/B" };
    expect(legacyExactCredentialAuthorizationKey({ type: "host" }, ids)).toBe("U1");
    expect(
      legacyExactCredentialAuthorizationKey({ type: "container", container: "shared" }, ids),
    ).toBe("container-shared");
    expect(legacyExactCredentialAuthorizationKey(image, ids)).toBeUndefined();
  });

  test("sanitizes readable identity segments", () => {
    expect(sanitizeIdentitySegment("GH_owner_repo_42")).toBe("gh-owner-repo-42");
    expect(sanitizeIdentitySegment("///")).toBe("unknown");
  });

  test("scopes cloudflare ids with the resolved resource key", () => {
    expect(scopeCloudflareSandboxId("mikan", "c1-0123456789ab")).toBe("mikan-c1-0123456789ab");
  });
});
