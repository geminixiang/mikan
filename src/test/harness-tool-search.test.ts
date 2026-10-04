import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
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
import { createCodemodeTool } from "../harness/tools/codemode.js";
import { searchTools } from "../harness/tools/tool-search.js";
import { adaptAgentTool } from "../harness/tools/pi-tools.js";
import type { MikanToolInput } from "../harness/types.js";
import { SessionStore } from "../sessions/session-store.js";
import { contextMessages, openSessionAt } from "./session-context.js";
import { runTestTool } from "./tool-api.js";

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
  const session = wrap(await openSessionAt(file), [issue, calendar]);
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
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      expect(
        getCurrentTools(context.messages)
          .map((tool) => tool.name)
          .toSorted(),
      ).toEqual(["codemode", "mcp__github__list_issues", "tool_search"]);
      return fauxAssistantMessage(fauxToolCall("mcp__github__list_issues", {}), {
        stopReason: "toolUse",
      });
    },
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("list issues");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(await contextMessages(session))).toContain("issue data");
});

test("loaded MCP schemas survive another prompt and close/reopen", async () => {
  const { faux, file, wrap } = setup();
  const { tool } = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const store = await openSessionAt(file);
  const session = wrap(store, [tool]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("tool_search", { label: "Find issues", query: "issues" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("loaded"),
    (context) => {
      expect(getCurrentTools(context.messages).map((item) => item.name)).toContain(tool.name);
      return fauxAssistantMessage("retained");
    },
  ]);
  await session.prompt("find issues");
  await session.prompt("use them again");
  expect(JSON.stringify(await contextMessages(session))).toContain('"text":"retained"');
  await store.close();
  const reopened = await openSessionAt(file);
  faux.setResponses([
    (context) => {
      expect(getCurrentTools(context.messages).map((item) => item.name)).toContain(tool.name);
      return fauxAssistantMessage("restored");
    },
  ]);
  await wrap(reopened, [tool]).prompt("continue");
  expect(JSON.stringify(await reopened.getEntries())).toContain("restored");
});

test("revoked grants cannot be searched, called, or restored from prior discovery", async () => {
  const { faux, file, wrap } = setup();
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const calendar = deferredTool("mcp__calendar__list_events", "List calendar events");
  const store = await openSessionAt(file);
  const session = wrap(store, [github.tool, calendar.tool]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("tool_search", { label: "Find issues", query: "issues" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("loaded"),
    fauxAssistantMessage(
      fauxToolCall("tool_search", { label: "Try revoked tool", query: "github issues" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        label: "Try revoked call",
        code: `await tools.${github.tool.name}({});`,
      }),
      { stopReason: "toolUse" },
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
  expect(JSON.stringify(await contextMessages(session))).toContain("No matching unloaded tools");
  expect(JSON.stringify(await contextMessages(session))).toContain("does not exist");
  await session.prompt("default grants again");
  expect(JSON.stringify(await contextMessages(session))).toContain(
    "grant returned but still deferred",
  );
});

test("codemode exposes async global declarations before discovering deferred tools", async () => {
  const { faux, file, wrap } = setup();
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const session = wrap(await openSessionAt(file), [github.tool]);
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
        { stopReason: "toolUse" },
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
  expect(JSON.stringify(await contextMessages(session))).toContain("declare const tools");
  expect(JSON.stringify(await contextMessages(session))).toContain("result-sentinel");
});

test("codemode discovery supplies Pi tool samples with resolved text return types", async () => {
  const { faux, file, wrap } = setup();
  const textTool = deferredTool("mcp__qa__read_text", "Read JSON text");
  const session = wrap(await openSessionAt(file), [textTool.tool]);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        label: "Inspect return types",
        code: 'const matches = await searchTools("read_text", { namespace: "qa" }); text(matches[0].description); text(await describeTool(matches[0].name));',
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("inspect the tool return type before writing a script");
  const result = (await contextMessages(session)).find(
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
  const session = wrap(await openSessionAt(file), [tool]);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        label: "Read the declared count",
        code: 'const matches = await searchTools("read_count", { namespace: "qa" }); text(matches[0].description); text(await tools[matches[0].name]({}));',
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("inspect and use the declared structured result");
  const result = (await contextMessages(session)).find(
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

test("codemode does not repeat declared tools; each declared tool says how scripts call it", async () => {
  const { faux, file, wrap } = setup();
  const verbose: AgentTool = {
    name: "verbose",
    label: "Verbose",
    description: "catalog filler ".repeat(1000),
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: {} }),
  };
  const session = wrap(await openSessionAt(file), [verbose]);
  faux.setResponses([
    (context) => {
      const tools = getCurrentTools(context.messages);
      const description = tools.find((tool) => tool.name === "codemode")?.description ?? "";
      expect(description).toContain("declare function searchTools(");
      expect(description).toContain("Promise<Array<{ name: string; description: string }>>");
      expect(description).toContain(
        "declare function describeTool(name: string): Promise<string | undefined>",
      );
      expect(description).not.toContain("catalog filler");
      expect(tools.find((tool) => tool.name === "verbose")?.description).toMatch(
        /catalog filler\n\nCodemode: `tools\.verbose\(args\)` resolves to a string\.$/,
      );
      return fauxAssistantMessage(
        fauxToolCall("codemode", {
          label: "Inspect an omitted declaration",
          code: 'const declaration = await describeTool("verbose"); text(declaration.includes("declare const tools"));',
        }),
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("inspect the full API despite a large tool catalog");
  expect(JSON.stringify(await contextMessages(session))).toContain('"text":"true"');
});

test("MCP tools with codemode exposure are reachable only from scripts", async () => {
  const { faux, file, wrap } = setup();
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const scripted: AgentTool = Object.assign({ ...github.tool }, { exposure: "codemode" as const });
  const session = wrap(await openSessionAt(file), [scripted]);
  faux.setResponses([
    (context) => {
      expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["codemode"]);
      return fauxAssistantMessage(
        fauxToolCall("codemode", {
          label: "Call from a script",
          code: `text(await tools.${github.tool.name}({}));`,
        }),
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("list issues from a script");
  expect(github.execute).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(await contextMessages(session))).toContain("result-sentinel");
});

test("a script receives a structured error result instead of a rejection", async () => {
  const { faux, file, wrap } = setup();
  const failing = deferredTool("mcp__qa__fail", "Fail with a structured result");
  const tool: AgentTool = {
    ...failing.tool,
    outputSchema: { type: "object", properties: { isError: { type: "boolean" } } },
    execute: async () => ({
      content: [{ type: "text", text: "quota exceeded" }],
      isError: true,
      structuredContent: { isError: true, content: [{ type: "text", text: "quota exceeded" }] },
      details: {},
    }),
  };
  const session = wrap(await openSessionAt(file), [tool]);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        label: "Inspect the failure",
        code: `const result = await tools.${tool.name}({}); text("isError=" + result.isError);`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("inspect the failure");
  const result = (await contextMessages(session)).find(
    (message) => message.role === "toolResult" && message.toolName === "codemode",
  );
  expect(result).toMatchObject({
    isError: false,
    content: [{ type: "text", text: "isError=true" }],
  });
});

test("codemode discovers and calls deferred MCP tools without declaring their schemas", async () => {
  const { faux, file, wrap } = setup();
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const calendar = deferredTool("mcp__calendar__list_events", "List calendar events");
  const session = wrap(await openSessionAt(file), [github.tool, calendar.tool]);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        label: "Discover and call",
        code: 'const matches = await searchTools("issues", {namespace: "github", limit: 1}); text(await tools[matches[0].name]({}));',
      }),
      { stopReason: "toolUse" },
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
  expect(JSON.stringify(await contextMessages(session))).toContain("result-sentinel");
  expect(JSON.stringify(await contextMessages(session))).toContain('"text":"done"');
});

test("an unsearched MCP tool cannot be called directly in the model batch", async () => {
  const { faux, file, wrap } = setup();
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const session = wrap(await openSessionAt(file), [github.tool]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(github.tool.name, {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("call without searching");
  expect(github.execute).not.toHaveBeenCalled();
  expect(await contextMessages(session)).toContainEqual(
    expect.objectContaining({ role: "toolResult", toolName: github.tool.name, isError: true }),
  );
});

test("multiple searches in one model batch retain the union of loaded tools", async () => {
  const { faux, file, wrap } = setup();
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const calendar = deferredTool("mcp__calendar__list_events", "List calendar events");
  const session = wrap(await openSessionAt(file), [github.tool, calendar.tool]);
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("tool_search", { label: "Find issues", query: "issues", namespace: "github" }),
        fauxToolCall("tool_search", {
          label: "Find events",
          query: "events",
          namespace: "calendar",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    (context) => {
      expect(
        getCurrentTools(context.messages)
          .map((item) => item.name)
          .toSorted(),
      ).toEqual([calendar.tool.name, "codemode", github.tool.name, "tool_search"].toSorted());
      return fauxAssistantMessage("union retained");
    },
  ]);
  await session.prompt("load both");
  expect(JSON.stringify(await contextMessages(session))).toContain("union retained");
});

test("cancelling discovery before execution does not load tools", async () => {
  const { faux, file, wrap } = setup();
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const store = await openSessionAt(file);
  const session = wrap(store, [github.tool]);
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start" && event.toolName === "tool_search") session.abort();
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("tool_search", { label: "Find issues", query: "issues" }), {
      stopReason: "toolUse",
    }),
  ]);
  await session.prompt("cancel discovery");
  unsubscribe();
  faux.setResponses([
    (context) => {
      expect(getCurrentTools(context.messages).map((item) => item.name)).not.toContain(
        github.tool.name,
      );
      return fauxAssistantMessage("still deferred");
    },
  ]);
  await session.prompt("continue");
  expect(JSON.stringify(await contextMessages(session))).toContain("still deferred");
});

test("repeated identical searches cannot bypass the tool loop guard", async () => {
  const { faux, file, wrap } = setup();
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const session = wrap(await openSessionAt(file), [github.tool]);
  faux.setResponses(
    Array.from({ length: 10 }, () =>
      fauxAssistantMessage(
        fauxToolCall("tool_search", { label: "Search again", query: "zzunmatched" }),
        { stopReason: "toolUse" },
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
  const session = wrap(await openSessionAt(file), [github.tool]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("tool_search", { label: "Invalid search", query, limit }), {
      stopReason: "toolUse",
    }),
    (context) => {
      expect(getCurrentTools(context.messages).map((item) => item.name)).not.toContain(
        github.tool.name,
      );
      return fauxAssistantMessage("not loaded");
    },
  ]);
  await session.prompt("invalid search");
  expect(await contextMessages(session)).toContainEqual(
    expect.objectContaining({ role: "toolResult", toolName: "tool_search", isError: true }),
  );
  expect(JSON.stringify(await contextMessages(session))).toContain("not loaded");
});

test("describeNamespace returns a server's instructions and tools to scripts", async () => {
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const scripted = adaptAgentTool(
    Object.assign({ ...github.tool }, { exposure: "codemode" as const }),
  );
  const codemode = createCodemodeTool({
    tools: [scripted],
    servers: [
      {
        name: "github",
        exposure: "codemode",
        description: "GitHub",
        instructions: "Page with cursors.",
      },
    ],
    executeNested: async (tool, call) => tool.execute(...call),
  });
  const result = await runTestTool(codemode, {
    label: "Read the namespace",
    code: 'for (const name of ["mcp__github", "github", "unknown"]) text(JSON.stringify(await describeNamespace(name)));',
  });
  const expected = {
    name: "mcp__github",
    description: "GitHub",
    instructions: "Page with cursors.",
    tools: ["mcp__github__list_issues"],
  };
  expect(result.content).toEqual([
    { type: "text", text: JSON.stringify(expected) },
    { type: "text", text: JSON.stringify(expected) },
    { type: "text", text: "undefined" },
  ]);
  expect(codemode.description).toContain("declare function describeNamespace(");
});

test("searchTools matches a server name written as one word, as Pi's tokenizer does", () => {
  const subagent = adaptAgentTool({
    name: "subagent",
    label: "Subagent",
    description: "Run subagents to search, read, and summarize anything",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: {} }),
  });
  const search = adaptAgentTool(
    Object.assign(
      { ...deferredTool("mcp__open-connector__search_actions", "Find catalog actions").tool },
      { namespace: "open-connector" },
    ),
  );
  expect(
    searchTools({ tools: [subagent, search], query: "OpenConnector search arXiv papers" }).map(
      (tool) => tool.name,
    ),
  ).toEqual(["mcp__open-connector__search_actions", "subagent"]);
  expect(searchTools({ tools: [subagent, search], query: "OpenConnector" })).toEqual([search]);
});
