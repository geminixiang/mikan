import type { Api, Model } from "@earendil-works/pi-ai";
import type { ConversationKind } from "../../types.js";
import { createAttachTool } from "./attach.js";
import type { Executor, SandboxConfig } from "../../sandbox/index.js";
import type { OfficeAddress, SandboxResourceController } from "../../types.js";
import type { EventStore } from "../../events/index.js";
import { createEventTool } from "./event.js";
import { createGenerateImageTool } from "./generate-image.js";
import { adaptAgentTool, createSandboxTools, type MikanHarnessTool } from "./pi-tools.js";
import { withSecretRedaction } from "./secret-redaction.js";
import { createTaskTools } from "./task.js";
import { createJevTool } from "./jev.js";
import { createReactTool } from "./react.js";
import { createSandboxTool } from "./sandbox.js";
import type { PlatformToolPackFactory, PlatformToolRunContext } from "./types.js";

export { createSubagentTool } from "./subagent.js";

export function createMikanTools(
  executor: Executor,
  eventStore: EventStore,
  sandboxController?: {
    sandbox: SandboxConfig;
    resourceController?: Pick<SandboxResourceController, "getLimitStatus" | "setLimits">;
  },
  /** Platform capability pack factories (e.g. GitHub PR/CI); instantiated
   *  here so each runner owns its packs' bind state. Not core tools. */
  platformToolPackFactories: readonly PlatformToolPackFactory[] = [],
  imageGeneration?: {
    model: Model<Api>;
    getApiKey: () => Promise<string | undefined>;
    outputDir: string;
  },
): {
  tools: MikanHarnessTool[];
  setUploadFunction: (fn: (filePath: string, title?: string) => Promise<void>) => void;
  /** Upload for generate_image. Receives the file's HOST path — the tool
   *  writes host-side, so this must not stage through the sandbox like the
   *  attach upload does. No-op when image generation is not configured. */
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
  const { tool: eventTool, setEventContext } = createEventTool(eventStore);
  const { tool: sandboxTool, setSandboxContext } = createSandboxTool(
    sandboxController ?? { sandbox: executor.getSandboxConfig() },
  );
  const platformToolPacks = platformToolPackFactories.map((createPack) => createPack());
  const packTools = platformToolPacks.flatMap((pack) => pack.tools);
  return {
    tools: [
      // pi-native read/write/edit/bash, addressed through the sandbox env.
      ...createSandboxTools(),
      adaptAgentTool(eventTool),
      adaptAgentTool(sandboxTool),
      adaptAgentTool(attachTool),
      ...(imageTool ? [adaptAgentTool(imageTool.tool)] : []),
      adaptAgentTool(reactTool),
      adaptAgentTool(jevTool),
      ...taskTools.map(adaptAgentTool),
      ...packTools.map(adaptAgentTool),
      // Every tool above can return a configured secret's plain-text value —
      // most directly bash/read in host sandbox mode, which is not OS-isolated
      // from the mikan process's own env. Redact uniformly rather than only
      // guarding bash.
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
