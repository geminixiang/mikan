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
import { adaptAgentTool } from "../harness/tools/pi-tools.js";
import type { MikanHarnessTool, MikanToolInput } from "../harness/types.js";
import { SessionStore } from "../sessions/session-store.js";
import { contextMessages, openSessionAt } from "./session-context.js";

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
  const tool: MikanHarnessTool = Object.assign(
    adaptAgentTool({
      name,
      label: name,
      description,
      parameters: { type: "object", properties: {} },
      execute,
    }),
    { deferred: true },
  );
  return { tool, execute };
}

test("tool_search declares only matching MCP tools on the next model call", async () => {
  const { faux, file, wrap } = setup();
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "issue data" }],
    details: {},
  }));
  const issueTool: AgentTool = {
    name: "mcp__github__list_issues",
    label: "Issues",
    description: "List GitHub issues",
    parameters: { type: "object", properties: {} },
    execute,
  };
  const issue = Object.assign(adaptAgentTool(issueTool), { deferred: true });
  const calendar = Object.assign(
    adaptAgentTool({
      ...issueTool,
      name: "mcp__calendar__list_events",
      description: "List calendar events",
    }),
    { deferred: true },
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

test("revoked grants cannot be searched or called, and a returned grant keeps its discovery", async () => {
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
      expect(getCurrentTools(context.messages).map((item) => item.name)).toContain(
        github.tool.name,
      );
      return fauxAssistantMessage("grant returned with its discovery");
    },
  ]);
  await session.prompt("discover");
  await session.prompt("try revoked", { tools: [calendar.tool] });
  expect(github.execute).not.toHaveBeenCalled();
  expect(JSON.stringify(await contextMessages(session))).toContain("No matching tools found");
  expect(JSON.stringify(await contextMessages(session))).toContain("does not exist");
  await session.prompt("default grants again");
  expect(JSON.stringify(await contextMessages(session))).toContain(
    "grant returned with its discovery",
  );
});

test("MCP tools with codemode exposure are reachable only from scripts", async () => {
  const { faux, file, wrap } = setup();
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const scripted = Object.assign(github.tool, { deferred: undefined, callers: ["tools" as const] });
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
  const tool = Object.assign(
    adaptAgentTool({
      name: "mcp__qa__fail",
      label: "fail",
      description: "Fail with a structured result",
      parameters: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: { isError: { type: "boolean" } } },
      execute: async () => ({
        content: [{ type: "text", text: "quota exceeded" }],
        isError: true,
        structuredContent: { isError: true, content: [{ type: "text", text: "quota exceeded" }] },
        details: {},
      }),
    }),
    { deferred: true },
  );
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
  expect(result).toMatchObject({ isError: false });
  expect(result?.role === "toolResult" ? result.content : []).toContainEqual({
    type: "text",
    text: "isError=true",
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
        code: 'const matches = await searchTools("issues", { limit: 1 }); text(await tools[matches[0].name]({}));',
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
        fauxToolCall("tool_search", { label: "Find issues", query: "issues" }),
        fauxToolCall("tool_search", { label: "Find events", query: "events" }),
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

test("describeNamespace returns a server's instructions and tools to scripts", async () => {
  const { faux, file, wrap } = setup();
  const github = deferredTool("mcp__github__list_issues", "List GitHub issues");
  const scripted = Object.assign(github.tool, { deferred: undefined, callers: ["tools" as const] });
  const store = await openSessionAt(file);
  vi.spyOn(store, "mcpServers").mockReturnValue([
    {
      name: "github",
      exposure: "codemode",
      description: "GitHub",
      instructions: "Page with cursors.",
    },
  ]);
  const session = wrap(store, [scripted]);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        label: "Read the namespace",
        code: 'text(JSON.stringify(await describeNamespace("mcp__github")));',
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("read the namespace");
  const result = JSON.stringify(await contextMessages(session));
  expect(result).toContain("Page with cursors.");
  expect(result).toContain("mcp__github__list_issues");
});
