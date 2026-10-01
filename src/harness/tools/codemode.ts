import { randomUUID } from "node:crypto";
import {
  CodemodeSandbox,
  parseCodemodeSource,
  renderDeclarations,
  renderToolSample,
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
    outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? { type: "string" },
    exposure: tool.exposure,
    execute: () => undefined,
  }));
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
  ];
  return tagHarnessTool({
    name: "codemode",
    label: "Codemode",
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

Some nested tools, including MCP tools, are omitted below but remain callable on tools and listed in ALL_TOOLS. Discover and inspect them before calling tools[matches[0].name](args):
\`\`\`js
const matches = await searchTools(query, { namespace });
text(await describeTool(matches[0].name));
\`\`\`
If declarations are not known yet, emit the discovered samples first, then write a later script using their parameter and return types. Do not guess argument names. Discovery does not load schemas into the model's direct tool set.

Nested tool declarations:
${renderDeclarations({ tools: declarations.filter((tool) => tool.exposure !== "deferred") }).slice(0, 12_000)}
Declarations may be shortened; use await describeTool(name) for the full schema.`,
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
