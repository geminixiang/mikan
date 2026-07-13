import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import type { ConversationKind } from "../adapter.js";
import { createAttachTool } from "../adapters/slack/tools/attach.js";
import type { DockerContainerManager } from "../provisioner.js";
import type { Executor, SandboxConfig } from "../sandbox/index.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createEventTool, HostEventStore } from "./event.js";
import { createReactTool } from "./react.js";
import { createReadTool } from "./read.js";
import { createSandboxTool } from "./sandbox.js";
import type { PlatformToolPackFactory } from "./types.js";
import { createWriteTool } from "./write.js";

export function createMikanTools(
  executor: Executor,
  workspaceDir: string,
  sandboxController?: {
    sandbox: SandboxConfig;
    provisioner?: Pick<DockerContainerManager, "getLimitStatus" | "setLimits">;
  },
  /** Platform capability pack factories (e.g. GitHub PR/CI); instantiated
   *  here so each runner owns its packs' bind state. Not core tools. */
  platformToolPackFactories: readonly PlatformToolPackFactory[] = [],
): {
  tools: AgentTool<TSchema>[];
  setUploadFunction: (fn: (filePath: string, title?: string) => Promise<void>) => void;
  setReactFunction: (fn: ((emoji: string) => Promise<void>) | null) => void;
  bindPlatformToolPacks: (ctx: { conversationId: string; platformName: string }) => void;
  setEventContext: (context: {
    platform: string;
    conversationId: string;
    conversationKind: ConversationKind;
    userId: string;
  }) => void;
  setSandboxContext: (context: { conversationId: string; userId: string }) => void;
} {
  const { tool: attachTool, setUploadFunction } = createAttachTool();
  const { tool: reactTool, setReactFunction } = createReactTool();
  const { tool: eventTool, setEventContext } = createEventTool(
    HostEventStore.fromWorkspaceDir(workspaceDir),
  );
  const { tool: sandboxTool, setSandboxContext } = createSandboxTool(
    sandboxController ?? { sandbox: executor.getSandboxConfig() },
  );
  const platformToolPacks = platformToolPackFactories.map((createPack) => createPack());
  const packTools = platformToolPacks.flatMap((pack) => pack.tools);
  return {
    tools: [
      createReadTool(executor),
      createBashTool(executor, { hostWorkspaceRoot: workspaceDir }),
      createEditTool(executor),
      createWriteTool(executor),
      eventTool,
      sandboxTool,
      attachTool,
      reactTool,
      ...packTools,
    ],
    setUploadFunction,
    setReactFunction,
    bindPlatformToolPacks: (ctx) => {
      for (const pack of platformToolPacks) {
        pack.bindRun(ctx);
      }
    },
    setEventContext,
    setSandboxContext,
  };
}
