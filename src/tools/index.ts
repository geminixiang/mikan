import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import type { ChatResponseBlockKit } from "../adapter.js";
import { createAttachTool } from "../adapters/slack/tools/attach.js";
import { createSlackBlockKitTool } from "../adapters/slack/tools/block-kit.js";
import type { DockerContainerManager } from "../provisioner.js";
import type { Executor, SandboxConfig } from "../sandbox/index.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createEventTool, HostEventStore } from "./event.js";
import { createPMTool } from "./pm.js";
import { createReadTool } from "./read.js";
import { createSandboxTool } from "./sandbox.js";
import { createWriteTool } from "./write.js";

export function createMikanTools(
  executor: Executor,
  workspaceDir: string,
  sandboxController?: {
    sandbox: SandboxConfig;
    provisioner?: Pick<DockerContainerManager, "getLimitStatus" | "setLimits">;
  },
): {
  tools: AgentTool<TSchema>[];
  setUploadFunction: (fn: (filePath: string, title?: string) => Promise<void>) => void;
  setBlockKitResponseFunction: (fn: (response: ChatResponseBlockKit) => Promise<void>) => void;
  setEventContext: (context: {
    platform: string;
    conversationId: string;
    conversationKind: "direct" | "shared";
    userId: string;
  }) => void;
  setSandboxContext: (context: { conversationId: string; userId: string }) => void;
  setPMContext: (context: {
    platform: string;
    conversationId: string;
    conversationKind: "direct" | "shared";
    userId: string;
  }) => void;
} {
  const { tool: attachTool, setUploadFunction } = createAttachTool();
  const { tool: slackBlockKitTool, setBlockKitResponseFunction } = createSlackBlockKitTool();
  const { tool: eventTool, setEventContext } = createEventTool(
    HostEventStore.fromWorkspaceDir(workspaceDir),
  );
  const { tool: sandboxTool, setSandboxContext } = createSandboxTool(
    sandboxController ?? { sandbox: executor.getSandboxConfig() },
  );
  const { tool: pmTool, setPMContext } = createPMTool(workspaceDir);
  return {
    tools: [
      createReadTool(executor),
      createBashTool(executor),
      createEditTool(executor),
      createWriteTool(executor),
      eventTool,
      sandboxTool,
      pmTool,
      attachTool,
      slackBlockKitTool,
    ],
    setUploadFunction,
    setBlockKitResponseFunction,
    setEventContext,
    setSandboxContext,
    setPMContext,
  };
}
