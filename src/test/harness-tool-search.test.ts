import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TODO_CONTEXT, getOrThrow, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { MikanAgentSession } from "../harness/session.js";
import { MikanModels } from "../harness/models.js";
import { adaptAgentTool } from "../harness/tools/pi-tools.js";
import type { MikanToolInput } from "../harness/types.js";
import { SessionStore } from "../sessions/session-store.js";

let dir: string;
const stores: SessionStore[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-tool-search-"));
});
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const models = MikanModels.create({ modelsJsonPath: join(dir, "models.json") });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  const file = join(dir, "session.jsonl");
  const wrap = (store: SessionStore, tools: MikanToolInput[] = []) => {
    stores.push(store);
    return new MikanAgentSession({
      model: faux.getModel() as Model<Api>,
      models,
      sessionStore: store,
      tools,
      thinkingLevel: "off",
      systemPrompt: "Test prompt",
      settings: { compaction: { enabled: false } },
    });
  };
  return { faux, file, wrap, models, model: faux.getModel() as Model<Api> };
}

function deferredTool(name: string, description: string) {
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "result-sentinel" }],
    details: {},
  }));
  const tool: AgentTool = Object.assign(
    {
      name,
      label: name,
      description,
      parameters: { type: "object", properties: {} },
      execute,
    },
    { exposure: "deferred" as const, namespace: name.split("__")[1] },
  );
  return { tool, execute };
}

test("tool_search declares only matching MCP tools on the next model call", async () => {
  const { faux, file, wrap } = setup();
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "issue data" }],
    details: {},
  }));
  const issue: AgentTool = Object.assign(
    {
      name: "mcp__github__list_issues",
      label: "Issues",
      description: "List GitHub issues",
      parameters: { type: "object", properties: {} },
      execute,
    },
    { exposure: "deferred" as const, namespace: "github" },
  );
  const calendar: AgentTool = Object.assign(
    { ...issue, name: "mcp__calendar__list_events", description: "List calendar events" },
    { namespace: "calendar" },
  );
  const session = wrap(await SessionStore.create(file, dir), [issue, calendar]);
  faux.setResponses([
    (context) => {
      const tools = getCurrentTools(context.messages);
      expect(tools.map((tool) => tool.name)).toEqual(["codemode", "tool_search"]);
      expect(JSON.stringify(context.messages)).not.toContain(issue.name);
      expect(tools.find((tool) => tool.name === "tool_search")?.parameters).toMatchObject({
        type: "object",
        required: expect.arrayContaining(["label", "query"]),
      });
      expect(tools.find((tool) => tool.name === "codemode")?.description).not.toContain(
        "list_issues",
      );
      return fauxAssistantMessage(
        fauxToolCall("tool_search", {
          label: "Find GitHub tools",
          query: "GitHub issues",
          limit: 1,
        }),
      );
    },
    (context) => {
      expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual([
        "mcp__github__list_issues",
        "codemode",
        "tool_search",
      ]);
      return fauxAssistantMessage(fauxToolCall("mcp__github__list_issues", {}));
    },
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("list issues");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(session.messages)).toContain("issue data");
});

test("loaded MCP schemas survive another prompt and close/reopen", async () => {
  const { faux, file, wrap } = setup();
  const { tool } = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const store = await SessionStore.create(file, dir);
  const session = wrap(store, [tool]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("tool_search", { label: "Find issues", query: "issues" })),
    fauxAssistantMessage("loaded"),
    (context) => {
      expect(getCurrentTools(context.messages).map((item) => item.name)).toContain(tool.name);
      return fauxAssistantMessage("retained");
    },
  ]);
  await session.prompt("find issues");
  await session.prompt("use them again");
  expect(JSON.stringify(session.messages)).toContain('"text":"retained"');
  await store.close();
  const reopened = await SessionStore.open(file);
  faux.setResponses([
    (context) => {
      expect(getCurrentTools(context.messages).map((item) => item.name)).toContain(tool.name);
      return fauxAssistantMessage("restored");
    },
  ]);
  await wrap(reopened, [tool]).prompt("continue");
  expect(JSON.stringify(await reopened.getEntries())).toContain("restored");
});

test("resume recovers the native active selection even before discovery metadata is committed", async () => {
  const { faux, file, wrap, models, model } = setup();
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const store = await SessionStore.create(file, dir);
  stores.push(store);
  const placeholders: AgentTool[] = [
    github.tool,
    { ...github.tool, name: "codemode" },
    { ...github.tool, name: "tool_search" },
  ];
  const harness = await store.createHarness({
    models: models.models,
    model,
    tools: placeholders.map(adaptAgentTool),
    activeToolNames: placeholders.map((tool) => tool.name),
    compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 20000 },
  });
  const lane = await harness.lane("main", TODO_CONTEXT);
  getOrThrow(await lane.accept({ kind: "prompt", prompt: "recover discovery" }, TODO_CONTEXT));
  await store.close();
  const session = wrap(await SessionStore.open(file), [github.tool]);
  faux.setResponses([
    (context) => {
      expect(getCurrentTools(context.messages).map((item) => item.name)).toContain(
        github.tool.name,
      );
      return fauxAssistantMessage("recovered selection");
    },
    (context) => {
      expect(getCurrentTools(context.messages).map((item) => item.name)).toContain(
        github.tool.name,
      );
      return fauxAssistantMessage("still loaded");
    },
  ]);
  await session.resume();
  expect(JSON.stringify(session.messages)).toContain("recovered selection");
  await session.prompt("next prompt");
  expect(JSON.stringify(session.messages)).toContain("still loaded");
});

test("revoked grants cannot be searched, called, or restored from prior discovery", async () => {
  const { faux, file, wrap } = setup();
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const calendar = deferredTool("mcp__calendar__list_events", "List calendar events");
  const store = await SessionStore.create(file, dir);
  const session = wrap(store, [github.tool, calendar.tool]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("tool_search", { label: "Find issues", query: "issues" })),
    fauxAssistantMessage("loaded"),
    fauxAssistantMessage(
      fauxToolCall("tool_search", { label: "Try revoked tool", query: "github issues" }),
    ),
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        label: "Try revoked call",
        code: `await tools.${github.tool.name}({});`,
      }),
    ),
    fauxAssistantMessage("revoked"),
    (context) => {
      expect(getCurrentTools(context.messages).map((item) => item.name)).not.toContain(
        github.tool.name,
      );
      return fauxAssistantMessage("grant returned but still deferred");
    },
  ]);
  await session.prompt("discover");
  await session.prompt("try revoked", { tools: [calendar.tool] });
  expect(github.execute).not.toHaveBeenCalled();
  expect(JSON.stringify(session.messages)).toContain("No matching unloaded tools");
  expect(JSON.stringify(session.messages)).toContain("not a function");
  await session.prompt("default grants again");
  expect(JSON.stringify(session.messages)).toContain("grant returned but still deferred");
});

test("codemode exposes async global declarations before discovering deferred tools", async () => {
  const { faux, file, wrap } = setup();
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const session = wrap(await SessionStore.create(file, dir), [github.tool]);
  faux.setResponses([
    (context) => {
      const tools = getCurrentTools(context.messages);
      const description = tools.find((tool) => tool.name === "codemode")?.description ?? "";
      expect(description).toContain("declare function searchTools(");
      expect(description).toContain("Promise<Array<{ name: string; description: string }>>");
      expect(description).toContain(
        "declare function describeTool(name: string): Promise<string | undefined>",
      );
      expect(description).toContain("await searchTools(");
      expect(description).not.toContain(github.tool.name);
      return fauxAssistantMessage(
        fauxToolCall("codemode", {
          label: "Discover from declared globals",
          code: 'const matches = await searchTools("issues", { namespace: "github" }); text(await describeTool(matches[0].name)); text(await tools[matches[0].name]({}));',
        }),
      );
    },
    (context) => {
      expect(getCurrentTools(context.messages).map((tool) => tool.name)).not.toContain(
        github.tool.name,
      );
      return fauxAssistantMessage("done");
    },
  ]);
  await session.prompt("discover from the supplied API declarations");
  expect(JSON.stringify(session.messages)).toContain("declare const tools");
  expect(JSON.stringify(session.messages)).toContain("result-sentinel");
});

test("codemode discovery supplies Pi tool samples with resolved text return types", async () => {
  const { faux, file, wrap } = setup();
  const textTool = deferredTool("mcp__qa__read_text", "Read JSON text");
  const session = wrap(await SessionStore.create(file, dir), [textTool.tool]);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        label: "Inspect return types",
        code: 'const matches = await searchTools("read_text", { namespace: "qa" }); text(matches[0].description); text(await describeTool(matches[0].name));',
      }),
    ),
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("inspect the tool return type before writing a script");
  const result = session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "codemode",
  );
  expect(result).toMatchObject({
    role: "toolResult",
    content: [
      { type: "text", text: expect.stringContaining("Promise<string>") },
      { type: "text", text: expect.stringContaining("Promise<string>") },
    ],
  });
});

test("codemode preserves declared structured return types and values", async () => {
  const { faux, file, wrap } = setup();
  const count = deferredTool("mcp__qa__read_count", "Read a count");
  const tool: AgentTool = {
    ...count.tool,
    outputSchema: { type: "number" },
    execute: async () => ({ content: [], structuredContent: 7, details: {} }),
  };
  const session = wrap(await SessionStore.create(file, dir), [tool]);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        label: "Read the declared count",
        code: 'const matches = await searchTools("read_count", { namespace: "qa" }); text(matches[0].description); text(await tools[matches[0].name]({}));',
      }),
    ),
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("inspect and use the declared structured result");
  const result = session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "codemode",
  );
  expect(result).toMatchObject({
    role: "toolResult",
    content: [
      { type: "text", text: expect.stringContaining("Promise<number>") },
      { type: "text", text: "7" },
    ],
  });
});

test("codemode keeps complete global declarations when the tool catalog exceeds its budget", async () => {
  const { faux, file, wrap } = setup();
  const verbose: AgentTool = {
    name: "verbose",
    label: "Verbose",
    description: "catalog filler ".repeat(1000),
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: {} }),
  };
  const session = wrap(await SessionStore.create(file, dir), [verbose]);
  faux.setResponses([
    (context) => {
      const description =
        getCurrentTools(context.messages).find((tool) => tool.name === "codemode")?.description ??
        "";
      expect(description).toContain("declare function searchTools(");
      expect(description).toContain("Promise<Array<{ name: string; description: string }>>");
      expect(description).toContain(
        "declare function describeTool(name: string): Promise<string | undefined>",
      );
      expect(description).toContain("Declarations may be shortened");
      return fauxAssistantMessage(
        fauxToolCall("codemode", {
          label: "Inspect an omitted declaration",
          code: 'const declaration = await describeTool("verbose"); text(declaration.includes("declare const tools"));',
        }),
      );
    },
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("inspect the full API despite a large tool catalog");
  expect(JSON.stringify(session.messages)).toContain('"text":"true"');
});

test("codemode discovers and calls deferred MCP tools without declaring their schemas", async () => {
  const { faux, file, wrap } = setup();
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const calendar = deferredTool("mcp__calendar__list_events", "List calendar events");
  const session = wrap(await SessionStore.create(file, dir), [github.tool, calendar.tool]);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        label: "Discover and call",
        code: 'const matches = await searchTools("issues", {namespace: "github", limit: 1}); text(await tools[matches[0].name]({}));',
      }),
    ),
    (context) => {
      expect(getCurrentTools(context.messages).map((item) => item.name)).not.toContain(
        github.tool.name,
      );
      return fauxAssistantMessage("done");
    },
  ]);
  await session.prompt("discover via code");
  expect(github.execute).toHaveBeenCalledTimes(1);
  expect(calendar.execute).not.toHaveBeenCalled();
  expect(JSON.stringify(session.messages)).toContain("result-sentinel");
  expect(JSON.stringify(session.messages)).toContain('"text":"done"');
});

test("an unsearched MCP tool cannot be called directly in the model batch", async () => {
  const { faux, file, wrap } = setup();
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const session = wrap(await SessionStore.create(file, dir), [github.tool]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(github.tool.name, {})),
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("call without searching");
  expect(github.execute).not.toHaveBeenCalled();
  expect(session.messages).toContainEqual(
    expect.objectContaining({ role: "toolResult", toolName: github.tool.name, isError: true }),
  );
});

test("multiple searches in one model batch retain the union of loaded tools", async () => {
  const { faux, file, wrap } = setup();
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const calendar = deferredTool("mcp__calendar__list_events", "List calendar events");
  const session = wrap(await SessionStore.create(file, dir), [github.tool, calendar.tool]);
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("tool_search", { label: "Find issues", query: "issues", namespace: "github" }),
      fauxToolCall("tool_search", { label: "Find events", query: "events", namespace: "calendar" }),
    ]),
    (context) => {
      expect(getCurrentTools(context.messages).map((item) => item.name)).toEqual([
        github.tool.name,
        calendar.tool.name,
        "codemode",
        "tool_search",
      ]);
      return fauxAssistantMessage("union retained");
    },
  ]);
  await session.prompt("load both");
  expect(JSON.stringify(session.messages)).toContain("union retained");
});

test("cancelling discovery before execution does not load tools", async () => {
  const { faux, file, wrap } = setup();
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const store = await SessionStore.create(file, dir);
  const session = wrap(store, [github.tool]);
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start" && event.toolName === "tool_search") session.abort();
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("tool_search", { label: "Find issues", query: "issues" })),
  ]);
  await session.prompt("cancel discovery");
  unsubscribe();
  expect(
    (await store.getEntries()).filter((entry) => entry.customType === "mikan.tool_search"),
  ).toHaveLength(0);
  faux.setResponses([
    (context) => {
      expect(getCurrentTools(context.messages).map((item) => item.name)).not.toContain(
        github.tool.name,
      );
      return fauxAssistantMessage("still deferred");
    },
  ]);
  await session.prompt("continue");
  expect(JSON.stringify(session.messages)).toContain("still deferred");
});

test("repeated identical searches cannot bypass the tool loop guard", async () => {
  const { faux, file, wrap } = setup();
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const session = wrap(await SessionStore.create(file, dir), [github.tool]);
  faux.setResponses(
    Array.from({ length: 10 }, () =>
      fauxAssistantMessage(
        fauxToolCall("tool_search", { label: "Search again", query: "zzunmatched" }),
      ),
    ),
  );
  await session.prompt("search repeatedly");
  expect(session.getLastRunStats().budgetExceededReason).toContain("tool loop");
  expect(github.execute).not.toHaveBeenCalled();
});

test.each([
  { query: "    ", limit: 1 },
  { query: "issues", limit: 0 },
  { query: "issues", limit: 21 },
  { query: "issues", limit: 1.5 },
])("invalid search arguments never load tools: $query / $limit", async ({ query, limit }) => {
  const { faux, file, wrap } = setup();
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const session = wrap(await SessionStore.create(file, dir), [github.tool]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("tool_search", { label: "Invalid search", query, limit })),
    (context) => {
      expect(getCurrentTools(context.messages).map((item) => item.name)).not.toContain(
        github.tool.name,
      );
      return fauxAssistantMessage("not loaded");
    },
  ]);
  await session.prompt("invalid search");
  expect(session.messages).toContainEqual(
    expect.objectContaining({ role: "toolResult", toolName: "tool_search", isError: true }),
  );
  expect(JSON.stringify(session.messages)).toContain("not loaded");
});
