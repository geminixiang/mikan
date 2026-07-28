import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createOfficeAddress } from "../src/office-address.js";
import type { MessagingBot, ConversationResponder } from "../src/adapter.js";
import { MikanModels } from "../src/harness/index.js";
import { AdminCommandHandler } from "../src/commands/admin.js";
import { AutoReplyCommandHandler } from "../src/commands/auto-reply.js";
import { ExtensionsCommandHandler } from "../src/commands/extensions.js";
import { conversationSettingsPath, createGlobalSettingsFile } from "../src/config.js";
import { dispatchCommand } from "../src/commands/registry.js";
import { LoginCommandHandler, parseLoginCommand } from "../src/commands/login.js";
import { ModelCommandHandler } from "../src/commands/model.js";
import { NewCommandHandler } from "../src/commands/new.js";
import { SandboxCommandHandler } from "../src/commands/sandbox.js";
import { SessionViewCommandHandler } from "../src/commands/session-view.js";
import type { CommandContext, CommandHandler, CommandServices } from "../src/commands/types.js";
import { createManagedSessionFile, getChannelSessionDir } from "../src/sessions/store.js";
import type { SandboxConfig } from "../src/sandbox/index.js";
import type { VaultManager } from "../src/vault/index.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

interface RecordingResponseCtx extends ConversationResponder {
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

function fakeMessagingBot(overrides: Partial<MessagingBot> = {}): MessagingBot {
  return {
    start: vi.fn(async () => {}),
    postMessage: vi.fn(async () => "ts-1"),
    updateMessage: vi.fn(async () => {}),
    enqueueEvent: vi.fn(() => true),
    getMessagingInfo: vi.fn(() => ({
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
  bot?: MessagingBot;
  services?: Partial<CommandServices>;
  platform?: "slack" | "discord" | "telegram";
}

function buildContext(args: BuildContextArgs): CommandContext & {
  responder: RecordingResponseCtx;
} {
  const sandbox: SandboxConfig = { type: "host" };
  const responder = fakeResponseCtx();
  const services: CommandServices = {
    workingDir: "/tmp/no-such-working-dir",
    runtime: {
      forceStop: vi.fn(),
      getRunningSessions: vi.fn().mockReturnValue([]),
      handleEvent: vi.fn(),
      handleNewCommand: vi.fn(),
      handleStop: vi.fn(),
      isRunning: vi.fn().mockReturnValue(false),
      refreshConversationEnvironment: vi.fn().mockReturnValue(true),
      switchConversationModel: vi.fn().mockReturnValue(true),
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
    bot: args.bot ?? fakeMessagingBot(),
    responder,
    platform: args.platform ?? "slack",
    address: createOfficeAddress(args.platform ?? "slack", args.conversationId ?? "C123"),
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

// ── ModelCommandHandler ─────────────────────────────────────────────────────

describe("ModelCommandHandler", () => {
  const handler = new ModelCommandHandler(MikanModels.create());

  test("prefers a registered colon model ID before validating its suffix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mikan-model-command-test-"));
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    const modelsPath = join(dir, "models.json");
    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          provider: {
            api: "openai-completions",
            apiKey: "test",
            models: [{ id: "model:2026-01" }],
          },
        },
      }),
    );
    const previousStateDir = process.env.MIKAN_STATE_DIR;
    process.env.MIKAN_STATE_DIR = stateDir;

    try {
      const commandHandler = new ModelCommandHandler(
        MikanModels.create({
          authPath: join(dir, "auth.json"),
          modelsJsonPath: modelsPath,
        }),
      );
      const ctx = buildContext({
        commandText: "/model provider/model:2026-01",
        services: { workingDir: dir },
      });

      expect(await commandHandler.tryHandle(ctx)).toBe(true);
      expect(ctx.responder.responses[0]).toContain("Switched: `provider/model:2026-01`");
      expect(ctx.responder.responses[0]).not.toContain("未知的 thinking level");
      expect(ctx.services.runtime?.switchConversationModel).toHaveBeenCalledWith(
        "C123",
        "provider",
        "model:2026-01",
      );
    } finally {
      if (previousStateDir === undefined) delete process.env.MIKAN_STATE_DIR;
      else process.env.MIKAN_STATE_DIR = previousStateDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["/model foo", "無效的模型參數"],
    ["/model provider/", "無效的模型參數"],
    ["/model provider/model:unknown", "未知的 thinking level"],
    ["/model openai/gpt:bogus", "未知的 thinking level"],
  ])("rejects invalid model input: %s", async (commandText, expectedMessage) => {
    const ctx = buildContext({ commandText });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(ctx.responder.responses[0]).toContain(expectedMessage);
    expect(ctx.responder.responses[0]).not.toContain("Current:");
    expect(ctx.responder.responses[0]).not.toContain("Switched:");
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
    expect(ctx.responder.responses[0]).toContain("只能在 group/channel");
  });

  test("enables and disables auto-reply using mom-compatible marker files", async () => {
    const enableCtx = buildContext({
      commandText: "/pi-auto-reply on",
      services: { workingDir },
    });
    expect(await handler.tryHandle(enableCtx)).toBe(true);
    expect(enableCtx.responder.responses[0]).toContain("Auto-reply is enabled");
    expect(enableCtx.responder.responses[0]).toContain("Edit rules at:");

    const enabledPath = join(workingDir, "C123", "auto-reply");
    expect(readFileSync(enabledPath, "utf-8")).toBe("");

    writeFileSync(enabledPath, "Reply when someone asks about deployments.", "utf-8");

    const disableCtx = buildContext({
      commandText: "/pi-auto-reply off",
      services: { workingDir },
    });
    expect(await handler.tryHandle(disableCtx)).toBe(true);
    expect(disableCtx.responder.responses[0]).toContain("Auto-reply is disabled");
    expect(disableCtx.responder.responses[0]).toContain("Current rules:");
    expect(disableCtx.responder.responses[0]).toContain(
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
    expect(ctx.responder.responses[0]).toContain("Auto-reply is enabled");
    expect(ctx.responder.responses[0]).toContain("Current rules:");
    expect(ctx.responder.responses[0]).toContain("Reply when someone asks about deploys.");
  });

  test("rejects rule management to match mom-compatible slash command surface", async () => {
    const ctx = buildContext({
      commandText: "/pi-auto-reply rule Reply when someone asks about deployments.",
      services: { workingDir },
    });
    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(ctx.responder.responses[0]).toContain("/pi-auto-reply on|off|status");
    expect(existsSync(join(workingDir, "C123", "settings.json"))).toBe(false);
  });
});

// ── LoginCommandHandler ──────────────────────────────────────────────────────

describe("LoginCommandHandler", () => {
  const handler = new LoginCommandHandler();

  test("parses login commands only", () => {
    expect(parseLoginCommand("/login")).toEqual({ action: "setup" });
    expect(parseLoginCommand("login")).toBeNull();
    expect(parseLoginCommand("/login github_oauth")).toEqual({ action: "setup" });
    expect(parseLoginCommand("/pi-login github")).toEqual({ action: "setup" });
    expect(parseLoginCommand("/pi-login shared create gliaclaw")).toEqual({
      action: "shared_create",
      name: "gliaclaw",
    });
    expect(parseLoginCommand("/pi-login shared update gliaclaw")).toEqual({
      action: "shared_update",
      name: "gliaclaw",
    });
    expect(parseLoginCommand("/pi-login shared delete gliaclaw")).toEqual({
      action: "shared_delete",
      name: "gliaclaw",
    });
    expect(parseLoginCommand("/pi-login shared list")).toEqual({ action: "shared_list" });
    expect(parseLoginCommand("/pi-login copy gliaclaw")).toEqual({
      action: "copy_shared",
      name: "gliaclaw",
    });
    expect(parseLoginCommand("help")).toBeNull();
  });

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
    expect(ctx.responder.responses[0]).toContain("私訊");
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
    expect(ctx.responder.responses[0]).toContain("MIKAN_LINK_URL");
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
        vaultId: "u123-774767d55773",
        providerId: "",
      },
    ]);
    expect(ctx.responder.responses[0]).toContain("https://portal.example/link?token=tok-link");
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
    expect(ctx.responder.responses[0]).toContain("shared login profile (gliaclaw)");
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
    expect(listCtx.responder.responses[0]).toContain("gliaclaw");

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
    expect(vaultManager.copySharedVaultTo).toHaveBeenCalledWith("gliaclaw", "c123-588a5f4edc2e");
    expect(ctx.services.runtime?.refreshConversationEnvironment).toHaveBeenCalledWith("C123");
    expect(remove).toHaveBeenCalledWith("c123-588a5f4edc2e");
    expect(ctx.responder.responses[0]).toContain("Copied shared login profile `gliaclaw`");
    expect(ctx.responder.responses[0]).toContain("will be recreated with the copied env");
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
    expect(ctx.responder.responses[0]).toContain("currently running");
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
        vaultId: "c123-588a5f4edc2e",
        providerId: "",
      },
    ]);
    expect(entries.size).toBe(0);
  });
});

// ── SandboxCommandHandler ───────────────────────────────────────────────────

describe("ExtensionsCommandHandler", () => {
  const handler = new ExtensionsCommandHandler();
  let stateDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `cmd-ext-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(stateDir, { recursive: true });
    process.env.MIKAN_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("ignores unrelated commands", async () => {
    const ctx = buildContext({ commandText: "/pi-sandbox" });
    expect(await handler.tryHandle(ctx)).toBe(false);
  });

  test("reports when nothing is installed", async () => {
    const ctx = buildContext({ commandText: "/pi-extensions", conversationId: "C123" });
    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(ctx.responder.responses[0]).toContain("沒有安裝任何 extension");
    expect(ctx.responder.responses[0]).toContain(join(stateDir, "global", "extensions"));
  });

  test("warns about an index file at the scope root instead of listing it wrongly", async () => {
    const convDir = join(stateDir, "conversations", "C123", "extensions");
    mkdirSync(convDir, { recursive: true });
    // Mis-install: extension contents copied into the scope dir itself.
    writeFileSync(join(convDir, "index.mjs"), "export default function activate() {}\n");

    const ctx = buildContext({ commandText: "/pi-extensions", conversationId: "C123" });
    expect(await handler.tryHandle(ctx)).toBe(true);
    const text = ctx.responder.responses[0];
    expect(text).toContain("位於範圍根目錄");
    expect(text).toContain("具名子目錄");
  });

  test("lists global and conversation extensions with manifest metadata and skills", async () => {
    // global: directory form with manifest + a bundled skill
    const globalExt = join(stateDir, "global", "extensions", "agent-pm");
    mkdirSync(join(globalExt, "skills", "triage"), { recursive: true });
    writeFileSync(join(globalExt, "index.mjs"), "export default function activate() {}\n");
    writeFileSync(
      join(globalExt, "manifest.json"),
      JSON.stringify({ name: "agent-pm", version: "0.2.0", description: "follow-ups" }),
    );
    writeFileSync(
      join(globalExt, "skills", "triage", "SKILL.md"),
      "---\nname: triage\ndescription: d\n---\nbody\n",
    );
    // conversation-scoped: bare file form
    const convDir = join(stateDir, "conversations", "C123", "extensions");
    mkdirSync(convDir, { recursive: true });
    writeFileSync(join(convDir, "audit.mjs"), "export default function activate() {}\n");
    // side-effect canary: activation must NOT run during listing
    writeFileSync(
      join(convDir, "canary.mjs"),
      `import { writeFileSync } from "node:fs"; export default function activate() { writeFileSync(${JSON.stringify(join(stateDir, "activated"))}, "x"); }\n`,
    );

    const ctx = buildContext({ commandText: "/pi-extensions", conversationId: "C123" });
    expect(await handler.tryHandle(ctx)).toBe(true);
    const text = ctx.responder.responses[0];
    expect(text).toContain("*agent-pm*@0.2.0 — global");
    expect(text).toContain("follow-ups");
    expect(text).toContain("skills: triage");
    expect(text).toContain("*audit* — this conversation");
    expect(text).toContain("/pi-new");
    // discovery-only: the canary's activate must not have executed
    expect(existsSync(join(stateDir, "activated"))).toBe(false);
  });
});

describe("SandboxCommandHandler", () => {
  const handler = new SandboxCommandHandler();
  let workingDir: string;
  let sandboxStateDir: string;

  beforeEach(() => {
    workingDir = join(
      tmpdir(),
      `cmd-sandbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(workingDir, { recursive: true });
    // Conversation settings are host-authoritative under the state dir.
    sandboxStateDir = join(workingDir, "state");
    mkdirSync(sandboxStateDir, { recursive: true });
    process.env.MIKAN_STATE_DIR = sandboxStateDir;
    createGlobalSettingsFile(sandboxStateDir);
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    rmSync(workingDir, { recursive: true, force: true });
  });

  test("reports the current office policy", async () => {
    const ctx = buildContext({
      commandText: "/pi-sandbox",
      conversationId: "C123",
      services: {
        workingDir,
        sandbox: { type: "image", image: "ubuntu:24.04" },
        resourceController: {
          getLimitStatus: () => ({ limits: { cpus: "0.5", memory: "1g" }, boosted: false }),
          getDefaultLimits: () => ({ cpus: "0.5", memory: "1g" }),
          getBoostLimits: () => ({ cpus: "2", memory: "4g" }),
        } as any,
      },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(ctx.responder.responses[0]).toContain("Workspace policy: isolated");
    expect(ctx.responder.responses[0]).toContain("Workspace layout: conversation");
  });

  test.each(["private", "full"])("does not expose %s door mutation through chat", async (mode) => {
    const ctx = buildContext({
      commandText: `/pi-sandbox ${mode}`,
      conversationId: "C123",
      services: {
        workingDir,
        sandbox: { type: "image", image: "ubuntu:24.04" },
        resourceController: {
          getLimitStatus: () => ({ limits: undefined, boosted: false }),
          getDefaultLimits: () => undefined,
          getBoostLimits: () => undefined,
        } as any,
      },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(existsSync(conversationSettingsPath(join(workingDir, "C123")))).toBe(true);
    expect(
      JSON.parse(readFileSync(conversationSettingsPath(join(workingDir, "C123")), "utf-8")),
    ).toEqual({});
    expect(ctx.responder.responses[0]).toContain("Workspace policy: isolated");
  });

  test("boosts a Gondolin conversation", async () => {
    const boost = vi.fn().mockResolvedValue({
      limits: { cpus: "2", memory: "4g" },
      boosted: true,
    });
    const ctx = buildContext({
      commandText: "/pi-sandbox boost",
      conversationId: "C123",
      services: {
        workingDir,
        sandbox: { type: "gondolin", profile: "default" },
        resourceController: {
          boost,
          getBoostLimits: () => ({ cpus: "2", memory: "4g" }),
        } as any,
      },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(boost).toHaveBeenCalledWith("c123-588a5f4edc2e");
    expect(ctx.responder.responses[0]).toContain("CPU 2 / Memory 4g");
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
    const bot = fakeMessagingBot({ postPrivate });
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
    const bot = fakeMessagingBot();
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
    expect(ctx.responder.responses[0]).toContain("私訊");
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
    expect(ctx.responder.responses[0]).toContain("還沒有可查看的 session");
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
    expect(ctx.responder.responses[0]).toContain("https://portal.example/session?token=tok-sv");
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
    expect(ctx.responder.responses[0]).toContain("只能在與機器人的私訊");
    expect(ctx.services.runtime.handleNewCommand).not.toHaveBeenCalled();
  });

  test("resets the active private session", async () => {
    const ctx = buildContext({
      commandText: "/new",
      privateConversation: true,
      conversationId: "D123",
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(ctx.services.runtime.handleNewCommand).toHaveBeenCalledWith(
      "D123",
      "D123",
      ctx.bot,
      expect.objectContaining({ sessionKey: "D123", userId: "U123" }),
      ctx.responder,
      expect.objectContaining({ name: "slack" }),
    );
  });
});
