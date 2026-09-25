import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { MikanAgentSession } from "../harness/session.js";
import { MikanModels } from "../harness/models.js";
import { SessionStore } from "../sessions/session-store.js";
import { ChatHistorySync } from "../sessions/chat-history-sync.js";
import { isCommandText } from "../adapters/commands/manifest.js";

test("the run after a busy tool receives and answers the queued token, not the previous prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mikan-slack-busy-regression-"));
  const store = await SessionStore.create(join(dir, "session.jsonl"), dir);
  try {
    const models = MikanModels.create({ modelsJsonPath: join(dir, "models.json") });
    const faux = fauxProvider();
    (models.models as MutableModels).setProvider(faux.provider);
    const busy = "QA_BUSY_1789148623670";
    const queued = "QA_QUEUED_1789148623670";
    const requested: string[] = [];
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("busy", {})),
      fauxAssistantMessage(busy),
      (context) => {
        const latest = context.messages.findLast((message) => message.role === "user");
        const text = JSON.stringify(latest);
        requested.push(text);
        return fauxAssistantMessage(text.includes(queued) ? queued : busy);
      },
    ]);
    const tool: AgentTool = {
      name: "busy",
      label: "busy",
      description: "Deterministic completed busy task",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
    };
    const session = new MikanAgentSession({
      systemPrompt: "Reply with the current user token.",
      model: faux.getModel() as Model<Api>,
      thinkingLevel: "off",
      tools: [tool],
      models,
      sessionStore: store,
    });
    const sync = new ChatHistorySync({ isCommandText });
    const entries = [
      {
        date: new Date().toISOString(),
        ts: "1000.1",
        user: "U1",
        text: `Use busy, then reply ${busy}`,
        isMessagingBot: false,
      },
      {
        date: new Date().toISOString(),
        ts: "1000.2",
        user: "U1",
        text: `Reply ${queued}`,
        isMessagingBot: false,
      },
    ];
    writeFileSync(
      join(dir, "log.jsonl"),
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    await sync.syncSessionManager({
      conversationDir: dir,
      sessionKey: "C1",
      sessionManager: store,
      currentMessageId: "1000.1",
    });
    await session.prompt(`Use busy, then reply ${busy}`);
    await sync.syncSessionManager({
      conversationDir: dir,
      sessionKey: "C1",
      sessionManager: store,
      currentMessageId: "1000.2",
    });
    await session.prompt(`Reply ${queued}`);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain(queued);
    expect(
      JSON.stringify(session.messages.findLast((message) => message.role === "assistant")),
    ).toContain(queued);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
