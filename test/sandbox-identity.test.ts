import { describe, expect, test } from "vitest";
import {
  actorKey,
  sanitizeIdentitySegment,
  scopeCloudflareSandboxId,
} from "../src/sandbox/identity.js";
import { DockerContainerManager } from "../src/provisioner.js";
import { resolveActorVaultKey } from "../src/vault/routing.js";

describe("runtime identity", () => {
  test("one sanitizer: collapses runs, strips edges, lowercases", () => {
    expect(sanitizeIdentitySegment("GH_owner_repo_42")).toBe("gh-owner-repo-42");
    expect(sanitizeIdentitySegment("a--b__c")).toBe("a-b-c");
    expect(sanitizeIdentitySegment("--x--")).toBe("x");
    expect(sanitizeIdentitySegment("///")).toBe("unknown");
  });

  test("actorKey is per-conversation for managed sandboxes", () => {
    const ids = { userId: "U1", conversationId: "GH_o_r_5" };
    expect(actorKey({ type: "image", image: "ubuntu" }, ids)).toBe("gh-o-r-5");
    expect(actorKey({ type: "gondolin", profile: "default" }, ids)).toBe("gh-o-r-5");
    expect(actorKey({ type: "cloudflare", sandboxId: "base" }, ids)).toBe("gh-o-r-5");
    expect(actorKey({ type: "firecracker", vmId: "vm", hostPath: "/w" }, ids)).toBe("gh-o-r-5");
  });

  test("actorKey is the container name for shared containers and userId on host", () => {
    const ids = { userId: "U1", conversationId: "C1" };
    expect(actorKey({ type: "container", container: "shared" }, ids)).toBe("container-shared");
    expect(actorKey({ type: "host" }, ids)).toBe("U1");
  });

  test("every consumer derives the same key", () => {
    const config = { type: "image", image: "ubuntu" } as const;
    const key = actorKey(config, { userId: "U1", conversationId: "C-123" });
    expect(resolveActorVaultKey(config, "U1", "C-123")).toBe(key);
    expect(DockerContainerManager.sanitizeSegment("C-123")).toBe(key);
  });

  test("cloudflare scoping uses the same sanitizer", () => {
    expect(scopeCloudflareSandboxId("mikan-remote", "Alice--01")).toBe("mikan-remote-alice-01");
  });
});
