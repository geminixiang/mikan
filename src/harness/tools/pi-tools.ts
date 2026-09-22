import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "@sinclair/typebox";
import type { MikanHarnessTool } from "../types.js";

export type { MikanHarnessTool };

const HARNESS_TOOL = Symbol.for("mikan.harnessTool");

export function isHarnessTool(tool: unknown): tool is MikanHarnessTool {
  return Boolean(tool && (tool as Record<PropertyKey, unknown>)[HARNESS_TOOL]);
}

function tagHarnessTool(tool: MikanHarnessTool): MikanHarnessTool {
  Object.defineProperty(tool, HARNESS_TOOL, { value: true });
  return tool;
}

function withLabel(tool: MikanHarnessTool): MikanHarnessTool {
  const schema = tool.parameters as TSchema;
  const parameters = {
    ...schema,
    properties: {
      ...schema.properties,
      label: Type.String({ description: "Brief description of this action (shown to user)" }),
    },
  };

  return tagHarnessTool({
    ...tool,
    parameters,
    execute: async (...args: Parameters<MikanHarnessTool["execute"]>) => {
      const [toolCallId, params, onUpdate, toolContext, invocation, context] = args;
      if (!toolContext?.env) {
        throw new Error(
          `Tool ${tool.name} requires toolContext.env; supply an authorized execution env.`,
        );
      }
      const { label: _label, ...rest } = params as Record<string, unknown>;
      return tool.execute(
        toolCallId,
        rest as typeof params,
        onUpdate,
        toolContext,
        invocation,
        context,
      );
    },
  });
}

export function createSandboxTools(): MikanHarnessTool[] {
  const bash = createBashTool({
    prepare: (execution, toolContext) => {
      execution.cwd = toolContext.env.cwd;
    },
  });
  return [
    withLabel(createReadTool() as MikanHarnessTool),
    withLabel(createWriteTool() as MikanHarnessTool),
    withLabel(createEditTool() as MikanHarnessTool),
    withLabel(bash as MikanHarnessTool),
  ];
}

export function adaptAgentTool(tool: AgentTool): MikanHarnessTool {
  return tagHarnessTool({
    ...tool,
    execute: (...args: Parameters<MikanHarnessTool["execute"]>) => {
      const [toolCallId, params, onUpdate, , , context] = args;
      return tool.execute(toolCallId, params, context.abortSignal, onUpdate);
    },
  } as MikanHarnessTool);
}
