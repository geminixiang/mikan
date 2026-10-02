import { mkdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { RunEventHub } from "../harness/run-events.js";
import { InMemoryLinkTokenStore } from "../adapters/web/login/portal.js";
import { InMemorySessionViewTokenStore } from "../adapters/web/session-view/portal.js";
import { closeWebServer, startWebServer } from "../adapters/web/server.js";
import { createOfficeAddress } from "../office/index.js";
import { createManagedSessionFile } from "../sessions/store.js";
import { FileVaultManager } from "../vault/index.js";

let root: string;
let server: Server | undefined;

beforeEach(() => {
  root = join(tmpdir(), `session-view-live-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
});

afterEach(async () => {
  if (server) await closeWebServer(server, 0);
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

interface StreamPayload {
  type: string;
  html?: string;
  running?: boolean;
  timelineHtml?: string;
}

async function openSessionStream(runEvents: RunEventHub, sessionKey: string) {
  const conversationDir = join(root, "C1");
  mkdirSync(conversationDir, { recursive: true });
  const sessionFile = createManagedSessionFile(join(conversationDir, "sessions"));
  const sessionViewTokenStore = new InMemorySessionViewTokenStore();
  const { token } = sessionViewTokenStore.create({
    platform: "slack",
    platformUserId: "U1",
    conversationId: "C1",
    sessionKey,
    sessionFile,
  });
  server = startWebServer({
    port: 0,
    host: "127.0.0.1",
    linkTokenStore: new InMemoryLinkTokenStore(),
    vaultManager: new FileVaultManager(join(root, "vaults")),
    notify: async () => {},
    sessionViewTokenStore,
    sessionViewInteractive: {
      handler: {
        isRunning: () => false,
        getRunningSessions: () => [],
        handleEvent: async () => {},
        handleStop: async () => {},
        forceStop: () => {},
        handleNewCommand: async () => {},
      },
      botsByPlatform: {},
      runEvents,
    },
  });
  if (!server.listening) await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("web server has no TCP address");
  const response = await fetch(`http://127.0.0.1:${address.port}/session/stream?token=${token}`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const payloads: StreamPayload[] = [];
  let buffered = "";
  const readUntil = async (done: (payloads: StreamPayload[]) => boolean) => {
    while (!done(payloads)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("session stream ended early");
      buffered += decoder.decode(chunk.value);
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        if (frame.startsWith("data: ")) payloads.push(JSON.parse(frame.slice(6)) as StreamPayload);
      }
    }
    return payloads;
  };
  await readUntil((seen) => seen.length > 0);
  return { readUntil, cancel: () => reader.cancel().catch(() => {}) };
}

test("an open Session View streams a run started from the chat platform", async () => {
  const runEvents = new RunEventHub();
  const stream = await openSessionStream(runEvents, "C1");
  const office = createOfficeAddress("slack", "C1");

  runEvents.publish(office, "C1", { type: "run_started", userName: "alice", text: "list files" });
  runEvents.publish(office, "C1", {
    type: "tool_ended",
    toolCallId: "t1",
    toolName: "bash",
    isError: false,
    resultText: "README.md",
  });
  runEvents.publish(office, "C1", { type: "assistant_delta", delta: "Found " });
  runEvents.publish(office, "C1", { type: "assistant_delta", delta: "two files" });
  runEvents.publish(office, "C1", { type: "run_ended", stopReason: "stop" });

  const payloads = await stream.readUntil((seen) => seen.some((p) => p.type === "refresh"));
  await stream.cancel();

  const live = payloads.slice(1);
  expect(live.map((payload) => payload.type)).toEqual([
    "status",
    "user",
    "tool",
    "assistant",
    "assistant",
    "refresh",
  ]);
  expect(live[0]).toMatchObject({ running: true });
  expect(live[1]?.html).toContain("list files");
  expect(live[2]?.html).toContain("README.md");
  expect(live[4]?.html).toContain("Found two files");
  expect(live[5]).toMatchObject({ running: false });
});

test("a Session View ignores runs of other sessions in the same conversation", async () => {
  const runEvents = new RunEventHub();
  const stream = await openSessionStream(runEvents, "C1");
  const office = createOfficeAddress("slack", "C1");

  runEvents.publish(office, "C1:2000.1", { type: "run_started", userName: "bob", text: "other" });
  runEvents.publish(office, "C1", { type: "run_started", userName: "alice", text: "mine" });

  const payloads = await stream.readUntil((seen) => seen.some((p) => p.type === "user"));
  await stream.cancel();

  const users = payloads.filter((payload) => payload.type === "user");
  expect(users).toHaveLength(1);
  expect(users[0]?.html).toContain("mine");
});
