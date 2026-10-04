import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/chord";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import type { TObject } from "typebox";
import type { MikanHarnessTool } from "../types.js";
import { LABEL_PARAMETER } from "./host-fn-tool.js";

export type { MikanHarnessTool };

const HARNESS_TOOL = Symbol.for("mikan.harnessTool");

export function isHarnessTool(tool: unknown): tool is MikanHarnessTool {
  return Boolean(tool && (tool as Record<PropertyKey, unknown>)[HARNESS_TOOL]);
}

export function tagHarnessTool(tool: MikanHarnessTool): MikanHarnessTool {
  Object.defineProperty(tool, HARNESS_TOOL, { value: true });
  return tool;
}

function toJsonValue(input: unknown): JsonValue | undefined {
  if (input === undefined) return undefined;
  const copy: JsonValue = JSON.parse(JSON.stringify(input));
  return copy;
}

function withLabel(tool: ToolRegistration): MikanHarnessTool {
  const schema = tool.parameters as TObject;
  return tagHarnessTool({
    ...tool,
    parameters: {
      ...schema,
      properties: { ...schema.properties, label: LABEL_PARAMETER },
    },
    execute: async (args, api, context) => {
      if (!api.env) {
        throw new Error(`Tool ${tool.name} requires an execution env; supply an authorized one.`);
      }
      const { label: _label, ...rest } = args as Record<string, unknown>;
      return tool.execute(rest, api, context);
    },
  });
}

export function createSandboxTools(): MikanHarnessTool[] {
  const bash = createBashTool({
    prepare: (execution, api) => {
      if (api.env) execution.cwd = api.env.cwd;
    },
  });
  return [
    withLabel(createReadTool() as ToolRegistration),
    withLabel(createWriteTool() as ToolRegistration),
    withLabel(createEditTool() as ToolRegistration),
    withLabel(bash as ToolRegistration),
  ];
}

export function adaptAgentTool(tool: AgentTool): MikanHarnessTool {
  const exposure =
    "exposure" in tool && (tool.exposure === "deferred" || tool.exposure === "codemode")
      ? tool.exposure
      : undefined;
  const namespace =
    "namespace" in tool && typeof tool.namespace === "string" ? tool.namespace : undefined;
  return tagHarnessTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    outputSchema: tool.outputSchema,
    prepareArguments: tool.prepareArguments,
    executionMode: tool.executionMode,
    exposure,
    namespace,
    replay: tool.replay === "safe" ? "safe" : "unsafe",
    execute: async (args, api, context) => {
      let updates = Promise.resolve();
      const result = await tool.execute(api.callId, args, context.abortSignal, (partial) => {
        const details = toJsonValue(partial.details);
        if (details === undefined) return;
        updates = updates.then(() => api.details(details, context)).catch(() => undefined);
      });
      await updates;
      return {
        content: result.content,
        details: toJsonValue(result.details),
        isError: result.isError,
        structuredContent: result.structuredContent,
        usage: result.usage,
        control: result.terminate ? { terminate: true } : undefined,
      };
    },
  });
}
