import { Type, type Static } from "typebox";
import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import type { MikanHarnessTool, ToolSearchOptions, ToolSearchToolOptions } from "../types.js";
import { LABEL_PARAMETER } from "./host-fn-tool.js";
import { tagHarnessTool } from "./pi-tools.js";

export const TOOL_SEARCH_TOOL = "tool_search";

const searchSchema = Type.Object({
  label: LABEL_PARAMETER,
  query: Type.String({
    minLength: 1,
    description:
      "Keywords describing the tool or task. Searches tool names, descriptions and argument schemas, not web content.",
  }),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 20,
      multipleOf: 1,
      description: "Maximum number of matches; default 5.",
    }),
  ),
  namespace: Type.Optional(Type.String({ description: "Restrict matches to an MCP server name." })),
});

export function searchTools(options: ToolSearchOptions): MikanHarnessTool[] {
  const query = options.query.trim().toLowerCase();
  if (!query) throw new Error("query must not be empty");
  const limit = options.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error("limit must be an integer from 1 to 20");
  const terms = [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])];
  return options.tools
    .filter((tool) => options.namespace === undefined || tool.namespace === options.namespace)
    .map((tool) => {
      const name = tool.name.toLowerCase();
      const description = tool.description.toLowerCase();
      const schema = JSON.stringify(tool.parameters).toLowerCase();
      const score = terms.reduce(
        (sum, term) =>
          sum +
          (name.includes(term) ? 3 : 0) +
          (description.includes(term) ? 1 : 0) +
          (schema.includes(term) ? 0.25 : 0),
        0,
      );
      return { tool, score: score + (name === query ? 100 : 0) };
    })
    .filter((match) => match.score > 0)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ tool }) => tool);
}

export function createToolSearchTool(options: ToolSearchToolOptions): MikanHarnessTool {
  const namespaces = [...new Set(options.tools.map((tool) => tool.namespace).filter(Boolean))];
  return tagHarnessTool({
    name: TOOL_SEARCH_TOOL,
    description: `Search authorized MCP tools that are not declared yet, then load matching schemas for the next model call. Use descriptive keywords or an exact tool name. Already loaded tools stay available. This searches tool metadata, not web pages or repository content. Available MCP namespaces: ${namespaces.join(", ") || "none"}.`,
    parameters: searchSchema,
    execute: async (params, api, context) => {
      const id = api.callId;
      context.abortSignal?.throwIfAborted();
      const args: Static<typeof searchSchema> = validateToolArguments(
        { name: TOOL_SEARCH_TOOL, description: "", parameters: searchSchema },
        {
          type: "toolCall",
          id,
          name: TOOL_SEARCH_TOOL,
          arguments: params as JsonObject,
        },
      );
      const matches = searchTools({
        tools: options.tools.filter((tool) => !options.loaded.has(tool.name)),
        query: args.query,
        limit: args.limit,
        namespace: args.namespace,
      });
      const loaded = matches.map((tool) => tool.name);
      if (loaded.length > 0) await options.load(loaded, context);
      return {
        content: [
          {
            type: "text",
            text:
              loaded.length === 0
                ? "No matching unloaded tools found. Already loaded tools remain available."
                : `Loaded ${loaded.length} tools for the next model call:\n${matches.map((tool) => `- ${tool.name}: ${tool.description.split(/\r?\n/)[0]?.slice(0, 300)}`).join("\n")}`,
          },
        ],
        details: { loaded },
        control: loaded.length > 0 ? { addTools: loaded } : undefined,
      };
    },
  });
}
