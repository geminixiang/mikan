import { randomUUID } from "node:crypto";
import {
  CodemodeSandbox,
  parseCodemodeSource,
  renderDeclarations,
  type CodemodeTool,
  type CodemodeJsonSchema,
} from "@earendil-works/pi-codemode";
import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import { withAbortSignal } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { CodemodeToolOptions, MikanHarnessTool } from "../types.js";
import { LABEL_PARAMETER } from "./host-fn-tool.js";
import { tagHarnessTool } from "./pi-tools.js";
import { START_TASK_TOOL } from "./task.js";
import { searchTools, TOOL_SEARCH_TOOL } from "./tool-search.js";
import { isRecord } from "../../unknown-values.js";

export function createCodemodeTool(options: CodemodeToolOptions): MikanHarnessTool {
  const callable = options.tools.filter(
    (tool) =>
      tool.name !== "codemode" && tool.name !== START_TASK_TOOL && tool.name !== TOOL_SEARCH_TOOL,
  );
  const declarations = callable.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as CodemodeJsonSchema,
    exposure: tool.exposure,
    execute: () => undefined,
  }));
  return tagHarnessTool({
    name: "codemode",
    label: "Codemode",
    description: `Run JavaScript in an isolated QuickJS sandbox. Call tools with await tools.<name>(args), combine independent calls with Promise.allSettled, and filter results before text(value) or return. Only emitted output reaches the model. No filesystem, network, process or modules except through authorized tools. ALL_TOOLS lists available tools; searchTools(query, { limit, namespace }) discovers authorized tools without loading their schemas into the model context. describeTool(name) returns a tool's full declaration. MCP declarations are omitted here; use searchTools to discover them. start_task and recursive codemode are unavailable. store/load do not persist between calls.\n\n${renderDeclarations({ tools: declarations.filter((tool) => tool.exposure !== "deferred") }).slice(0, 12_000)}\nDeclarations may be shortened; use describeTool(name) for the full schema.`,
    parameters: Type.Object({ label: LABEL_PARAMETER, code: Type.String() }),
    execute: async (id, params, onUpdate, toolContext, invocation, context) => {
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
            const result = await options.executeNested(tool, [
              `${id}:${randomUUID()}`,
              validated,
              onUpdate,
              toolContext,
              invocation,
              withAbortSignal(signal, context),
            ]);
            if (result.isError)
              throw new Error(
                result.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n"),
              );
            if (result.structuredContent !== undefined) return result.structuredContent;
            if (result.content.some((part) => part.type === "image"))
              return { content: result.content };
            return result.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
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
        globals: [
          {
            name: "searchTools",
            spread: true,
            description: "Search authorized tools without changing model declarations",
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
              return searchTools({ tools: callable, query: args[0], limit, namespace }).map(
                (tool) => ({ name: tool.name, description: tool.description }),
              );
            },
          },
          {
            name: "describeTool",
            description: "Return the full declaration of an authorized tool",
            execute: (name) => {
              const tool = declarations.find((item) => item.name === name);
              return tool ? renderDeclarations({ tools: [tool] }) : undefined;
            },
          },
        ],
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
