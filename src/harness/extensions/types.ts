/**
 * mikan extension system, v1.
 *
 * Extensions are ES modules that export an `activate` function (either as
 * the default export or a named `activate` export, optionally wrapped in an
 * object that also carries a `name`). `activate` receives a
 * {@link MikanExtensionApi} and registers hooks and tools.
 *
 * ```js
 * // extensions/audit.mjs
 * export default function activate(api) {
 *   api.on("tool_call", ({ toolName, args }) => {
 *     if (toolName === "bash" && String(args.command).includes("rm -rf /")) {
 *       return { block: true, reason: "destructive command" };
 *     }
 *   });
 * }
 * ```
 *
 * Hooks run in registration order. For hooks with results, the first
 * non-undefined result wins (v1 semantics; later versions may merge).
 * Hook errors are logged and never crash a run.
 */
import type { AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { CompactionEntry } from "../types.js";

export interface BeforeAgentStartHookEvent {
  prompt: string;
  images?: ImageContent[];
  systemPrompt: string;
}

export interface BeforeAgentStartHookResult {
  /** Replace the system prompt for this turn. */
  systemPrompt?: string;
}

export interface ToolCallHookEvent {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolCallHookResult {
  /** Block the tool call; the model receives an error tool result instead. */
  block?: boolean;
  reason?: string;
}

export interface ToolResultHookEvent {
  toolCallId: string;
  toolName: string;
  args: unknown;
  content: (TextContent | ImageContent)[];
  isError: boolean;
}

export interface MessageEndHookEvent {
  message: AgentMessage;
}

export interface TurnEndHookEvent {
  messages: AgentMessage[];
}

export interface SessionCompactHookEvent {
  entry: CompactionEntry;
  reason: "threshold" | "overflow" | "manual";
}

/** Map of hook names to handler signatures. */
export interface MikanHookMap {
  before_agent_start: (
    event: BeforeAgentStartHookEvent,
  ) =>
    | BeforeAgentStartHookResult
    | undefined
    | void
    | Promise<BeforeAgentStartHookResult | undefined | void>;
  tool_call: (
    event: ToolCallHookEvent,
  ) => ToolCallHookResult | undefined | void | Promise<ToolCallHookResult | undefined | void>;
  tool_result: (event: ToolResultHookEvent) => void | Promise<void>;
  message_end: (event: MessageEndHookEvent) => void | Promise<void>;
  turn_end: (event: TurnEndHookEvent) => void | Promise<void>;
  session_compact: (event: SessionCompactHookEvent) => void | Promise<void>;
}

export type MikanHookName = keyof MikanHookMap;

/** API handed to an extension's `activate` function. */
export interface MikanExtensionApi {
  /** Register a hook handler. */
  on<T extends MikanHookName>(hook: T, handler: MikanHookMap[T]): void;
  /** Contribute an additional agent tool. */
  registerTool(tool: AgentTool): void;
  /** Extension-scoped logging that lands in mikan's structured log. */
  log(message: string): void;
  /** Context about the conversation this harness instance serves. */
  readonly context: {
    readonly conversationId: string;
    readonly workspaceDir: string;
    readonly model: Model<Api>;
    readonly thinkingLevel: ThinkingLevel;
  };
}

export type MikanExtensionActivate = (api: MikanExtensionApi) => void | Promise<void>;

export interface MikanExtensionModule {
  name?: string;
  activate: MikanExtensionActivate;
}

export interface LoadedExtension {
  name: string;
  path: string;
}

export interface ExtensionLoadError {
  path: string;
  error: string;
}
