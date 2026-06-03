import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { registerThreadSession } from "../src/sessions/chat-session-manager.js";
import { createSessionRuntime } from "../src/runtime/session-runtime.js";
import {
  createManagedSessionFile,
  getChannelSessionDir,
  getThreadSessionFile,
  openManagedSession,
} from "../src/sessions/store.js";
import type { SandboxConfig } from "../src/sandbox/index.js";
import type { VaultManager } from "../src/vault/index.js";

let workingDir: string;
let conversationDir: string;

beforeEach(() => {
  workingDir = join(
    tmpdir(),
    `mikan-session-runtime-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  conversationDir = join(workingDir, "C123");
  mkdirSync(conversationDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
});

function makeRuntime() {
  const sandbox: SandboxConfig = { type: "host" };
  return createSessionRuntime({
    workingDir,
    sandbox,
    vaultManager: {
      hasEntry: () => false,
      resolve: () => undefined,
      getSandboxConfig: (_uid, base) => base,
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
  } as any);
}

function makeUserMessage(text: string) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1,
  } as const;
}

describe("SessionRuntime chat session scope", () => {
  test("uses a pre-registered empty thread session for Slack event anchors", async () => {
    const sessionDir = getChannelSessionDir(conversationDir);
    const channelFile = createManagedSessionFile(sessionDir, conversationDir);
    const channelSession = openManagedSession(channelFile, sessionDir, conversationDir);
    channelSession.appendMessage(makeUserMessage("channel history should not leak"));

    const runtime = makeRuntime();
    registerThreadSession({
      conversationDir,
      sessionKey: "C123:2000.0001",
      cwd: conversationDir,
    });

    // This intentionally reaches the private scope resolver: the bug was in
    // pre-run session materialization, before a public run can observe it.
    const sessionScope = await (runtime as any).resolveSessionScope({
      conversationDir,
      sessionKey: "C123:2000.0001",
      cwd: conversationDir,
    });

    expect(sessionScope.contextFile).toBe(getThreadSessionFile(conversationDir, "C123:2000.0001"));
    expect(sessionScope.threadRootMessage).toBeNull();
    expect(readFileSync(sessionScope.contextFile, "utf-8")).not.toContain(
      "channel history should not leak",
    );
  });
});
