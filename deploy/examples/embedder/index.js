import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  createConversationEvent,
  createConversationMessage,
  createConversationRuntime,
  createWorkspace,
} from "@geminixiang/mikan";
const CONVERSATION_ID = "embedder";
const PLATFORM = "slack";
const platform = {
  name: PLATFORM,
  formattingGuide: "Reply in plain text.",
  channels: [{ id: CONVERSATION_ID, name: "stdio" }],
  users: [{ id: "local-user", userName: "local-user", displayName: "Local User" }],
};
export function createEmbedder(options) {
  const write = options.write ?? ((text) => process.stdout.write(`${text}\n`));
  const runtime = createConversationRuntime({
    workspace: createWorkspace({
      root: options.workingDir,
      stateDir: options.stateDir ?? join(options.workingDir, "state"),
    }),
    sandbox: { type: "host" },
    models: options.models,
  });
  const bot = {
    start: async () => {},
    postMessage: async (_conversationId, text) => {
      write(text);
      return `${Date.now()}`;
    },
    updateMessage: async (_conversationId, _ts, text) => write(text),
    enqueueEvent: () => false,
    getMessagingInfo: () => platform,
  };
  const responder = {
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
  const handleLine = async (line) => {
    const ts = `${++messageCounter}`;
    const event = createConversationEvent({
      platform: PLATFORM,
      type: "message",
      conversationId: CONVERSATION_ID,
      conversationKind: "direct",
      ts,
      user: "local-user",
      text: line,
      sessionKey: CONVERSATION_ID,
    });
    const message = createConversationMessage({
      platform: PLATFORM,
      conversationId: CONVERSATION_ID,
      id: ts,
      sessionKey: CONVERSATION_ID,
      conversationKind: "direct",
      userId: "local-user",
      userName: "Local User",
      text: line,
    });
    const context = { address: event.address, message, responder, platform };
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
