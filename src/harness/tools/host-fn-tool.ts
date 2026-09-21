import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "@sinclair/typebox";

/**
 * A host-backed tool whose implementation is injected per run: a pack's
 * bindRun binds the function for the current conversation (or null to
 * disable the tool). Owns the choreography every such tool used to repeat
 * by hand — the holder + setter pair, the disabled-tool error, and the
 * abort guard — so a tool module only states its schema and its run body.
 *
 * Every mikan-authored tool must carry a required `label` parameter (see
 * `AGENTS.md`, "every model-facing tool schema must declare a required
 * `label`"): the system prompt promises the model this contract
 * unconditionally, and `harness/presenter.ts` renders it as the run's
 * current step. Adding it here, once, for every `defineHostFnTool` caller
 * is how that promise stays true without each tool module remembering to
 * restate it — react.ts and all six `github_*` tools previously did not,
 * so their progress lines rendered only the bare tool name.
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
  const schema = definition.parameters as TSchema;
  const parameters = {
    ...schema,
    properties: {
      label: Type.String({ description: "Brief description of this action (shown to user)" }),
      ...schema.properties,
    },
    required: ["label", ...((schema.required as string[] | undefined) ?? [])],
  } as unknown as TParams;

  const tool: AgentTool<TParams> = {
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters,
    execute: async (_toolCallId, args, signal) => {
      if (!bound) {
        throw new Error(definition.unavailable);
      }
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      const { label: _label, ...rest } = args as Record<string, unknown>;
      return definition.run(bound, rest as Static<TParams>, signal);
    },
  };

  return {
    tool,
    setFn: (fn) => {
      bound = fn;
    },
  };
}
