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

/**
 * Marker distinguishing harness-native tools from mikan's own `AgentTool`s.
 *
 * `MikanAgentSession` is published API and historically accepted plain
 * `AgentTool`s, so the session upgrades any untagged tool at the boundary
 * instead of forcing every caller to adapt first. Pi's native tools and
 * `adaptAgentTool` results carry the marker so they pass through untouched.
 */
const HARNESS_TOOL = Symbol.for("mikan.harnessTool");

export function isHarnessTool(tool: unknown): tool is MikanHarnessTool {
  return Boolean(tool && (tool as Record<PropertyKey, unknown>)[HARNESS_TOOL]);
}

function tagHarnessTool(tool: MikanHarnessTool): MikanHarnessTool {
  Object.defineProperty(tool, HARNESS_TOOL, { value: true });
  return tool;
}

/**
 * Add mikan's `label` parameter to a pi-native tool.
 *
 * pi's tools do not carry a `label`, but mikan's system prompt tells the model
 * every tool takes one and the presenter renders it as the run's current step.
 * The parameter is optional so pi's own validation still accepts a raw call,
 * and it is stripped before the original tool sees the arguments.
 */
function withLabel(tool: MikanHarnessTool): MikanHarnessTool {
  const schema = tool.parameters as unknown as { properties?: Record<string, TSchema> };
  const parameters = Type.Object({
    ...schema.properties,
    label: Type.Optional(
      Type.String({ description: "Brief description of this action (shown to user)" }),
    ),
  });

  return tagHarnessTool({
    ...tool,
    parameters,
    execute: (...args: Parameters<MikanHarnessTool["execute"]>) => {
      const [toolCallId, params, onUpdate, toolContext, invocation, context] = args;
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

/**
 * pi's four execution tools, bound to the sandbox-backed env supplied as the
 * harness `toolContext`. Nothing mikan-specific lives here beyond `label` and
 * the bash cwd (pi defaults it to `env.cwd` anyway, but pinning it documents
 * that the runtime workspace root is the shell's working directory).
 */
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

/**
 * Adapt a mikan-authored `AgentTool` (its execute takes `(id, params, signal,
 * onUpdate)`) to a harness tool. mikan's tools carry their own sandbox executor
 * and read the abort signal from the harness context.
 */
export function adaptAgentTool(tool: AgentTool): MikanHarnessTool {
  return tagHarnessTool({
    ...tool,
    execute: (...args: Parameters<MikanHarnessTool["execute"]>) => {
      const [toolCallId, params, onUpdate, , , context] = args;
      return tool.execute(toolCallId, params, context.abortSignal, onUpdate);
    },
  } as MikanHarnessTool);
}
