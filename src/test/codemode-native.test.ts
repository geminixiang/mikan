import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { Api, Context, Model, MutableModels } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type } from "typebox";
import { MikanAgentSession } from "../harness/session.js";
import { MikanModels } from "../harness/models.js";
import { createSandboxTools } from "../harness/tools/pi-tools.js";
import { withSecretRedaction } from "../harness/tools/secret-redaction.js";
import type { MikanToolInput } from "../harness/types.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office } from "../office/types.js";
import { SessionStore } from "../sessions/session-store.js";

let dir: string;
let secretBefore: string | undefined;
const SECRET = "sk-codemode-sentinel-0123456789";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-codemode-native-"));
  secretBefore = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = SECRET;
});
afterEach(() => {
  if (secretBefore === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = secretBefore;
  rmSync(dir, { recursive: true, force: true });
});

const KEY = "C123:1.000001";

function setup() {
  const models = MikanModels.create({ modelsJsonPath: join(dir, "models.json") });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const office: Office = createWorkspace({
    root: join(dir, "workspace"),
    stateDir: join(dir, "state"),
  }).office(createOfficeAddress("slack", "C123"));
  const env = new NodeExecutionEnv({ cwd: dir });
  const wrap = (store: SessionStore, tools: MikanToolInput[]) =>
    new MikanAgentSession({
      model,
      models,
      sessionStore: store,
      tools,
      toolContext: { env: () => env },
      thinkingLevel: "off",
      systemPrompt: "prompt",
      settings: { compaction: { enabled: false } },
    });
  return { faux, office, wrap };
}

const script = (code: string) =>
  fauxAssistantMessage(fauxToolCall("codemode", { label: "Script", code }), {
    stopReason: "toolUse",
  });

const lastToolResult = (context: Context) =>
  JSON.stringify(context.messages.findLast((message) => message.role === "toolResult"));

test("a script interrupted by a restart continues without rerunning its finished calls", async () => {
  const env = setup();
  let lookups = 0;
  let release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  let restarted = false;
  const lookup: AgentTool = {
    name: "lookup",
    label: "lookup",
    description: "Looks something up",
    parameters: Type.Object({}),
    execute: async () => {
      lookups += 1;
      return { content: [{ type: "text", text: `looked up ${lookups}` }], details: undefined };
    },
  };
  const wait = {
    name: "wait",
    label: "wait",
    description: "Waits for an external job",
    parameters: Type.Object({}),
    replay: "safe" as const,
    execute: async (_id: string, _params: unknown, signal?: AbortSignal) => {
      if (restarted) return { content: [{ type: "text" as const, text: "job done" }], details: {} };
      release?.();
      await new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
      return { content: [{ type: "text" as const, text: "never" }], details: {} };
    },
  };
  const store = await SessionStore.open(env.office, KEY);
  env.faux.setResponses([script("text(await tools.lookup({})); text(await tools.wait({}));")]);
  const run = env
    .wrap(store, [lookup, wait])
    .prompt("go")
    .catch(() => undefined);
  await started;
  await store.close();
  await run;

  restarted = true;
  expect(await SessionStore.continueInterrupted(env.office)).toEqual([KEY]);
  const reopened = await SessionStore.open(env.office, KEY);
  let seen = "";
  env.faux.setResponses([
    (context) => {
      seen = lastToolResult(context);
      return fauxAssistantMessage("done");
    },
  ]);
  await env.wrap(reopened, [lookup, wait]).continueInterrupted();
  await reopened.close();

  expect(lookups).toBe(1);
  expect(seen).toContain("looked up 1");
  expect(seen).toContain("job done");
});

test("a script reads bash's exit code and output, with secrets redacted", async () => {
  const env = setup();
  const store = await SessionStore.open(env.office, KEY);
  let seen = "";
  env.faux.setResponses([
    script(
      'const run = await tools.bash({ command: "echo $OPENROUTER_API_KEY; exit 3" }); text(`exit ${run.exitCode}: ${run.output}`);',
    ),
    (context) => {
      seen = lastToolResult(context);
      return fauxAssistantMessage("done");
    },
  ]);
  await env.wrap(store, createSandboxTools().map(withSecretRedaction)).prompt("run it");
  await store.close();

  expect(seen).toContain("exit 3: [SECRET:OPENROUTER_API_KEY]");
  expect(seen).not.toContain(SECRET);
});

test("a script's successful nested call reports success to the run's progress", async () => {
  const env = setup();
  const lookup: AgentTool = {
    name: "lookup",
    label: "lookup",
    description: "Looks something up",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "found" }], details: undefined }),
  };
  const store = await SessionStore.open(env.office, KEY);
  env.faux.setResponses([script("text(await tools.lookup({}));"), fauxAssistantMessage("done")]);
  const session = env.wrap(store, [lookup]);
  const ends: Array<{ name: string; isError: boolean }> = [];
  session.subscribe((event) => {
    if (event.type === "tool_execution_end")
      ends.push({ name: event.toolName, isError: event.isError });
  });
  await session.prompt("look it up");
  await store.close();

  expect(ends).toEqual([
    { name: "lookup", isError: false },
    { name: "codemode", isError: false },
  ]);
});
