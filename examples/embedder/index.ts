/**
 * Minimal mikan embedder: a stdin/stdout agent built from the public npm
 * surface (`@geminixiang/mikan`) only — no portal, no vault, no token stores.
 * Each stdin line becomes a ConversationEvent; agent output prints to stdout.
 */
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  createConversationRuntime,
  type ConversationContext,
  type ConversationEvent,
  type ConversationResponder,
  type ConversationRuntime,
  type MessagingBot,
  type MessagingInfo,
  type MikanModels,
} from "@geminixiang/mikan";

const CONVERSATION_ID = "embedder";

const platform: MessagingInfo = {
  name: "stdio",
  formattingGuide: "Reply in plain text.",
  channels: [{ id: CONVERSATION_ID, name: "stdio" }],
  users: [{ id: "local-user", userName: "local-user", displayName: "Local User" }],
};

export interface Embedder {
  runtime: ConversationRuntime;
  /** Run one line of input through the agent; resolves when the run ends. */
  handleLine(line: string): Promise<void>;
}

export function createEmbedder(options: {
  workingDir: string;
  models?: MikanModels;
  write?: (text: string) => void;
}): Embedder {
  const write = options.write ?? ((text: string) => process.stdout.write(`${text}\n`));
  const runtime = createConversationRuntime({
    workingDir: options.workingDir,
    sandbox: { type: "host" },
    models: options.models,
  });

  const bot: MessagingBot = {
    start: async () => {},
    postMessage: async (_conversationId, text) => {
      write(text);
      return `${Date.now()}`;
    },
    updateMessage: async (_conversationId, _ts, text) => write(text),
    enqueueEvent: () => false,
    getMessagingInfo: () => platform,
  };

  const responder: ConversationResponder = {
    respond: async (text) => write(text),
    replaceResponse: async (text) => write(text),
    respondDiagnostic: async (text) => write(`[diagnostic] ${text}`),
    respondToolResult: async (result) => write(`[tool] ${result.toolName}`),
    setTyping: async () => {},
    setWorking: async () => {},
    uploadFile: async (filePath) => write(`[file] ${filePath}`),
    deleteResponse: async () => {},
  };

  let messageCounter = 0;
  const handleLine = async (line: string): Promise<void> => {
    const ts = `${++messageCounter}`;
    const event: ConversationEvent = {
      type: "message",
      conversationId: CONVERSATION_ID,
      conversationKind: "direct",
      ts,
      user: "local-user",
      text: line,
      sessionKey: CONVERSATION_ID,
    };
    const context: ConversationContext = {
      message: {
        id: ts,
        sessionKey: CONVERSATION_ID,
        conversationKind: "direct",
        userId: "local-user",
        userName: "Local User",
        text: line,
      },
      responder,
      platform,
    };
    await runtime.handleEvent(event, bot, context);
  };

  return { runtime, handleLine };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const embedder = createEmbedder({ workingDir: process.cwd() });
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.trim()) void embedder.handleLine(line);
  });
  rl.on("close", () => void embedder.runtime.shutdown());
}
