import { Type, type Static } from "typebox";
import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import type { MikanHarnessTool, ToolSearchOptions, ToolSearchToolOptions } from "../types.js";
import { LABEL_PARAMETER } from "./host-fn-tool.js";
import { tagHarnessTool } from "./pi-tools.js";
import { isRecord } from "../../unknown-values.js";

export const TOOL_SEARCH_TOOL = "tool_search";
const DEFAULT_SEARCH_LIMIT = 8;

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
      description: `Maximum number of matches; default ${DEFAULT_SEARCH_LIMIT}.`,
    }),
  ),
  namespace: Type.Optional(Type.String({ description: "Restrict matches to an MCP server name." })),
});

export function mcpNamespaceKey(name: string): string {
  return name.replace(/^mcp__/, "").replace(/-/g, "_");
}

const STOP_WORDS: ReadonlySet<string> = new Set(
  "a an and are as at be by for from in is it of on or that the this to with".split(" "),
);

function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0 && !STOP_WORDS.has(term))
    .map(stem);
}

function schemaText(schema: unknown, parts: string[]): void {
  if (!isRecord(schema)) return;
  if (typeof schema.description === "string") parts.push(schema.description);
  if (isRecord(schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties)) {
      parts.push(name);
      schemaText(property, parts);
    }
  }
  schemaText(schema.items, parts);
}

function searchDocument(tool: MikanHarnessTool): string[] {
  const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description];
  schemaText(tool.parameters, parts);
  if (tool.namespace) parts.push(tool.namespace);
  return tokenize(parts.join(" "));
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

export function searchTools(options: ToolSearchOptions): MikanHarnessTool[] {
  const query = options.query.trim();
  if (!query) throw new Error("query must not be empty");
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error("limit must be an integer from 1 to 20");
  const tools = options.tools.filter(
    (tool) =>
      options.namespace === undefined ||
      (tool.namespace !== undefined &&
        mcpNamespaceKey(tool.namespace) === mcpNamespaceKey(options.namespace)),
  );
  const exact = tools.find((tool) => tool.name === query);
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || tools.length === 0) return exact ? [exact] : [];
  const counts = tools.map((tool) => {
    const termCounts = new Map<string, number>();
    for (const term of searchDocument(tool)) termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
    return termCounts;
  });
  const lengths = counts.map((termCounts) =>
    [...termCounts.values()].reduce((sum, count) => sum + count, 0),
  );
  const averageLength = lengths.reduce((sum, length) => sum + length, 0) / tools.length || 1;
  const idf = new Map(
    terms.map((term) => {
      const frequency = counts.filter((termCounts) => termCounts.has(term)).length;
      return [term, Math.log(1 + (tools.length - frequency + 0.5) / (frequency + 0.5))] as const;
    }),
  );
  const ranked = tools
    .map((tool, index) => {
      const norm = BM25_K1 * (1 - BM25_B + (BM25_B * lengths[index]!) / averageLength);
      const score = terms.reduce((sum, term) => {
        const count = counts[index]!.get(term);
        return count
          ? sum + (idf.get(term) ?? 0) * ((count * (BM25_K1 + 1)) / (count + norm))
          : sum;
      }, 0);
      return { tool, score: tool === exact ? Number.POSITIVE_INFINITY : score };
    })
    .filter((match) => match.score > 0)
    .toSorted((a, b) => b.score - a.score);
  return ranked.slice(0, limit).map(({ tool }) => tool);
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
