import { describe, expect, test } from "vitest";
import {
  credentialAuthorizationKey,
  legacyConversationCredentialKey,
  legacyExactCredentialAuthorizationKey,
  runtimeResourceKey,
  sanitizeIdentitySegment,
  scopeCloudflareSandboxId,
} from "../sandbox/identity.js";
import { createOfficeAddress, officeKey } from "../office/index.js";

const image = { type: "image", image: "ubuntu" } as const;

describe("sandbox identity", () => {
  test("keeps readable segments while adding collision-safe identity", () => {
    const first = runtimeResourceKey(image, {
      userId: "U1",
      address: createOfficeAddress("slack", "A.B"),
    });
    const second = runtimeResourceKey(image, {
      userId: "U1",
      address: createOfficeAddress("slack", "A-B"),
    });

    expect(first).toMatch(/^v1-slack-a-b-[a-f0-9]{16}$/);
    expect(second).toMatch(/^v1-slack-a-b-[a-f0-9]{16}$/);
    expect(first).not.toBe(second);
  });

  test("platforms sharing a raw id never share a runtime resource", () => {
    const discord = runtimeResourceKey(image, {
      userId: "U1",
      address: createOfficeAddress("discord", "900100"),
    });
    const telegram = runtimeResourceKey(image, {
      userId: "U1",
      address: createOfficeAddress("telegram", "900100"),
    });
    expect(discord).not.toBe(telegram);
  });

  test("credential authorization and resource derivation share the office key", () => {
    const scope = { userId: "U1", address: createOfficeAddress("slack", "C1") };
    // Conversation-scoped credentials and runtime resources both key by
    // office: the same string that names the office in the workspace and
    // the registry.
    expect(credentialAuthorizationKey(image, scope)).toBe(officeKey(scope.address));
    expect(runtimeResourceKey(image, { userId: "U1", address: scope.address })).toBe(
      officeKey(scope.address),
    );
    expect(credentialAuthorizationKey({ type: "host" }, scope)).toMatch(/^u1-[a-f0-9]{12}$/);
  });

  test("platforms sharing a raw id never share credentials", () => {
    const discord = { userId: "U1", address: createOfficeAddress("discord", "900100") };
    const telegram = { userId: "U1", address: createOfficeAddress("telegram", "900100") };
    expect(credentialAuthorizationKey(image, discord)).not.toBe(
      credentialAuthorizationKey(image, telegram),
    );
  });

  test("legacy conversation vault keys stay derivable for the boot migration", () => {
    expect(legacyConversationCredentialKey("C1")).toMatch(/^c1-[a-f0-9]{12}$/);
  });

  test("only retains exact legacy credential identities", () => {
    const scope = { userId: "U1", address: createOfficeAddress("slack", "C1") };
    expect(legacyExactCredentialAuthorizationKey({ type: "host" }, scope)).toBe("U1");
    expect(
      legacyExactCredentialAuthorizationKey({ type: "container", container: "shared" }, scope),
    ).toBe("container-shared");
    expect(legacyExactCredentialAuthorizationKey(image, scope)).toBeUndefined();
  });

  test("sanitizes readable identity segments", () => {
    expect(sanitizeIdentitySegment("GH_owner_repo_42")).toBe("gh-owner-repo-42");
    expect(sanitizeIdentitySegment("///")).toBe("unknown");
  });

  test("scopes cloudflare ids with the resolved resource key", () => {
    expect(scopeCloudflareSandboxId("mikan", "c1-0123456789ab")).toBe("mikan-c1-0123456789ab");
  });
});
