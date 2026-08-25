import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessPrincipal } from "@geminixiang/mikan-harness-web-contract";
import { afterEach, describe, expect, test } from "vitest";
import { createOfficeAddress, createWorkspace, officeKey } from "../office/index.js";
import { WebConversationIdentity } from "../web/harness/conversation-id.js";

const principal: HarnessPrincipal = { id: "github:101", displayName: "octo" };
const other: HarnessPrincipal = { id: "github:202", displayName: "other" };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("WebConversationIdentity", () => {
  test("creates durable web office identities scoped to one OAuth principal", () => {
    const root = mkdtempSync(join(tmpdir(), "mikan-web-identity-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const workspace = createWorkspace({ root: join(root, "workspace"), stateDir });
    const identity = new WebConversationIdentity(stateDir);
    const address = identity.create(principal);
    workspace.office(address).ensure();

    expect(address.platform).toBe("web");
    expect(address.conversationId).not.toContain(":");
    expect(officeKey(address)).not.toContain(address.conversationId.slice(-24));
    expect(identity.owns(principal, address)).toBe(true);
    expect(identity.owns(other, address)).toBe(false);

    // Previous development builds placed the owner digest first. Refuse that
    // spelling rather than exposing a stable cross-conversation owner hint.
    const legacy = createOfficeAddress("web", `w1-${"a".repeat(24)}-${"b".repeat(32)}`);
    expect(identity.owns(principal, legacy)).toBe(false);

    const afterRestart = new WebConversationIdentity(stateDir);
    expect(afterRestart.listOwned(principal)).toEqual([address]);
    expect(afterRestart.listOwned(other)).toEqual([]);
    expect(afterRestart.resolveOwned(principal, officeKey(address))).toEqual(address);
  });

  test("fails closed when the ownership key is lost after web offices exist", () => {
    const root = mkdtempSync(join(tmpdir(), "mikan-web-identity-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const workspace = createWorkspace({ root: join(root, "workspace"), stateDir });
    const identity = new WebConversationIdentity(stateDir);
    workspace.office(identity.create(principal)).ensure();
    rmSync(join(stateDir, "web-harness.key"));

    expect(() => new WebConversationIdentity(stateDir)).toThrow(/restore/);
  });
});
