import { randomUUID } from "node:crypto";
import {
  CodemodeSandbox,
  mcpStructuredContentSchema,
  parseCodemodeSource,
  renderDeclarations,
  renderToolOutputType,
  renderToolSample,
  toCodemodeIdentifier,
  type CodemodeTool,
  type CodemodeJsonSchema,
} from "@earendil-works/pi-codemode";
import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { CodemodeToolOptions, MikanHarnessTool, MikanToolResult } from "../types.js";
import { LABEL_PARAMETER } from "./host-fn-tool.js";
import { tagHarnessTool } from "./pi-tools.js";
import { START_TASK_TOOL } from "./task.js";
import { mcpNamespaceKey, searchTools, TOOL_SEARCH_TOOL } from "./tool-search.js";
import { isRecord } from "../../unknown-values.js";

const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };

export function isCodemodeCallable(tool: MikanHarnessTool): boolean {
  return (
    tool.name !== "codemode" && tool.name !== START_TASK_TOOL && tool.name !== TOOL_SEARCH_TOOL
  );
}

function outputSchemaOf(tool: MikanHarnessTool): CodemodeJsonSchema {
  return (tool.outputSchema as CodemodeJsonSchema | undefined) ?? TEXT_OUTPUT_SCHEMA;
}

function describeOutput(schema: CodemodeJsonSchema): string {
  const type = renderToolOutputType(schema);
  if (type === "string") return "a string";
  const properties =
    isRecord(schema) && isRecord(schema.properties) ? schema.properties : undefined;
  if (properties && mcpStructuredContentSchema(schema) === undefined) {
    const required = new Set(
      isRecord(schema) && Array.isArray(schema.required) ? schema.required : [],
    );
    const fields = Object.keys(properties).map((name) => (required.has(name) ? name : `${name}?`));
    return `\`{ ${fields.join(", ")} }\``;
  }
  return `\`${type.replace(/\s+/g, " ")}\``;
}

export function withScriptCallNote(tool: MikanHarnessTool): MikanHarnessTool {
  return tagHarnessTool({
    ...tool,
    description: `${tool.description.trim()}\n\nCodemode: \`tools.${toCodemodeIdentifier(tool.name)}(args)\` resolves to ${describeOutput(outputSchemaOf(tool))}.`,
  });
}

function scriptValue(tool: MikanHarnessTool, result: MikanToolResult, output: string): unknown {
  if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content ?? [{ type: "text" as const, text: output }];
  const text = content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  if (result.isError) throw new Error(text || `Tool "${tool.name}" failed`);
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (content.some((part) => part.type === "image")) return { content };
  return text;
}

export function createCodemodeTool(options: CodemodeToolOptions): MikanHarnessTool {
  const callable = options.tools.filter(isCodemodeCallable);
  const declarations = callable.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as CodemodeJsonSchema,
    outputSchema: outputSchemaOf(tool),
    execute: () => undefined,
  }));
  const namespaces = (options.servers ?? []).flatMap((server) => {
    const key = mcpNamespaceKey(server.name);
    const tools = callable
      .filter((tool) => tool.namespace !== undefined && mcpNamespaceKey(tool.namespace) === key)
      .map((tool) => tool.name);
    if (tools.length === 0) return [];
    return [
      {
        key,
        value: {
          name: `mcp__${server.name}`,
          description: server.description,
          instructions: server.instructions,
          tools,
        },
      },
    ];
  });
  const samples = new Map(declarations.map((tool) => [tool.name, renderToolSample(tool)]));
  const globals: CodemodeTool[] = [
    {
      name: "searchTools",
      spread: true,
      description: "Search authorized tools without changing model declarations.",
      signature:
        "(query: string, options?: { limit?: number; namespace?: string }): Promise<Array<{ name: string; description: string }>>",
      execute: (args) => {
        if (!Array.isArray(args) || typeof args[0] !== "string")
          throw new Error("searchTools requires a string query");
        const settings: unknown = args[1];
        if (settings !== undefined && !isRecord(settings))
          throw new Error("searchTools options must be an object");
        const limit: unknown = settings?.limit;
        const namespace: unknown = settings?.namespace;
        if (limit !== undefined && typeof limit !== "number")
          throw new Error("limit must be a number");
        if (namespace !== undefined && typeof namespace !== "string")
          throw new Error("namespace must be a string");
        return searchTools({ tools: callable, query: args[0], limit, namespace }).map((tool) => ({
          name: tool.name,
          description: samples.get(tool.name) ?? tool.description,
        }));
      },
    },
    {
      name: "describeTool",
      description: "Return the full declaration of an authorized tool, or undefined.",
      signature: "(name: string): Promise<string | undefined>",
      execute: (name) => (typeof name === "string" ? samples.get(name) : undefined),
    },
    {
      name: "describeNamespace",
      description:
        "Return an MCP server's description, instructions, and tool names, or undefined. Accepts `mcp__<server>` or `<server>`.",
      signature:
        "(name: string): Promise<{ name: string; description?: string; instructions?: string; tools: string[] } | undefined>",
      execute: (name) => {
        if (typeof name !== "string") return undefined;
        const key = mcpNamespaceKey(name);
        return namespaces.find((namespace) => namespace.key === key)?.value;
      },
    },
  ];
  return tagHarnessTool({
    name: "codemode",
    description: `Run JavaScript code to orchestrate/compose authorized tool calls.
- Evaluates raw JavaScript (not Markdown code fences) in a fresh QuickJS sandbox as an async function body: top-level await and return work.
- Nested tools are on the global tools object: await tools.<name>(args). Each takes an object and resolves to text or a structured value; failed calls reject with an Error.
- Batch independent calls with await Promise.allSettled([...]) and filter results before emitting them. Only script output and its return value reach the model.
- No Node, filesystem, network, process, modules or timers except through authorized tools. Unawaited calls are cancelled when the script finishes. Tool side effects are real and are not undone if the script fails.
- start_task, tool_search and recursive codemode are not callable from scripts.

Global output helpers:
- text(value) and console.* append text; image(dataUrlOrImageContent) forwards an image; exit() ends the script successfully.
- return value emits the final value. store/load values last only for this script, not across calls.
- ALL_TOOLS lists the authorized nested tools as { name, description } entries.

Global discovery helpers (async functions, not methods on tools):
${renderDeclarations({ globals })}

Tools declared to you are also callable from scripts; each one's description says what its call resolves to. Other tools, such as MCP tools, are not listed: find them with searchTools(), inspect them with describeTool() or describeNamespace(), or filter ALL_TOOLS, then call tools[name](args).
Discover in one script: inspect every namespace and tool the task may need together, then call them in the next script using the declared parameter and return types. Do not guess argument names. Discovery does not load schemas into the model's direct tool set.
\`\`\`js
const matches = await searchTools(query, { namespace });
text((await describeNamespace(namespace))?.instructions);
for (const match of matches.slice(0, 3)) text(await describeTool(match.name));
\`\`\`
MCP tools resolve to their complete CallToolResult { content, structuredContent?, isError? }, never truncated: text results are in content[i].text, usually JSON to parse, and an MCP error resolves with isError: true instead of rejecting. Never emit a whole result: everything you emit stays in the conversation and is sent again on every later model call. Parse it and emit only the fields the answer needs:
\`\`\`js
const result = await tools[name](args);
if (result.isError) return result.content[0]?.text;
const data = JSON.parse(result.content[0].text);
return data.items.map(({ id, title }) => ({ id, title }));
\`\`\``,
    parameters: Type.Object({ label: LABEL_PARAMETER, code: Type.String() }),
    execute: async (params, api, context) => {
      const id = api.callId;
      const { code } = validateToolArguments(
        { name: "codemode", description: "", parameters: Type.Object({ code: Type.String() }) },
        { type: "toolCall", id, name: "codemode", arguments: params as JsonObject },
      );
      const source = parseCodemodeSource(code);
      const pending = new Set<Promise<unknown>>();
      const tools: CodemodeTool[] = callable.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters as CodemodeJsonSchema,
        execute: (args, { signal }) => {
          const call = (async () => {
            signal.throwIfAborted();
            const validated: Record<string, unknown> = validateToolArguments(tool, {
              type: "toolCall",
              id,
              name: tool.name,
              arguments: args as JsonObject,
            });
            const nested = nestedApi(api, `${id}:${randomUUID()}`);
            const result = await options.executeNested(tool, [
              validated,
              nested.api,
              withAbortSignal(signal, context),
            ]);
            return scriptValue(tool, result, nested.output());
          })();
          pending.add(call);
          void call.then(
            () => pending.delete(call),
            () => pending.delete(call),
          );
          return call;
        },
      }));
      const sandbox = new CodemodeSandbox({
        tools,
        globals,
        timeoutMs: source.options.timeoutMs ?? 60_000,
        memoryLimitBytes: 64 * 1024 * 1024,
      });
      try {
        const result = await sandbox.execute(source.code, { signal: context.abortSignal });
        const output = [...result.output];
        if (result.ok && result.value !== undefined)
          output.push({ type: "text", text: JSON.stringify(result.value) });
        if (!result.ok) output.push({ type: "text", text: result.error.message });
        let remaining = Math.min(source.options.maxOutputTokens ?? 10_000, 10_000) * 4;
        const content = output.map((part) => {
          if (part.type !== "text") return part;
          const text =
            part.text.length > remaining
              ? `${part.text.slice(0, remaining)}\n[Codemode output truncated; emit less data.]`
              : part.text;
          remaining = Math.max(0, remaining - part.text.length);
          return { type: "text" as const, text };
        });
        return { content, details: undefined, isError: !result.ok };
      } finally {
        await sandbox.close();
        await Promise.allSettled(pending);
      }
    },
  });
}

function nestedApi(
  parent: ToolExecutionApi,
  callId: string,
): { api: ToolExecutionApi; output: () => string } {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  return {
    api: {
      ...parent,
      callId,
      output: (chunk) => {
        chunks.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
      },
      diagnostic: (diagnostic) => {
        chunks.push(`\n[${diagnostic.severity}] ${diagnostic.message}`);
      },
      details: async () => undefined,
    },
    output: () => chunks.join(""),
  };
}
