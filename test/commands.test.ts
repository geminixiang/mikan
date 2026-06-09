import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Bot, ChatResponseContext } from "../packages/mikan/src/adapter.js";
import { AdminCommandHandler } from "../packages/mikan/src/commands/admin.js";
import { AutoReplyCommandHandler } from "../packages/mikan/src/commands/auto-reply.js";
import { dispatchCommand } from "../packages/mikan/src/commands/registry.js";
import { LoginCommandHandler } from "../packages/mikan/src/commands/login.js";
import { NewCommandHandler } from "../packages/mikan/src/commands/new.js";
import { SandboxCommandHandler } from "../packages/mikan/src/commands/sandbox.js";
import { SessionViewCommandHandler } from "../packages/mikan/src/commands/session-view.js";
import type { CommandContext, CommandHandler, CommandServices } from "../packages/mikan/src/commands/types.js";
import { createManagedSessionFile, getChannelSessionDir } from "../packages/mikan/src/sessions/store.js";
import type { SandboxConfig } from "../packages/mikan/src/sandbox/index.js";
import type { VaultManager } from "../packages/mikan/src/vault/index.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

interface RecordingResponseCtx extends ChatResponseContext {
  responses: string[];
}

function fakeResponseCtx(): RecordingResponseCtx {
  const responses: string[] = [];
  return {
    responses,
    respond: vi.fn(async (text: string) => {
      responses.push(text);
    }),
    replaceResponse: vi.fn(async () => {}),
    respondDiagnostic: vi.fn(async (text: string) => {
      responses.push(text);
    }),
    respondToolResult: vi.fn(async () => {}),
    setTyping: vi.fn(async () => {}),
    setWorking: vi.fn(async () => {}),
    uploadFile: vi.fn(async () => {}),
    deleteResponse: vi.fn(async () => {}),
  } as RecordingResponseCtx;
}

function fakeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    start: vi.fn(async () => {}),
    postMessage: vi.fn(async () => "ts-1"),
    updateMessage: vi.fn(async () => {}),
    enqueueEvent: vi.fn(() => true),
    getPlatformInfo: vi.fn(() => ({
      name: "slack",
      formattingGuide: "",
      channels: [],
      users: [],
    })),
    ...overrides,
  };
}

function fakeVaultManager(): VaultManager & { entries: Set<string> } {
  const entries = new Set<string>();
  return {
    entries,
    hasEntry: (key) => entries.has(key),
    resolve: () => undefined,
    getSandboxConfig: (_uid, base) => base,
    list: () => [],
    isEnabled: () => true,
    upsertEnv: (key) => {
      entries.add(key);
    },
    upsertFile: (key) => {
      entries.add(key);
    },
    listSharedVaults: () => [],
    deleteSharedVault: () => false,
    copySharedVaultTo: () => ({ filesCopied: 0, envKeysCopied: 0 }),
  };
}

interface RecordedLinkToken {
  platform: string;
  platformUserId: string;
  conversationId: string;
  vaultId: string;
  providerId: string;
}

function fakeLinkTokenStore() {
  const created: RecordedLinkToken[] = [];
  return {
    created,
    create(
      platform: "slack" | "discord" | "telegram",
      platformUserId: string,
      conversationId: string,
      vaultId: string,
      providerId: string,
    ) {
      created.push({ platform, platformUserId, conversationId, vaultId, providerId });
      return { token: "tok-link" };
    },
  };
}

function fakeSessionViewTokenStore() {
  const created: { sessionFile: string }[] = [];
  return {
    created,
    create(
      _platform: "slack" | "discord" | "telegram",
      _userId: string,
      _conversationId: string,
      _sessionKey: string,
      sessionFile: string,
    ) {
      created.push({ sessionFile });
      return { token: "tok-sv" };
    },
  };
}

interface BuildContextArgs {
  commandText: string;
  privateConversation?: boolean;
  conversationId?: string;
  vaultConversationId?: string;
  bot?: Bot;
  services?: Partial<CommandServices>;
  platform?: "slack" | "discord" | "telegram";
}

function buildContext(args: BuildContextArgs): CommandContext & {
  responseCtx: RecordingResponseCtx;
} {
  const sandbox: SandboxConfig = { type: "host" };
  const responseCtx = fakeResponseCtx();
  const services: CommandServices = {
    workingDir: "/tmp/no-such-working-dir",
    runtime: {
      createSessionSandbox: vi.fn(),
      forceStop: vi.fn(),
      getRunningSessions: vi.fn().mockReturnValue([]),
      handleEvent: vi.fn(),
      handleNewCommand: vi.fn(),
      handleStop: vi.fn(),
      isRunning: vi.fn().mockReturnValue(false),
      refreshConversationEnvironment: vi.fn().mockReturnValue(true),
      runSession: vi.fn(),
      shutdown: vi.fn(),
    } as any,
    sandbox,
    vaultManager: fakeVaultManager(),
    linkTokenStore: fakeLinkTokenStore(),
    sessionViewTokenStore: fakeSessionViewTokenStore(),
    adminTokenStore: { create: () => ({ token: "tok-admin" }) },
    portalBaseUrl: "https://portal.example",
    ...args.services,
  };
  return {
    bot: args.bot ?? fakeBot(),
    responseCtx,
    platform: args.platform ?? "slack",
    platformUserId: "U123",
    conversationId: args.conversationId ?? "C123",
    vaultConversationId: args.vaultConversationId,
    sessionKey: args.conversationId ?? "C123",
    commandText: args.commandText,
    privateConversation: args.privateConversation ?? false,
    services,
  };
}

describe("dispatchCommand", () => {
  test("returns false when no handler accepts the command", async () => {
    const a: CommandHandler = { tryHandle: vi.fn(async () => false) };
    const b: CommandHandler = { tryHandle: vi.fn(async () => false) };
    const ctx = buildContext({ commandText: "hello" });

    const handled = await dispatchCommand([a, b], ctx);

    expect(handled).toBe(false);
    expect(a.tryHandle).toHaveBeenCalledOnce();
    expect(b.tryHandle).toHaveBeenCalledOnce();
  });

  test("short-circuits on the first handler that accepts", async () => {
    const a: CommandHandler = { tryHandle: vi.fn(async () => true) };
    const b: CommandHandler = { tryHandle: vi.fn(async () => true) };
    const ctx = buildContext({ commandText: "/login" });

    const handled = await dispatchCommand([a, b], ctx);

    expect(handled).toBe(true);
    expect(a.tryHandle).toHaveBeenCalledOnce();
    expect(b.tryHandle).not.toHaveBeenCalled();
  });

  test("falls through to the next handler when the first declines", async () => {
    const a: CommandHandler = { tryHandle: vi.fn(async () => false) };
    const b: CommandHandler = { tryHandle: vi.fn(async () => true) };
    const ctx = buildContext({ commandText: "/session" });

    const handled = await dispatchCommand([a, b], ctx);

    expect(handled).toBe(true);
    expect(a.tryHandle).toHaveBeenCalledOnce();
    expect(b.tryHandle).toHaveBeenCalledOnce();
  });
});

// ── AdminCommandHandler ─────────────────────────────────────────────────────

describe("AdminCommandHandler", () => {
  const handler = new AdminCommandHandler();

  test("requires slash form", async () => {
    const ctx = buildContext({ commandText: "admin" });
    expect(await handler.tryHandle(ctx)).toBe(false);
  });
});

// ── AutoReplyCommandHandler ─────────────────────────────────────────────────

describe("AutoReplyCommandHandler", () => {
  const handler = new AutoReplyCommandHandler();
  let workingDir: string;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-auto-reply-test-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  test("declines unrelated commands and bare forms", async () => {
    const ctx = buildContext({ commandText: "hello", services: { workingDir } });
    expect(await handler.tryHandle(ctx)).toBe(false);

    const bareCtx = buildContext({ commandText: "auto-reply on", services: { workingDir } });
    expect(await handler.tryHandle(bareCtx)).toBe(false);
  });

  test("rejects private conversations", async () => {
    const ctx = buildContext({
      commandText: "/pi-auto-reply on",
      privateConversation: true,
      services: { workingDir },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(ctx.responseCtx.responses[0]).toContain("只能在 group/channel");
  });

  test("enables and disables auto-reply using mom-compatible marker files", async () => {
    const enableCtx = buildContext({
      commandText: "/pi-auto-reply on",
      services: { workingDir },
    });
    expect(await handler.tryHandle(enableCtx)).toBe(true);
    expect(enableCtx.responseCtx.responses[0]).toContain("Auto-reply is enabled");
    expect(enableCtx.responseCtx.responses[0]).toContain("Edit rules at:");

    const enabledPath = join(workingDir, "C123", "auto-reply");
    expect(readFileSync(enabledPath, "utf-8")).toBe("");

    writeFileSync(enabledPath, "Reply when someone asks about deployments.", "utf-8");

    const disableCtx = buildContext({
      commandText: "/pi-auto-reply off",
      services: { workingDir },
    });
    expect(await handler.tryHandle(disableCtx)).toBe(true);
    expect(disableCtx.responseCtx.responses[0]).toContain("Auto-reply is disabled");
    expect(disableCtx.responseCtx.responses[0]).toContain("Current rules:");
    expect(disableCtx.responseCtx.responses[0]).toContain(
      "Reply when someone asks about deployments.",
    );
    expect(existsSync(enabledPath)).toBe(false);
    expect(readFileSync(join(workingDir, "C123", "auto-reply.disabled"), "utf-8")).toBe(
      "Reply when someone asks about deployments.",
    );
  });

  test("shows auto-reply file contents in status", async () => {
    const conversationDir = join(workingDir, "C123");
    mkdirSync(conversationDir, { recursive: true });
    writeFileSync(
      join(conversationDir, "auto-reply"),
      "Reply when someone asks about deploys.",
      "utf-8",
    );

    const ctx = buildContext({
      commandText: "/pi-auto-reply status",
      services: { workingDir },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(ctx.responseCtx.responses[0]).toContain("Auto-reply is enabled");
    expect(ctx.responseCtx.responses[0]).toContain("Current rules:");
    expect(ctx.responseCtx.responses[0]).toContain("Reply when someone asks about deploys.");
  });

  test("rejects rule management to match mom-compatible slash command surface", async () => {
    const ctx = buildContext({
      commandText: "/pi-auto-reply rule Reply when someone asks about deployments.",
      services: { workingDir },
    });
    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(ctx.responseCtx.responses[0]).toContain("/pi-auto-reply on|off|status");
    expect(existsSync(join(workingDir, "C123", "settings.json"))).toBe(false);
  });
});

// ── LoginCommandHandler ──────────────────────────────────────────────────────

describe("LoginCommandHandler", () => {
  const handler = new LoginCommandHandler();

  test("declines unrelated commands", async () => {
    const ctx = buildContext({ commandText: "hello" });
    expect(await handler.tryHandle(ctx)).toBe(false);
  });

  test("rejects in non-private conversations without creating a token", async () => {
    const linkTokenStore = fakeLinkTokenStore();
    const ctx = buildContext({
      commandText: "/login",
      privateConversation: false,
      services: { linkTokenStore },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(linkTokenStore.created).toHaveLength(0);
    expect(ctx.responseCtx.responses[0]).toContain("私訊");
  });

  test("reports missing portalBaseUrl", async () => {
    const linkTokenStore = fakeLinkTokenStore();
    const ctx = buildContext({
      commandText: "/login",
      privateConversation: true,
      services: { linkTokenStore, portalBaseUrl: undefined },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(linkTokenStore.created).toHaveLength(0);
    expect(ctx.responseCtx.responses[0]).toContain("MIKAN_LINK_URL");
  });

  test("creates a link token and replies with the portal URL", async () => {
    const linkTokenStore = fakeLinkTokenStore();
    const ctx = buildContext({
      commandText: "/login",
      privateConversation: true,
      services: { linkTokenStore },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(linkTokenStore.created).toEqual([
      {
        platform: "slack",
        platformUserId: "U123",
        conversationId: "C123",
        vaultId: "U123",
        providerId: "",
      },
    ]);
    expect(ctx.responseCtx.responses[0]).toContain("https://portal.example/link?token=tok-link");
  });

  test("creates a link token for shared profile setup", async () => {
    const linkTokenStore = fakeLinkTokenStore();
    const ctx = buildContext({
      commandText: "/pi-login shared create gliaclaw",
      privateConversation: true,
      services: { linkTokenStore },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(linkTokenStore.created).toEqual([
      {
        platform: "slack",
        platformUserId: "U123",
        conversationId: "C123",
        vaultId: "shared/gliaclaw",
        providerId: "",
      },
    ]);
    expect(ctx.responseCtx.responses[0]).toContain("shared login profile (gliaclaw)");
  });

  test("lists and deletes shared login profiles", async () => {
    const vaultManager = fakeVaultManager();
    vaultManager.listSharedVaults = vi.fn(() => ["gliaclaw"]);
    vaultManager.deleteSharedVault = vi.fn(() => true);

    const listCtx = buildContext({
      commandText: "/pi-login shared list",
      privateConversation: true,
      services: { vaultManager },
    });
    expect(await handler.tryHandle(listCtx)).toBe(true);
    expect(listCtx.responseCtx.responses[0]).toContain("gliaclaw");

    const deleteCtx = buildContext({
      commandText: "/pi-login shared delete gliaclaw",
      privateConversation: true,
      services: { vaultManager },
    });
    expect(await handler.tryHandle(deleteCtx)).toBe(true);
    expect(vaultManager.deleteSharedVault).toHaveBeenCalledWith("gliaclaw");
  });

  test("copies shared login profile into the conversation vault", async () => {
    const vaultManager = fakeVaultManager();
    vaultManager.copySharedVaultTo = vi.fn(() => ({ envKeysCopied: 2, filesCopied: 1 }));
    const remove = vi.fn(async () => {});
    const ctx = buildContext({
      commandText: "/pi-login copy gliaclaw",
      privateConversation: true,
      services: {
        vaultManager,
        provisioner: { remove } as any,
        sandbox: { type: "image", image: "ubuntu:24.04" },
      },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(vaultManager.copySharedVaultTo).toHaveBeenCalledWith("gliaclaw", "c123");
    expect(ctx.services.runtime?.refreshConversationEnvironment).toHaveBeenCalledWith("C123");
    expect(remove).toHaveBeenCalledWith("c123");
    expect(ctx.responseCtx.responses[0]).toContain("Copied shared login profile `gliaclaw`");
    expect(ctx.responseCtx.responses[0]).toContain("will be recreated with the copied env");
  });

  test("does not restart an image sandbox while the target conversation is running", async () => {
    const vaultManager = fakeVaultManager();
    vaultManager.copySharedVaultTo = vi.fn(() => ({ envKeysCopied: 2, filesCopied: 1 }));
    const remove = vi.fn(async () => {});
    const ctx = buildContext({
      commandText: "/pi-login copy gliaclaw",
      privateConversation: true,
      services: {
        vaultManager,
        provisioner: { remove } as any,
        runtime: {
          createSessionSandbox: vi.fn(),
          forceStop: vi.fn(),
          getRunningSessions: vi.fn().mockReturnValue([{ sessionKey: "C123:thread-1" }]),
          handleEvent: vi.fn(),
          handleNewCommand: vi.fn(),
          handleStop: vi.fn(),
          isRunning: vi.fn().mockReturnValue(true),
          refreshConversationEnvironment: vi.fn().mockReturnValue(false),
          runSession: vi.fn(),
          shutdown: vi.fn(),
          switchConversationModel: vi.fn(),
        } as any,
        sandbox: { type: "image", image: "ubuntu:24.04" },
      },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    expect(ctx.services.runtime?.refreshConversationEnvironment).toHaveBeenCalledWith("C123");
    expect(ctx.responseCtx.responses[0]).toContain("currently running");
  });

  test("uses vaultConversationId for vault routing when reply channel differs", async () => {
    const linkTokenStore = fakeLinkTokenStore();
    const entries = new Set<string>();
    const ctx = buildContext({
      commandText: "/login",
      privateConversation: true,
      conversationId: "D123",
      vaultConversationId: "C123",
      services: {
        linkTokenStore,
        sandbox: { type: "image", image: "ubuntu:24.04" },
        vaultManager: {
          entries,
          hasEntry: (key: string) => entries.has(key),
          resolve: () => undefined,
          getSandboxConfig: (_uid: string, base: SandboxConfig) => base,
          list: () => [],
          isEnabled: () => true,
          upsertEnv: (key: string) => {
            entries.add(key);
          },
          upsertFile: (key: string) => {
            entries.add(key);
          },
          listSharedVaults: () => [],
          deleteSharedVault: () => false,
          copySharedVaultTo: () => ({ filesCopied: 0, envKeysCopied: 0 }),
        } as VaultManager,
      },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(linkTokenStore.created).toEqual([
      {
        platform: "slack",
        platformUserId: "U123",
        conversationId: "D123",
        vaultId: "c123",
        providerId: "",
      },
    ]);
    expect(entries.size).toBe(0);
  });
});

// ── SandboxCommandHandler ───────────────────────────────────────────────────

describe("SandboxCommandHandler", () => {
  const handler = new SandboxCommandHandler();
  let workingDir: string;

  beforeEach(() => {
    workingDir = join(
      tmpdir(),
      `cmd-sandbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  test("reports current workspace mount mode", async () => {
    const ctx = buildContext({
      commandText: "/pi-sandbox",
      conversationId: "C123",
      services: {
        workingDir,
        sandbox: { type: "image", image: "ubuntu:24.04" },
        provisioner: {
          getLimitStatus: () => ({ limits: { cpus: "0.5", memory: "1g" }, boosted: false }),
          getDefaultLimits: () => ({ cpus: "0.5", memory: "1g" }),
          getBoostLimits: () => ({ cpus: "2", memory: "4g" }),
        } as any,
      },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(ctx.responseCtx.responses[0]).toContain("Workspace mount: private");
  });

  test("switches a conversation to full workspace mode", async () => {
    const ctx = buildContext({
      commandText: "/pi-sandbox full",
      conversationId: "C123",
      services: {
        workingDir,
        sandbox: { type: "image", image: "ubuntu:24.04" },
        provisioner: {
          getLimitStatus: () => ({ limits: undefined, boosted: false }),
          getDefaultLimits: () => undefined,
          getBoostLimits: () => undefined,
        } as any,
      },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    const sandboxConfig = JSON.parse(
      readFileSync(join(workingDir, "C123", "settings.json"), "utf-8"),
    ) as { sandbox: { image: { workspaceMount: string } } };
    expect(sandboxConfig.sandbox.image.workspaceMount).toBe("full");
    expect(ctx.responseCtx.responses[0]).toContain("Workspace mount: full");
  });

  test("switches a conversation back to private workspace mode", async () => {
    mkdirSync(join(workingDir, "C123"), { recursive: true });
    const ctx = buildContext({
      commandText: "/pi-sandbox private",
      conversationId: "C123",
      services: {
        workingDir,
        sandbox: { type: "image", image: "ubuntu:24.04" },
        provisioner: {
          getLimitStatus: () => ({ limits: undefined, boosted: false }),
          getDefaultLimits: () => undefined,
          getBoostLimits: () => undefined,
        } as any,
      },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    const sandboxConfig = JSON.parse(
      readFileSync(join(workingDir, "C123", "settings.json"), "utf-8"),
    ) as { sandbox: { image: { workspaceMount: string } } };
    expect(sandboxConfig.sandbox.image.workspaceMount).toBe("private");
    expect(ctx.responseCtx.responses[0]).toContain("Workspace mount: private");
  });
});

// ── SessionViewCommandHandler ────────────────────────────────────────────────

describe("SessionViewCommandHandler", () => {
  const handler = new SessionViewCommandHandler();
  let workingDir: string;

  beforeEach(() => {
    workingDir = join(
      tmpdir(),
      `cmd-session-view-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  test("declines unrelated commands", async () => {
    const ctx = buildContext({ commandText: "hello" });
    expect(await handler.tryHandle(ctx)).toBe(false);
  });

  test("uses bot.postPrivate for shared conversations when available", async () => {
    const conversationId = "C123";
    const conversationDir = join(workingDir, conversationId);
    mkdirSync(conversationDir, { recursive: true });
    createManagedSessionFile(getChannelSessionDir(conversationDir), conversationDir);

    const postPrivate = vi.fn(async () => {});
    const bot = fakeBot({ postPrivate });
    const sessionViewTokenStore = fakeSessionViewTokenStore();
    const ctx = buildContext({
      commandText: "/session",
      privateConversation: false,
      bot,
      services: { workingDir, sessionViewTokenStore },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(postPrivate).toHaveBeenCalledOnce();
    expect(postPrivate.mock.calls[0][0]).toBe("C123");
    expect(postPrivate.mock.calls[0][1]).toBe("U123");
    expect(postPrivate.mock.calls[0][2]).toContain("/session?token=tok-sv");
    expect(sessionViewTokenStore.created).toHaveLength(1);
  });

  test("rejects shared conversations on platforms without postPrivate", async () => {
    const bot = fakeBot();
    delete (bot as { postPrivate?: unknown }).postPrivate;
    const sessionViewTokenStore = fakeSessionViewTokenStore();
    const ctx = buildContext({
      commandText: "/session",
      privateConversation: false,
      bot,
      services: { workingDir, sessionViewTokenStore },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(sessionViewTokenStore.created).toHaveLength(0);
    expect(ctx.responseCtx.responses[0]).toContain("私訊");
  });

  test("reports missing session file", async () => {
    const sessionViewTokenStore = fakeSessionViewTokenStore();
    const ctx = buildContext({
      commandText: "/session",
      privateConversation: true,
      services: { workingDir, sessionViewTokenStore },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(sessionViewTokenStore.created).toHaveLength(0);
    expect(ctx.responseCtx.responses[0]).toContain("還沒有可查看的 session");
  });

  test("creates a token and replies with the portal URL in private conversations", async () => {
    const conversationId = "C123";
    const conversationDir = join(workingDir, conversationId);
    mkdirSync(conversationDir, { recursive: true });
    const expectedFile = createManagedSessionFile(
      getChannelSessionDir(conversationDir),
      conversationDir,
    );

    const sessionViewTokenStore = fakeSessionViewTokenStore();
    const ctx = buildContext({
      commandText: "/session",
      privateConversation: true,
      services: { workingDir, sessionViewTokenStore },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(sessionViewTokenStore.created).toEqual([{ sessionFile: expectedFile }]);
    expect(ctx.responseCtx.responses[0]).toContain("https://portal.example/session?token=tok-sv");
  });
});

describe("NewCommandHandler", () => {
  const handler = new NewCommandHandler();

  test("declines unrelated commands and bare forms", async () => {
    const ctx = buildContext({ commandText: "hello" });
    expect(await handler.tryHandle(ctx)).toBe(false);

    const bareCtx = buildContext({ commandText: "new", privateConversation: true });
    expect(await handler.tryHandle(bareCtx)).toBe(false);
  });

  test("rejects shared conversations", async () => {
    const ctx = buildContext({
      commandText: "/new",
      privateConversation: false,
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(ctx.responseCtx.responses[0]).toContain("只能在與機器人的私訊");
    expect(ctx.services.runtime.handleNewCommand).not.toHaveBeenCalled();
  });

  test("resets the active private session", async () => {
    const ctx = buildContext({
      commandText: "/new",
      privateConversation: true,
      conversationId: "D123",
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(ctx.services.runtime.handleNewCommand).toHaveBeenCalledWith("D123", "D123", ctx.bot);
  });
});
