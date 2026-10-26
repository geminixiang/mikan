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
import { withLabelParameter, withoutLabel } from "./host-fn-tool.js";

export function withRequiredLabel(tool: ToolRegistration): ToolRegistration {
  return {
    ...tool,
    parameters: withLabelParameter(tool.parameters as TObject, "required"),
    execute: async (args, api, context) => tool.execute(withoutLabel(args), api, context),
  };
}

function withLabel(tool: ToolRegistration): ToolRegistration {
  return {
    ...tool,
    parameters: withLabelParameter(tool.parameters as TObject, "optional"),
    execute: async (args, api, context) => {
      if (!api.env) {
        throw new Error(`Tool ${tool.name} requires an execution env; supply an authorized one.`);
      }
      return tool.execute(withoutLabel(args), api, context);
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
