import type { Api, Model } from "@earendil-works/pi-ai";
import type { ConversationKind } from "../../types.js";
import { createAttachTool } from "./attach.js";
import type { Executor, SandboxConfig } from "../../sandbox/types.js";
import type { OfficeAddress, SandboxResourceController } from "../../types.js";
import type { EventStore } from "../../events/index.js";
import { createEventTool } from "./event.js";
import { createGenerateImageTool } from "./generate-image.js";
import { adaptAgentTool, createSandboxTools, type MikanHarnessTool } from "./pi-tools.js";
import { withSecretRedaction } from "./secret-redaction.js";
import { createTaskTools } from "./task.js";
import { createJevTool } from "./jev.js";
import { createJevBrowserTool } from "./jev-browser.js";
import { createReactTool } from "./react.js";
import { createSandboxTool } from "./sandbox.js";
import type { PlatformToolPack, PlatformToolRunContext } from "./types.js";

export function createMikanTools(
  executor: Executor,
  eventStore: EventStore,
  sandboxController?: {
    sandbox: SandboxConfig;
    resourceController?: Pick<SandboxResourceController, "getLimitStatus" | "setLimits">;
  },
  platformToolPacks: readonly PlatformToolPack[] = [],
  imageGeneration?: {
    model: Model<Api>;
    getApiKey: () => Promise<string | undefined>;
    outputDir: string;
  },
): {
  tools: MikanHarnessTool[];
  setUploadFunction: (fn: (filePath: string, title?: string) => Promise<void>) => void;
  setImageUploadFunction: (fn: (hostPath: string, title?: string) => Promise<void>) => void;
  bindTasks: ReturnType<typeof createTaskTools>["bindTasks"];
  setReactFunction: (fn: ((emoji: string) => Promise<void>) | null) => void;
  bindPlatformToolPacks: (ctx: PlatformToolRunContext) => void;
  setEventContext: (context: {
    platform: string;
    conversationId: string;
    conversationKind: ConversationKind;
    userId: string;
  }) => void;
  setSandboxContext: (context: { address: OfficeAddress; userId: string }) => void;
} {
  const { tool: attachTool, setUploadFunction } = createAttachTool();
  const imageTool = imageGeneration ? createGenerateImageTool(imageGeneration) : undefined;
  const { tools: taskTools, bindTasks } = createTaskTools();
  const { tool: reactTool, setReactFunction } = createReactTool();
  const jevTool = createJevTool();
  const jevBrowserTool = createJevBrowserTool(executor);
  const { tool: eventTool, setEventContext } = createEventTool(eventStore);
  const { tool: sandboxTool, setSandboxContext } = createSandboxTool(
    sandboxController ?? { sandbox: executor.getSandboxConfig() },
  );
  const packTools = platformToolPacks.flatMap((pack) => pack.tools);
  return {
    tools: [
      ...createSandboxTools(),
      adaptAgentTool(eventTool),
      adaptAgentTool(sandboxTool),
      adaptAgentTool(attachTool),
      ...(imageTool ? [adaptAgentTool(imageTool.tool)] : []),
      adaptAgentTool(reactTool),
      adaptAgentTool(jevTool),
      adaptAgentTool(jevBrowserTool),
      ...taskTools.map(adaptAgentTool),
      ...packTools.map(adaptAgentTool),
    ].map(withSecretRedaction),
    setUploadFunction,
    setImageUploadFunction: (fn) => {
      imageTool?.setUploadFunction(fn);
    },
    setReactFunction,
    bindTasks,
    bindPlatformToolPacks: (ctx) => {
      for (const pack of platformToolPacks) {
        pack.bindRun(ctx);
      }
    },
    setEventContext,
    setSandboxContext,
  };
}
