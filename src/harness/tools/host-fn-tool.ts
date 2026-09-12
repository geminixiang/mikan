import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "@sinclair/typebox";

/**
 * A host-backed tool whose implementation is injected per run: a pack's
 * bindRun binds the function for the current conversation (or null to
 * disable the tool). Owns the choreography every such tool used to repeat
 * by hand — the holder + setter pair, the disabled-tool error, and the
 * abort guard — so a tool module only states its schema and its run body.
 */
export function defineHostFnTool<TFn, TParams extends TSchema>(definition: {
  name: string;
  description: string;
  parameters: TParams;
  /** Error thrown when the tool executes with no bound implementation. */
  unavailable: string;
  run: (
    fn: TFn,
    args: Static<TParams>,
    signal?: AbortSignal,
  ) => ReturnType<AgentTool<TParams>["execute"]>;
}): { tool: AgentTool<TParams>; setFn: (fn: TFn | null) => void } {
  let bound: TFn | null = null;

  const tool: AgentTool<TParams> = {
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    execute: async (_toolCallId, args, signal) => {
      if (!bound) {
        throw new Error(definition.unavailable);
      }
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      return definition.run(bound, args as Static<TParams>, signal);
    },
  };

  return {
    tool,
    setFn: (fn) => {
      bound = fn;
    },
  };
}
