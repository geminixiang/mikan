import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { Type, type Static, type TObject } from "typebox";

export const LABEL_PARAMETER = Type.String({
  description: "Brief description of this action (shown to user)",
});

export function defineHostFnTool<TFn, TParams extends TObject>(definition: {
  name: string;
  description: string;
  parameters: TParams;
  unavailable: string;
  run: (fn: TFn, args: Static<TParams>, signal?: AbortSignal) => Promise<ToolExecutionResult>;
}): { tool: ToolRegistration<TParams>; setFn: (fn: TFn | null) => void } {
  let bound: TFn | null = null;
  const schema = definition.parameters;
  const parameters = {
    ...schema,
    properties: {
      label: LABEL_PARAMETER,
      ...schema.properties,
    },
    required: ["label", ...(schema.required ?? [])],
  } as TParams;

  const tool: ToolRegistration<TParams> = {
    name: definition.name,
    description: definition.description,
    parameters,
    execute: async (args, _api, context) => {
      if (!bound) {
        throw new Error(definition.unavailable);
      }
      if (context.abortSignal?.aborted) {
        throw new Error("Operation aborted");
      }
      const { label: _label, ...rest } = args as Record<string, unknown>;
      return definition.run(bound, rest as Static<TParams>, context.abortSignal);
    },
  };

  return {
    tool,
    setFn: (fn) => {
      bound = fn;
    },
  };
}
