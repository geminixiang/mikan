import type { Api, Model } from "@earendil-works/pi-ai";
import { createAttachTool, normalizeAttachRuntimePath, withStagedRuntimeFile } from "./attach.js";
import type { Executor, SandboxConfig } from "../../sandbox/types.js";
import type { SandboxResourceController } from "../../types.js";
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
import type { MikanToolRunContext, PlatformToolPack } from "./types.js";

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
  bindRun: (ctx: MikanToolRunContext) => void;
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
    bindRun: ({ message, responder, platformName, runtimeWorkspaceRoot }) => {
      const { address, userId } = message;
      setEventContext({
        platform: platformName,
        conversationId: address.conversationId,
        conversationKind: message.conversationKind,
        userId,
      });
      setSandboxContext({ address, userId });
      setUploadFunction(async (filePath, title) => {
        const runtimePath = normalizeAttachRuntimePath(filePath, runtimeWorkspaceRoot);
        await withStagedRuntimeFile(executor, runtimePath, (stagedPath) =>
          responder.uploadFile(stagedPath, title),
        );
      });
      imageTool?.setUploadFunction((hostPath, title) => responder.uploadFile(hostPath, title));
      bindTasks(responder);
      setReactFunction(responder.react ? (emoji) => responder.react!(emoji) : null);
      for (const pack of platformToolPacks) {
        pack.bindRun({
          conversationId: address.conversationId,
          platformName,
          threadTs: message.threadTs,
        });
      }
    },
  };
}
