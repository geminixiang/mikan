import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createAttachTool } from "../adapters/slack/tools/attach.js";
import type { Executor } from "../sandbox/index.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createEventTool, HostEventStore } from "./event.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export function createMamaTools(
  executor: Executor,
  workspaceDir: string,
): {
  tools: AgentTool<any>[];
  setUploadFunction: (fn: (filePath: string, title?: string) => Promise<void>) => void;
  setEventContext: (context: {
    platform: string;
    conversationId: string;
    conversationKind: "direct" | "shared";
    userId: string;
  }) => void;
} {
  const { tool: attachTool, setUploadFunction } = createAttachTool();
  const { tool: eventTool, setEventContext } = createEventTool(
    HostEventStore.fromWorkspaceDir(workspaceDir),
  );
  return {
    tools: [
      createReadTool(executor),
      createBashTool(executor),
      createEditTool(executor),
      createWriteTool(executor),
      eventTool,
      attachTool,
    ],
    setUploadFunction,
    setEventContext,
  };
}
