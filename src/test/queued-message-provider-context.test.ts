import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { Context, MutableModels } from "@earendil-works/pi-ai";
import { createGlobalSettingsFile } from "../settings/index.js";
import type {
  ConversationContext,
  ConversationEvent,
  ConversationResponder,
  MessagingBot,
  MessagingInfo,
} from "../types.js";
import { MikanModels } from "../harness/models.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import { createConversationRuntime } from "../runtime/conversation-runtime.js";
import type { SandboxConfig } from "../sandbox/types.js";

const BUSY_TEXT = "busy-queue e2e: run `sleep 10`, then reply with this token: QA_BUSY_TOKEN";
const QUEUED_TEXT = "queue test: reply with this token directly: QA_QUEUED_TOKEN";
const testAddress = createOfficeAddress("slack", "C123");

let workingDir: string;
let conversationDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  workingDir = join(
    tmpdir(),
    `mikan-queued-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const stateDir = join(workingDir, "state");
  mkdirSync(stateDir, { recursive: true });
  process.env.MIKAN_STATE_DIR = stateDir;
  createGlobalSettingsFile(stateDir);
  conversationDir = createWorkspace({ root: workingDir, stateDir }).office(testAddress).ensure();
});

afterEach(() => {
  delete process.env.MIKAN_STATE_DIR;
  if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
});

const testPlatform: MessagingInfo = {
  name: "slack",
  formattingGuide: "",
  channels: [],
  users: [],
  trustModel: "membership",
};

const bot = {
  postMessage: vi.fn().mockResolvedValue("TS"),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  getMessagingInfo: vi.fn().mockReturnValue(testPlatform),
} as unknown as MessagingBot;

function logMessage(entry: {
  ts: string;
  text: string;
  isMessagingBot: boolean;
  date: string;
}): void {
  appendFileSync(
    join(conversationDir, "log.jsonl"),
    `${JSON.stringify({ user: entry.isMessagingBot ? "bot" : "U1", userName: entry.isMessagingBot ? undefined : "alice", ...entry })}\n`,
    "utf-8",
  );
}

function makeResponder(onFinalResponse?: () => void): ConversationResponder {
  return {
    respond: vi.fn().mockResolvedValue(undefined),
    replaceResponse: vi.fn().mockImplementation(async () => onFinalResponse?.()),
    respondDiagnostic: vi.fn().mockResolvedValue(undefined),
    respondToolResult: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    setWorking: vi.fn().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue(undefined),
    deleteResponse: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEventAndContext(
  ts: string,
  text: string,
  responder: ConversationResponder,
): { event: ConversationEvent; context: ConversationContext } {
  const event: ConversationEvent = {
    address: testAddress,
    type: "message",
    conversationId: "C123",
    conversationKind: "shared",
    ts,
    user: "U1",
    text,
    sessionKey: "C123",
  };
  return {
    event,
    context: {
      address: testAddress,
      message: {
        address: testAddress,
        id: ts,
        sessionKey: "C123",
        conversationKind: "shared",
        userId: "U1",
        userName: "alice",
        text,
        attachments: [],
      },
      responder,
      platform: testPlatform,
    },
  };
}

function createFauxModels(): { models: MikanModels; faux: ReturnType<typeof fauxProvider> } {
  const stateDir = join(workingDir, "state");
  writeFileSync(
    join(stateDir, "settings.json"),
    JSON.stringify({
      llm: { provider: "faux", model: "faux-1", thinkingLevel: "off" },
      sandbox: { workspace: { doorPolicy: "trusted", layout: "full" } },
    }),
  );
  const models = MikanModels.create({ modelsJsonPath: join(stateDir, "models.json") });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  return { models, faux };
}

function userTextsOf(context: Context): string[] {
  return context.messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
    );
}

describe("queued message provider context", () => {
  test("the queued turn's last provider-facing user message is the queued one", async () => {
    const { models, faux } = createFauxModels();
    const workspace = createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") });
    const sandbox: SandboxConfig = { type: "host" };
    const runtime = createConversationRuntime({ workspace, sandbox, models });

    const captured: Context[] = [];
    let busyStarted = false;
    let releaseBusy!: () => void;
    const busyGate = new Promise<void>((resolve) => (releaseBusy = resolve));

    faux.setResponses([
      async (context) => {
        captured.push(structuredClone(context));
        busyStarted = true;
        await busyGate;
        return fauxAssistantMessage("QA_BUSY_TOKEN");
      },
      async (context) => {
        captured.push(structuredClone(context));
        return fauxAssistantMessage("QA_QUEUED_TOKEN");
      },
    ]);

    logMessage({
      ts: "1000.0003",
      text: BUSY_TEXT,
      isMessagingBot: false,
      date: "2026-05-01T00:00:02.000Z",
    });
    const busy = makeEventAndContext(
      "1000.0003",
      BUSY_TEXT,
      makeResponder(() =>
        logMessage({
          ts: "1000.0005",
          text: "QA_BUSY_TOKEN",
          isMessagingBot: true,
          date: "2026-05-01T00:00:12.000Z",
        }),
      ),
    );
    const busyRun = runtime.handleEvent(busy.event, bot, busy.context);
    await vi.waitFor(() => expect(busyStarted).toBe(true));

    logMessage({
      ts: "1000.0004",
      text: QUEUED_TEXT,
      isMessagingBot: false,
      date: "2026-05-01T00:00:03.000Z",
    });
    const queued = makeEventAndContext("1000.0004", QUEUED_TEXT, makeResponder());
    const queuedRun = runtime.handleEvent(queued.event, bot, queued.context);

    releaseBusy();
    await busyRun;
    await queuedRun;

    expect(captured).toHaveLength(2);
    const queuedTurnUserTexts = userTextsOf(captured[1]!);
    const lastUser = queuedTurnUserTexts.at(-1);
    expect(lastUser).toContain("QA_QUEUED_TOKEN");
    expect(lastUser).not.toContain("QA_BUSY_TOKEN");
    expect(queuedTurnUserTexts.filter((text) => text.includes(BUSY_TEXT))).toHaveLength(1);
  });
});
