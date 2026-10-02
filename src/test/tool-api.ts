import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  createRegistry,
  type TaskId,
  type ToolDiagnostic,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { MikanHarnessTool, MikanToolResult } from "../harness/types.js";

export const TEST_CONTEXT = BACKGROUND_CONTEXT;

interface TestToolApi {
  api: ToolExecutionApi;
  output(): string;
  details: JsonValue[];
  diagnostics: ToolDiagnostic[];
}

function unsupported(name: string): never {
  throw new Error(`Test tool API does not support ${name}`);
}

function createTestToolApi(options: { env?: ExecutionEnv; callId?: string } = {}): TestToolApi {
  const chunks: string[] = [];
  const details: JsonValue[] = [];
  const diagnostics: ToolDiagnostic[] = [];
  const decoder = new TextDecoder();
  const api: ToolExecutionApi = {
    taskId: 1 as TaskId,
    conversationId: ROOT_CONVERSATION_ID,
    callId: options.callId ?? "call-1",
    env: options.env,
    registry: createRegistry().snapshot(),
    agent: async () => unsupported("agent"),
    output: (chunk) => {
      chunks.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
    },
    diagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
    details: async (value) => {
      details.push(value);
    },
    commit: async () => unsupported("commit"),
    memo: async () => unsupported("memo"),
    createTask: async () => unsupported("createTask"),
    getTask: async () => unsupported("getTask"),
    waitForTask: async () => unsupported("waitForTask"),
    conversation: async () => unsupported("conversation"),
    snapshot: async () => undefined,
    snapshotAsOf: async () => undefined,
    watchDoc: async () => unsupported("watchDoc"),
  };
  return { api, output: () => chunks.join(""), details, diagnostics };
}

export async function runTestTool(
  tool: Pick<MikanHarnessTool, "execute"> | ToolRegistration,
  args: unknown,
  options: { env?: ExecutionEnv; callId?: string; signal?: AbortSignal } = {},
): Promise<MikanToolResult & { content: NonNullable<MikanToolResult["content"]> }> {
  const { api, output } = createTestToolApi(options);
  const context = options.signal ? withAbortSignal(options.signal, TEST_CONTEXT) : TEST_CONTEXT;
  const result = await tool.execute(args, api, context);
  return { ...result, content: result.content ?? [{ type: "text", text: output() }] };
}
