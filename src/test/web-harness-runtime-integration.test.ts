import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HarnessEventEnvelope,
  HarnessPrincipal,
} from "@geminixiang/mikan-harness-web-contract";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MikanModels } from "../harness/index.js";
import { createWorkspace } from "../office/index.js";
import { createConversationRuntime } from "../runtime/conversation-runtime.js";
import { MikanHarnessHost } from "../web/harness/host.js";

const principal: HarnessPrincipal = { id: "github:303", displayName: "web-user" };
let root: string;
let stateDir: string;

beforeEach(() => {
  root = join(tmpdir(), `mikan-web-runtime-${Date.now()}-${Math.random()}`);
  stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  process.env.MIKAN_STATE_DIR = stateDir;
  writeFileSync(
    join(stateDir, "settings.json"),
    JSON.stringify({
      llm: { provider: "faux", model: "faux-1", thinkingLevel: "off" },
      sandbox: { workspace: { doorPolicy: "trusted", layout: "full" } },
    }),
  );
});

afterEach(() => {
  delete process.env.MIKAN_STATE_DIR;
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("Harness Web Host with ConversationRuntime", () => {
  test("streams and persists one real Harness turn through the shared runtime", async () => {
    const authPath = join(stateDir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ faux: { type: "api_key", key: "test-key" } }));
    const models = MikanModels.create({
      authPath,
      modelsJsonPath: join(stateDir, "models.json"),
    });
    const faux = fauxProvider();
    (models.models as MutableModels).setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("Hello from the Web Harness")]);

    const workspace = createWorkspace({ root: join(root, "workspace"), stateDir });
    const runtime = createConversationRuntime({
      workspace,
      sandbox: { type: "host" },
      models,
    });
    const host = new MikanHarnessHost({ workspace, runtime, models, stateDir });
    const created = await host.execute(principal, {
      kind: "create-conversation",
      commandId: "create",
    });
    if (created.kind !== "conversation-created") throw new Error("Conversation was not created");

    const bootstrap = await host.bootstrap(principal, created.conversation.officeKey);
    const events: HarnessEventEnvelope[] = [];
    const subscription = host.subscribe(principal, bootstrap.cursor, (event) => events.push(event));
    await host.execute(principal, {
      kind: "prompt",
      commandId: "prompt",
      officeKey: created.conversation.officeKey,
      sessionId: created.conversation.sessionId,
      text: "/admin",
    });

    await vi.waitFor(
      () => expect(events.some((entry) => entry.event.kind === "run.finished")).toBe(true),
      { timeout: 10_000 },
    );
    const settled = await host.bootstrap(principal, created.conversation.officeKey);
    expect(settled.conversation?.run).toBeUndefined();
    expect(settled.conversation?.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text: "/admin" }),
        expect.objectContaining({ role: "assistant", text: "Hello from the Web Harness" }),
      ]),
    );
    expect(events.map((entry) => entry.event.kind)).toContain("response.finished");

    if (subscription.kind === "subscribed") subscription.dispose();
    await runtime.shutdown();
  });
});
