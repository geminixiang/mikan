import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type ImageProcessor,
} from "@earendil-works/pi-durable/tools";
import type { TObject } from "typebox";
import { LABEL_PARAMETER } from "./host-fn-tool.js";

export function withRequiredLabel(tool: ToolRegistration): ToolRegistration {
  const schema = tool.parameters as TObject;
  return {
    ...tool,
    parameters: {
      ...schema,
      properties: { label: LABEL_PARAMETER, ...schema.properties },
      required: ["label", ...(schema.required ?? [])],
    },
    execute: async (args, api, context) => {
      const { label: _label, ...rest } = args as Record<string, unknown>;
      return tool.execute(rest, api, context);
    },
  };
}

function withLabel(tool: ToolRegistration): ToolRegistration {
  const schema = tool.parameters as TObject;
  return {
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
  };
}

let photonImages: Promise<ImageProcessor> | undefined;

const READ_IMAGES: ImageProcessor = {
  prepare: async (bytes, mimeType, limits) => {
    photonImages ??= createNodePhotonImages().catch((error: unknown) => {
      photonImages = undefined;
      throw error;
    });
    return (await photonImages).prepare(bytes, mimeType, limits);
  },
};

export function createSandboxTools(): ToolRegistration[] {
  const bash = createBashTool({
    prepare: (execution, api) => {
      if (api.env) execution.cwd = api.env.cwd;
    },
  });
  return [
    withLabel(createReadTool({ images: READ_IMAGES }) as ToolRegistration),
    withLabel(createWriteTool() as ToolRegistration),
    withLabel(createEditTool() as ToolRegistration),
    withLabel(bash as ToolRegistration),
  ];
}
