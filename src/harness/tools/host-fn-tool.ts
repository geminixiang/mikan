import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { Type, type Static, type TObject } from "typebox";
import { isRecord } from "../../unknown-values.js";

export const LABEL_PARAMETER = Type.String({
  description: "Brief description of this action (shown to user)",
});

export function withLabelParameter<T extends { properties?: unknown; required?: unknown }>(
  schema: T,
  presence: "required" | "optional",
): T {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  if (presence === "optional") {
    return { ...schema, properties: { ...properties, label: LABEL_PARAMETER } };
  }
  const required: unknown[] = Array.isArray(schema.required) ? schema.required : [];
  return {
    ...schema,
    properties: { label: LABEL_PARAMETER, ...properties },
    required: ["label", ...required],
  };
}

export function withoutLabel(args: unknown): Record<string, unknown> {
  if (!isRecord(args)) return {};
  const { label: _label, ...rest } = args;
  return rest;
}

export function defineHostFnTool<TFn, TParams extends TObject>(definition: {
  name: string;
  description: string;
  parameters: TParams;
  unavailable: string;
  run: (fn: TFn, args: Static<TParams>, signal?: AbortSignal) => Promise<ToolExecutionResult>;
}): { tool: ToolRegistration<TParams>; setFn: (fn: TFn | null) => void } {
  let bound: TFn | null = null;
  const tool: ToolRegistration<TParams> = {
    name: definition.name,
    description: definition.description,
    parameters: withLabelParameter(definition.parameters, "required"),
    execute: async (args, _api, context) => {
      if (!bound) {
        throw new Error(definition.unavailable);
      }
      if (context.abortSignal?.aborted) {
        throw new Error("Operation aborted");
      }
      return definition.run(bound, withoutLabel(args) as Static<TParams>, context.abortSignal);
    },
  };

  return {
    tool,
    setFn: (fn) => {
      bound = fn;
    },
  };
}
