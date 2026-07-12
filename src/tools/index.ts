import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import type { ConversationKind, GithubPrRequest, GithubPrResult } from "../adapter.js";
import { createAttachTool } from "../adapters/slack/tools/attach.js";
import type { DockerContainerManager } from "../provisioner.js";
import type { Executor, SandboxConfig } from "../sandbox/index.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createEventTool, HostEventStore } from "./event.js";
import { createGithubPrTool } from "./github-pr.js";
import { createReactTool } from "./react.js";
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
  setReactFunction: (fn: ((emoji: string) => Promise<void>) | null) => void;
  setGithubPrFunction: (fn: ((request: GithubPrRequest) => Promise<GithubPrResult>) | null) => void;
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
  const { tool: githubPrTool, setGithubPrFunction } = createGithubPrTool();
  const { tool: eventTool, setEventContext } = createEventTool(
    HostEventStore.fromWorkspaceDir(workspaceDir),
  );
  const { tool: sandboxTool, setSandboxContext } = createSandboxTool(
    sandboxController ?? { sandbox: executor.getSandboxConfig() },
  );
  return {
    tools: [
      createReadTool(executor),
      createBashTool(executor),
      createEditTool(executor),
      createWriteTool(executor),
      eventTool,
      sandboxTool,
      attachTool,
      reactTool,
      githubPrTool,
    ],
    setUploadFunction,
    setReactFunction,
    setGithubPrFunction,
    setEventContext,
    setSandboxContext,
  };
}
