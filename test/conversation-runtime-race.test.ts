import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createConversationRuntime } from "../src/runtime/conversation-runtime.js";
import type { SandboxConfig } from "../src/sandbox/index.js";
import type { VaultManager } from "../src/vault/index.js";

let workingDir: string;
let conversationDir: string;

beforeEach(() => {
  workingDir = join(
    tmpdir(),
    `mikan-conv-runtime-race-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  conversationDir = join(workingDir, "C_RACE");
  mkdirSync(conversationDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
});

function makeRuntime() {
  const sandbox: SandboxConfig = { type: "host" };
  return createConversationRuntime({
    workingDir,
    sandbox,
    vaultManager: {
      hasEntry: () => false,
      resolve: () => undefined,
      getSandboxConfig: (_uid: unknown, base: unknown) => base,
      list: () => [],
      isEnabled: () => true,
      upsertEnv: () => {},
      upsertFile: () => {},
      listSharedVaults: () => [],
      deleteSharedVault: () => false,
      copySharedVaultTo: () => ({ filesCopied: 0, envKeysCopied: 0 }),
    } as VaultManager,
    linkTokenStore: { create: () => ({ token: "link" }) },
    sessionViewTokenStore: { create: () => ({ token: "session" }) },
    adminTokenStore: { create: () => ({ token: "admin" }) },
    // biome-ignore lint: test double
  } as any);
}

describe("ConversationRuntime concurrent session creation", () => {
  test("two concurrent createSessionSandbox() calls for the same sessionKey share one runner", async () => {
    const runtime = makeRuntime();

    const [a, b] = await Promise.all([
      runtime.createSessionSandbox({ conversationId: "C_RACE", sessionKey: "C_RACE" }),
      runtime.createSessionSandbox({ conversationId: "C_RACE", sessionKey: "C_RACE" }),
    ]);

    expect(a).toBe(b);
  });
});
