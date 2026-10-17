import type { Api, Model } from "@earendil-works/pi-ai";
import { createAttachTool, normalizeAttachRuntimePath, withStagedRuntimeFile } from "./attach.js";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { SandboxConfig } from "../../sandbox/types.js";
import type { SandboxResourceController } from "../../types.js";
import type { EventStore } from "../../events/index.js";
import { createEventTool } from "./event.js";
import { createGenerateImageTool } from "./generate-image.js";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createSandboxTools } from "./pi-tools.js";
import { withSecretRedaction } from "./secret-redaction.js";
import { createTaskTools } from "./task.js";
import { createJevTool } from "./jev.js";
import { createJevBrowserTool, type FieldTextGenerator } from "./jev-browser.js";
import { createReactTool } from "./react.js";
import { createSandboxTool } from "./sandbox.js";
import { createWebFetchTool } from "./web-fetch.js";
import type { DesktopAccess, MikanToolRunContext, PlatformToolPack } from "./types.js";

export function createMikanTools(
  env: () => ExecutionEnv | undefined,
  eventStore: EventStore,
  sandboxController: {
    sandbox: SandboxConfig;
    resourceController?: Pick<SandboxResourceController, "getLimitStatus" | "setLimits">;
  },
  platformToolPacks: readonly PlatformToolPack[] = [],
  imageGeneration?: {
    model: Model<Api>;
    getApiKey: () => Promise<string | undefined>;
    outputDir: string;
  },
  generateFieldText?: FieldTextGenerator,
  desktopAccess?: DesktopAccess,
): {
  tools: ToolRegistration[];
  bindRun: (ctx: MikanToolRunContext) => void;
} {
  const { tool: attachTool, setUploadFunction } = createAttachTool();
  const imageTool = imageGeneration ? createGenerateImageTool(imageGeneration) : undefined;
  const { tools: taskTools, bindTasks } = createTaskTools();
  const { tool: reactTool, setReactFunction } = createReactTool();
  const jevTool = createJevTool();
  const jevBrowserTool = createJevBrowserTool(env, generateFieldText, {
    desktop: sandboxController.sandbox.type === "oci",
  });
  const { tool: eventTool, setEventContext } = createEventTool(eventStore);
  const { tool: sandboxTool, setSandboxContext } = createSandboxTool(sandboxController);
  const packTools = platformToolPacks.flatMap((pack) => pack.tools);
  return {
    tools: [
      ...createSandboxTools(),
      eventTool,
      sandboxTool,
      attachTool,
      ...(imageTool ? [imageTool.tool] : []),
      reactTool,
      jevTool,
      jevBrowserTool,
      createWebFetchTool(),
      ...taskTools,
      ...packTools,
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
        await withStagedRuntimeFile(env(), runtimePath, (stagedPath) =>
          responder.uploadFile(stagedPath, title),
        );
      });
      imageTool?.setUploadFunction((hostPath, title) => responder.uploadFile(hostPath, title));
      bindTasks(responder);
      jevBrowserTool.setHandOff(
        desktopAccess && message.conversationKind === "direct"
          ? {
              openDesktop: () => desktopAccess.open(userId),
              announce: (step) =>
                responder.respond(`${step}\n\nOpen the desktop: ${desktopAccess.link(userId)}`),
            }
          : undefined,
      );
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
