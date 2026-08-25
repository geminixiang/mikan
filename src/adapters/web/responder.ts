import type {
  ChatToolResult,
  ChatToolStart,
  ConversationResponder,
  SubagentProgressSnapshot,
} from "../../adapter.js";
import type { WebEventHub } from "../../web/harness/hub.js";
import type { WebToolSnapshot } from "../../web/harness/protocol.js";

interface WebResponderOptions {
  readonly hub: WebEventHub;
  readonly workspaceId: string;
  readonly runId: string;
  readonly requestId: string;
}

/** Maps the shared responder contract to source-text Web stream frames. */
export function createWebResponder(options: WebResponderOptions): ConversationResponder {
  const { hub, workspaceId, runId, requestId } = options;
  let responseText = "";

  const publishRun = (): void => {
    hub.publish(workspaceId, {
      type: "run.snapshot",
      run: { id: runId, requestId, status: "running", responseText },
    });
  };

  const publishFinal = (text: string): void => {
    responseText = text;
    hub.publish(workspaceId, { type: "response.final", runId, text });
    publishRun();
  };

  return {
    respond: async (text) => {
      publishFinal(responseText ? `${responseText}\n${text}` : text);
    },
    appendResponseDelta: async (delta) => {
      responseText += delta;
      hub.publish(workspaceId, { type: "response.delta", runId, text: delta });
      publishRun();
    },
    finishResponse: async (finalText) => {
      publishFinal(finalText ?? responseText);
    },
    replaceResponse: async (text) => {
      publishFinal(text);
    },
    replaceSubagentProgress: async (progress: SubagentProgressSnapshot, finalText?: string) => {
      hub.publish(workspaceId, {
        type: "subagents.snapshot",
        items: progress.nodes,
      });
      if (finalText !== undefined) publishFinal(finalText);
    },
    respondDiagnostic: async (message, diagnosticOptions) => {
      hub.publish(workspaceId, {
        type: "diagnostic",
        runId,
        level: diagnosticOptions?.style === "error" ? "error" : "info",
        message,
      });
    },
    respondToolStart: async (started: ChatToolStart) => {
      const tool: WebToolSnapshot = {
        id: started.toolCallId,
        runId,
        name: started.toolName,
        ...(started.label ? { label: started.label } : {}),
        status: "running",
      };
      hub.publish(workspaceId, { type: "tool.started", runId, tool });
    },
    respondToolResult: async (result: ChatToolResult) => {
      const tool: WebToolSnapshot = {
        id: result.toolCallId ?? `${runId}:${result.toolName}`,
        runId,
        name: result.toolName,
        ...(result.label ? { label: result.label } : {}),
        status: result.isError ? "error" : "done",
        result: result.result,
        durationMs: result.durationMs,
      };
      hub.publish(workspaceId, { type: "tool.finished", runId, tool });
    },
    setTyping: async () => {},
    setWorking: async (working) => {
      if (!working) {
        hub.publish(workspaceId, { type: "run.snapshot", run: null });
        return;
      }
      publishRun();
    },
    uploadFile: async (_filePath, title) => {
      hub.publish(workspaceId, {
        type: "diagnostic",
        runId,
        level: "info",
        message: title ? `Produced file: ${title}` : "Produced a file",
      });
    },
    deleteResponse: async () => {
      responseText = "";
      publishRun();
    },
  };
}

export function markWebResponderFailed(
  hub: WebEventHub,
  workspaceId: string,
  runId: string,
  requestId: string,
  message: string,
): void {
  hub.publish(workspaceId, {
    type: "run.snapshot",
    run: { id: runId, requestId, status: "failed", responseText: "" },
  });
  hub.publish(workspaceId, {
    type: "error",
    requestId,
    runId,
    code: "run_failed",
    message,
  });
}
