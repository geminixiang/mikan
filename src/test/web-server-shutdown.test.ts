import { mkdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { InMemoryLinkTokenStore } from "../adapters/web/login/portal.js";
import { InMemorySessionViewTokenStore } from "../adapters/web/session-view/portal.js";
import type { SessionViewInteractiveOptions } from "../adapters/web/session-view/types.js";
import { closeWebServer, startWebServer } from "../adapters/web/server.js";
import { officeSessionsDir } from "../office/index.js";
import { createManagedSessionFile } from "../sessions/store.js";
import { FileVaultManager } from "../vault/index.js";

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `web-server-shutdown-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function listeningPort(server: Server): Promise<number> {
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("web server has no TCP address");
  return address.port;
}

function idleInteractiveOptions(): SessionViewInteractiveOptions {
  return {
    handler: {
      isRunning: () => false,
      getRunningSessions: () => [],
      handleEvent: async () => {},
      handleStop: async () => {},
      forceStop: () => {},
      handleNewCommand: async () => {},
    },
    botsByPlatform: {},
  };
}

test("closing the web server ends an open session stream instead of waiting for the viewer to leave", async () => {
  const conversationDir = join(root, "D123");
  mkdirSync(conversationDir, { recursive: true });
  const sessionFile = createManagedSessionFile(officeSessionsDir(conversationDir), conversationDir);
  const sessionViewTokenStore = new InMemorySessionViewTokenStore();
  const { token } = sessionViewTokenStore.create({
    platform: "slack",
    platformUserId: "U1",
    conversationId: "D123",
    sessionKey: "D123",
    sessionFile,
  });
  const server = startWebServer({
    port: 0,
    linkTokenStore: new InMemoryLinkTokenStore(),
    vaultManager: new FileVaultManager(join(root, "vaults")),
    notify: async () => {},
    sessionViewTokenStore,
    sessionViewInteractive: idleInteractiveOptions(),
  });
  const port = await listeningPort(server);

  const stream = await fetch(`http://127.0.0.1:${port}/session/stream?token=${token}`);
  const reader = stream.body!.getReader();
  const firstChunk = new TextDecoder().decode((await reader.read()).value);
  expect(firstChunk).toContain('"type":"status"');

  const closed = closeWebServer(server, 50).then(() => "closed" as const);
  const stillOpen = new Promise<"still open">((resolve) =>
    setTimeout(() => resolve("still open"), 2000),
  );

  expect(await Promise.race([closed, stillOpen])).toBe("closed");
  await reader.cancel().catch(() => {});
});
