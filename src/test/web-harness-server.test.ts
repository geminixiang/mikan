import type { UserMessage } from "@earendil-works/pi-ai";
import type { ConversationContext, ConversationEvent } from "../adapter.js";
import { WebMessagingBot } from "../adapters/web/bot.js";
import type { HarnessEvent, HarnessEventListener } from "../harness/index.js";
import type { ConversationRuntime } from "../runtime/conversation-runtime.js";
import { WebEventHub } from "../web/harness/hub.js";
import { existsSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createWorkspace, officeKey, officeSessionsDir } from "../office/index.js";
import { openManagedSession, createManagedSessionFile } from "../sessions/store.js";
import { FileVaultManager } from "../vault/index.js";
import type { WebAuthRequestOptions } from "../web/auth/portal.js";
import { WebAuthRegistry } from "../web/auth/registry.js";
import { WebHarnessService } from "../web/harness/service.js";
import { InMemoryLinkTokenStore } from "../web/login/store.js";
import { startWebServer } from "../web/server.js";

let dir: string;
let server: Server;
let url: string;
let registry: WebAuthRegistry;
let cookies: string;
let csrf: string;
let accountId: string;
let workspaceRoot: string;
let runtime: FakeWebRuntime;
let hub: WebEventHub;
let bot: WebMessagingBot;

class FakeWebRuntime implements ConversationRuntime {
  private listener: HarnessEventListener | undefined;
  private running = false;
  private settlement: (() => void) | undefined;
  readonly events: Array<{
    event: ConversationEvent;
    context: ConversationContext;
  }> = [];
  readonly queued: Array<{
    message: ConversationContext["message"];
    mode: "followUp" | "steer";
    queueId?: string;
  }> = [];
  forceStopCalls = 0;

  isRunning(): boolean {
    return this.running;
  }

  getRunningSessions() {
    return [];
  }

  async handleEvent(
    event: ConversationEvent,
    _bot: Parameters<ConversationRuntime["handleEvent"]>[1],
    context: ConversationContext,
  ): Promise<void> {
    this.running = true;
    this.events.push({ event, context });
    await new Promise<void>((resolve) => {
      this.settlement = resolve;
    });
    this.running = false;
  }

  async runSession(options: Parameters<ConversationRuntime["runSession"]>[0]) {
    return this.handleEvent(options.event, options.bot, options.context);
  }

  queueMessage(
    _address: Parameters<ConversationRuntime["queueMessage"]>[0],
    _sessionKey: string,
    message: ConversationContext["message"],
    mode: "followUp" | "steer",
    queueId?: string,
  ): boolean {
    if (!this.running) return false;
    this.queued.push({ message, mode, queueId });
    return true;
  }

  subscribe(
    _address: Parameters<ConversationRuntime["subscribe"]>[0],
    _sessionKey: string,
    listener: HarnessEventListener,
  ): (() => void) | null {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  forceStop(): void {
    this.forceStopCalls++;
  }

  async handleStop(): Promise<void> {}
  async handleNewCommand(): Promise<void> {}
  async handleExtensionAction(): Promise<boolean> {
    return false;
  }
  async handleExtensionScheduleCallback(): Promise<boolean> {
    return false;
  }
  switchConversationModel(): boolean {
    return false;
  }
  refreshConversationEnvironment(): boolean {
    return false;
  }
  refreshAllConversations() {
    return { busy: [] };
  }
  async shutdown(): Promise<void> {}

  emit(event: HarnessEvent): void {
    void this.listener?.(event);
  }

  settle(): void {
    this.settlement?.();
    this.settlement = undefined;
  }
}

async function waitForListening(value: Server): Promise<void> {
  if (value.listening) return;
  await new Promise<void>((resolve) => value.once("listening", resolve));
}

function baseUrl(value: Server): string {
  const address = value.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
}

function mutationHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Cookie: cookies,
    Origin: url,
    "Content-Type": "application/json",
    "X-Mikan-CSRF": csrf,
    ...extra,
  };
}

beforeEach(async () => {
  dir = join(tmpdir(), `mikan-web-harness-${Date.now()}-${Math.random()}`);
  registry = new WebAuthRegistry(join(dir, "state"));
  const account = registry.completeOAuthIdentity({
    provider: "github",
    subject: "12345",
    displayName: "Example User",
  }).account;
  accountId = account.id;
  const session = registry.createLoginSession(account.id);
  cookies = `mikan_web_session=${session.token}; mikan_web_csrf=${session.csrfToken}`;
  csrf = session.csrfToken;
  const auth: WebAuthRequestOptions = { registry, providers: {} };
  workspaceRoot = join(dir, "workspace");
  const workspace = createWorkspace({
    root: workspaceRoot,
    stateDir: join(dir, "state"),
  });
  runtime = new FakeWebRuntime();
  hub = new WebEventHub();
  bot = new WebMessagingBot(workspace, hub);
  server = startWebServer({
    port: 0,
    linkTokenStore: new InMemoryLinkTokenStore(),
    vaultManager: new FileVaultManager(join(dir, "state")),
    notify: async () => {},
    webAuth: auth,
    webHarness: {
      auth,
      service: new WebHarnessService(registry, workspace, {
        runtime,
        bot,
        hub,
      }),
    },
  });
  await waitForListening(server);
  url = baseUrl(server);
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  rmSync(dir, { recursive: true, force: true });
});

describe("Web workspace APIs", () => {
  test("lists the Personal workspace and creates a materialized Web office", async () => {
    const initial = await fetch(`${url}/api/web/workspaces`, {
      headers: { Cookie: cookies },
    });
    expect(initial.status).toBe(200);
    const initialBody = (await initial.json()) as {
      workspaces: Array<{ id: string; name: string }>;
    };
    expect(initialBody.workspaces).toHaveLength(1);
    expect(initialBody.workspaces[0]?.name).toBe("Personal");

    const created = await fetch(`${url}/api/web/workspaces`, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ name: "Research" }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      workspace: { id: string; name: string };
    };
    expect(body.workspace.name).toBe("Research");
    const officePath = join(
      dir,
      "workspace",
      officeKey({ platform: "web", conversationId: body.workspace.id }),
    );
    expect(existsSync(officePath)).toBe(true);
  });

  test("renames without changing workspace identity or office path", async () => {
    const record = registry.createWorkspace(accountId, "Before");
    const beforeKey = officeKey({ platform: "web", conversationId: record.id });

    const response = await fetch(`${url}/api/web/workspaces/${record.id}`, {
      method: "PATCH",
      headers: mutationHeaders(),
      body: JSON.stringify({ name: "After" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspace: { id: record.id, name: "After" },
    });
    expect(officeKey({ platform: "web", conversationId: record.id })).toBe(beforeKey);
  });

  test("returns the same not-found result for unknown and foreign workspaces", async () => {
    const other = registry.completeOAuthIdentity({
      provider: "google",
      subject: "other",
      displayName: "Other",
    }).account;
    const foreign = registry.listWorkspaces(other.id)[0]!;

    for (const workspaceId of ["wsp_missing", foreign.id]) {
      const sessions = await fetch(`${url}/api/web/workspaces/${workspaceId}/sessions`, {
        headers: { Cookie: cookies },
      });
      expect(sessions.status).toBe(404);
      await expect(sessions.json()).resolves.toEqual({
        error: "Workspace not found",
      });
    }
  });

  test("requires authenticated CSRF-protected JSON mutations", async () => {
    const unauthenticated = await fetch(`${url}/api/web/workspaces`);
    expect(unauthenticated.status).toBe(401);

    const noCsrf = await fetch(`${url}/api/web/workspaces`, {
      method: "POST",
      headers: {
        Cookie: cookies,
        Origin: url,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Denied" }),
    });
    expect(noCsrf.status).toBe(401);

    const wrongType = await fetch(`${url}/api/web/workspaces`, {
      method: "POST",
      headers: mutationHeaders({ "Content-Type": "text/plain" }),
      body: JSON.stringify({ name: "Denied" }),
    });
    expect(wrongType.status).toBe(415);
  });

  test("lists sessions and loads history only by opaque session id", async () => {
    const workspaceId = registry.listWorkspaces(accountId)[0]!.id;
    const officePath = join(
      workspaceRoot,
      officeKey({ platform: "web", conversationId: workspaceId }),
    );
    const sessionFile = createManagedSessionFile(officeSessionsDir(officePath), officePath);
    const session = await openManagedSession(sessionFile, officePath);
    await session.setSessionName("Browser session");
    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "private browser history" }],
      timestamp: 1,
    } satisfies UserMessage);
    const sessionId = session.getHeader().id;

    const sessions = await fetch(`${url}/api/web/workspaces/${workspaceId}/sessions`, {
      headers: { Cookie: cookies },
    });
    expect(sessions.status).toBe(200);
    await expect(sessions.json()).resolves.toEqual({
      sessions: [
        expect.objectContaining({
          id: sessionId,
          title: "Browser session",
          entryCount: 1,
          current: true,
        }),
      ],
    });

    const history = await fetch(
      `${url}/api/web/workspaces/${workspaceId}/history?sessionId=${encodeURIComponent(sessionId)}`,
      { headers: { Cookie: cookies } },
    );
    expect(history.status).toBe(200);
    const body = (await history.json()) as {
      session: {
        sessionId: string;
        fileName?: string;
        items: Array<{ body?: string }>;
      };
    };
    expect(body.session.sessionId).toBe(sessionId);
    expect(body.session.fileName).toBeUndefined();
    expect(body.session.items[0]?.body).toContain("private browser history");
  });

  test("does not expose history from a foreign workspace", async () => {
    const ownWorkspaceId = registry.listWorkspaces(accountId)[0]!.id;
    const ownOfficePath = join(
      workspaceRoot,
      officeKey({ platform: "web", conversationId: ownWorkspaceId }),
    );
    const ownSessionFile = createManagedSessionFile(
      officeSessionsDir(ownOfficePath),
      ownOfficePath,
    );
    const ownSession = await openManagedSession(ownSessionFile, ownOfficePath);
    const opaqueId = ownSession.getHeader().id;

    const other = registry.completeOAuthIdentity({
      provider: "google",
      subject: "history-owner",
      displayName: "History Owner",
    }).account;
    const foreignWorkspaceId = registry.listWorkspaces(other.id)[0]!.id;
    const response = await fetch(
      `${url}/api/web/workspaces/${foreignWorkspaceId}/history?sessionId=${encodeURIComponent(opaqueId)}`,
      { headers: { Cookie: cookies } },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Session not found",
    });
  });

  test("admits one active prompt and deduplicates retries", async () => {
    const workspaceId = registry.listWorkspaces(accountId)[0]!.id;
    const prompt = {
      text: "Explain this repository",
      clientRequestId: "client-active-1",
      mode: "prompt",
    };

    const first = await fetch(`${url}/api/web/workspaces/${workspaceId}/prompt`, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify(prompt),
    });
    expect(first.status).toBe(202);
    const accepted = (await first.json()) as {
      requestId: string;
      placement: string;
    };
    expect(accepted.placement).toBe("active");

    const retry = await fetch(`${url}/api/web/workspaces/${workspaceId}/prompt`, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify(prompt),
    });
    expect(retry.status).toBe(202);
    await expect(retry.json()).resolves.toMatchObject({
      requestId: accepted.requestId,
      placement: "active",
    });

    const competing = await fetch(`${url}/api/web/workspaces/${workspaceId}/prompt`, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ ...prompt, clientRequestId: "client-active-2" }),
    });
    expect(competing.status).toBe(409);
    expect(runtime.events).toHaveLength(1);
    expect(runtime.events[0]?.event.user).toBe(accountId);
    expect(runtime.events[0]?.context.message.userId).toBe(accountId);
  });

  test("queues follow-up and steer messages with exact queue correlation", async () => {
    const workspaceId = registry.listWorkspaces(accountId)[0]!.id;
    const active = await fetch(`${url}/api/web/workspaces/${workspaceId}/prompt`, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({
        text: "Start",
        clientRequestId: "queue-active",
        mode: "prompt",
      }),
    });
    expect(active.status).toBe(202);

    const followUp = await fetch(`${url}/api/web/workspaces/${workspaceId}/prompt`, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({
        text: "Then summarize",
        clientRequestId: "queue-follow-up",
        mode: "followUp",
      }),
    });
    expect(followUp.status).toBe(202);
    const followUpBody = (await followUp.json()) as { requestId: string };
    expect(runtime.queued[0]).toMatchObject({
      mode: "followUp",
      queueId: followUpBody.requestId,
    });
    expect(hub.snapshot(workspaceId).queue).toHaveLength(1);

    runtime.emit({
      type: "queued_message_start",
      queueId: followUpBody.requestId,
      mode: "followUp",
    });
    expect(hub.snapshot(workspaceId).queue).toEqual([]);

    const steer = await fetch(`${url}/api/web/workspaces/${workspaceId}/prompt`, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({
        text: "Focus on security",
        clientRequestId: "queue-steer",
        mode: "steer",
      }),
    });
    expect(steer.status).toBe(202);
    await expect(steer.json()).resolves.toMatchObject({
      placement: "steering",
    });
    expect(runtime.queued[1]?.mode).toBe("steer");
  });

  test("cancels only an owned running workspace", async () => {
    const workspaceId = registry.listWorkspaces(accountId)[0]!.id;
    await fetch(`${url}/api/web/workspaces/${workspaceId}/prompt`, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({
        text: "Run until cancelled",
        clientRequestId: "cancel-active",
        mode: "prompt",
      }),
    });

    const cancelled = await fetch(`${url}/api/web/workspaces/${workspaceId}/cancel`, {
      method: "POST",
      headers: mutationHeaders(),
      body: "{}",
    });
    expect(cancelled.status).toBe(202);
    await expect(cancelled.json()).resolves.toEqual({ status: "stopping" });
    expect(runtime.forceStopCalls).toBe(1);
    expect(hub.snapshot(workspaceId).run?.status).toBe("cancelling");

    const other = registry.completeOAuthIdentity({
      provider: "google",
      subject: "cancel-owner",
      displayName: "Other",
    }).account;
    const foreign = registry.listWorkspaces(other.id)[0]!;
    const denied = await fetch(`${url}/api/web/workspaces/${foreign.id}/cancel`, {
      method: "POST",
      headers: mutationHeaders(),
      body: "{}",
    });
    expect(denied.status).toBe(404);
    expect(runtime.forceStopCalls).toBe(1);
  });

  test("streams authorized bootstrap and keeps workspaces isolated", async () => {
    const workspaceId = registry.listWorkspaces(accountId)[0]!.id;
    hub.publish(workspaceId, {
      type: "queue.snapshot",
      items: [
        {
          requestId: "queued-request",
          clientRequestId: "queued-client",
          mode: "followUp",
          text: "Later",
        },
      ],
    });

    const controller = new AbortController();
    const response = await fetch(`${url}/api/web/workspaces/${workspaceId}/stream`, {
      headers: { Cookie: cookies },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const frames: Array<{ type: string; items?: unknown[] }> = [];
    const decoder = new TextDecoder();
    let buffered = "";
    while (frames.length < 6) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      const records = buffered.split("\n\n");
      buffered = records.pop() ?? "";
      for (const record of records) {
        const data = record.split("\n").find((line) => line.startsWith("data: "));
        if (data) frames.push(JSON.parse(data.slice(6)) as { type: string });
      }
    }
    expect(frames.map((frame) => frame.type)).toEqual([
      "stream.ready",
      "workspace.snapshot",
      "session.snapshot",
      "run.snapshot",
      "queue.snapshot",
      "subagents.snapshot",
    ]);
    expect(frames[4]?.items).toHaveLength(1);
    controller.abort();
    await reader.cancel().catch(() => {});

    const other = registry.completeOAuthIdentity({
      provider: "google",
      subject: "stream-owner",
      displayName: "Stream Owner",
    }).account;
    const foreign = registry.listWorkspaces(other.id)[0]!;
    const denied = await fetch(`${url}/api/web/workspaces/${foreign.id}/stream`, {
      headers: { Cookie: cookies },
    });
    expect(denied.status).toBe(404);
  });

  test("returns empty sessions and does not accept raw filenames as session ids", async () => {
    const workspaceId = registry.listWorkspaces(accountId)[0]!.id;
    const sessions = await fetch(`${url}/api/web/workspaces/${workspaceId}/sessions`, {
      headers: { Cookie: cookies },
    });
    expect(sessions.status).toBe(200);
    await expect(sessions.json()).resolves.toEqual({ sessions: [] });

    const history = await fetch(
      `${url}/api/web/workspaces/${workspaceId}/history?sessionId=${encodeURIComponent("current")}`,
      { headers: { Cookie: cookies } },
    );
    expect(history.status).toBe(404);
    await expect(history.json()).resolves.toEqual({
      error: "Session not found",
    });
  });
});
