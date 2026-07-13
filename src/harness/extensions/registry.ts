/**
 * Hook registry and dispatch for mikan extensions.
 *
 * The registry collects hook handlers and contributed tools from activated
 * extensions and dispatches events from the harness runner. Handler failures
 * are logged and swallowed so a broken extension cannot take down a run.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import * as log from "../../log.js";
import type {
  BeforeAgentStartHookEvent,
  BeforeAgentStartHookResult,
  MikanHookMap,
  MikanHookName,
  ToolResultHookEvent,
  ToolResultHookResult,
} from "./types.js";

type HookHandlers = {
  [T in MikanHookName]: Array<{ owner: string; handler: MikanHookMap[T] }>;
};

export class ExtensionRegistry {
  private handlers: HookHandlers = {
    before_agent_start: [],
    tool_call: [],
    tool_result: [],
    message_end: [],
    turn_end: [],
    session_compact: [],
  };
  private tools: AgentTool[] = [];

  register<T extends MikanHookName>(owner: string, hook: T, handler: MikanHookMap[T]): void {
    this.handlers[hook].push({ owner, handler });
  }

  registerTool(tool: AgentTool): void {
    this.tools.push(tool);
  }

  getContributedTools(): AgentTool[] {
    return [...this.tools];
  }

  hasHandlers(hook: MikanHookName): boolean {
    return this.handlers[hook].length > 0;
  }

  /**
   * Run handlers in registration order. Returns the first non-undefined
   * result. Handler errors are logged and skipped.
   */
  async emit<T extends MikanHookName>(
    hook: T,
    event: Parameters<MikanHookMap[T]>[0],
  ): Promise<Awaited<ReturnType<MikanHookMap[T]>> | undefined> {
    for (const { owner, handler } of this.handlers[hook]) {
      try {
        const result = await (handler as (input: unknown) => unknown)(event);
        if (result !== undefined) {
          return result as Awaited<ReturnType<MikanHookMap[T]>>;
        }
      } catch (err) {
        log.logWarning(
          `Extension hook "${hook}" failed (${owner})`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return undefined;
  }

  /**
   * Dispatch `before_agent_start` with merge semantics: `systemPrompt` and
   * `prompt` rewrites chain (each handler sees the event as rewritten by
   * earlier handlers), while `block` from ANY handler wins so a policy
   * extension cannot be shadowed by registration order. The first block's
   * reason is kept. Returns undefined when no handler changed anything.
   */
  async emitBeforeAgentStart(
    event: BeforeAgentStartHookEvent,
  ): Promise<BeforeAgentStartHookResult | undefined> {
    const chained: BeforeAgentStartHookEvent = { ...event };
    const merged: BeforeAgentStartHookResult = {};
    for (const { owner, handler } of this.handlers.before_agent_start) {
      try {
        const result = await handler(chained);
        if (!result) continue;
        if (result.systemPrompt !== undefined) {
          merged.systemPrompt = result.systemPrompt;
          chained.systemPrompt = result.systemPrompt;
        }
        if (result.prompt !== undefined) {
          merged.prompt = result.prompt;
          chained.prompt = result.prompt;
        }
        if (result.block && !merged.block) {
          merged.block = true;
          merged.reason = result.reason;
        }
      } catch (err) {
        log.logWarning(
          `Extension hook "before_agent_start" failed (${owner})`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return merged.systemPrompt !== undefined || merged.prompt !== undefined || merged.block
      ? merged
      : undefined;
  }

  /**
   * Dispatch `tool_result` with chaining semantics: each handler sees the
   * content/isError as rewritten by earlier handlers, so e.g. a redaction
   * extension processes the output of upstream rewriters instead of the
   * original. Returns the accumulated override, or undefined when no handler
   * changed anything.
   */
  async emitToolResult(event: ToolResultHookEvent): Promise<ToolResultHookResult | undefined> {
    const chained: ToolResultHookEvent = { ...event };
    const merged: ToolResultHookResult = {};
    for (const { owner, handler } of this.handlers.tool_result) {
      try {
        const result = await handler(chained);
        if (!result) continue;
        if (result.content !== undefined) {
          merged.content = result.content;
          chained.content = result.content;
        }
        if (result.isError !== undefined) {
          merged.isError = result.isError;
          chained.isError = result.isError;
        }
      } catch (err) {
        log.logWarning(
          `Extension hook "tool_result" failed (${owner})`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return merged.content !== undefined || merged.isError !== undefined ? merged : undefined;
  }
}
