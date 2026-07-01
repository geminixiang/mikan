/**
 * Hook registry and dispatch for mikan extensions.
 *
 * The registry collects hook handlers and contributed tools from activated
 * extensions and dispatches events from the harness runner. Handler failures
 * are logged and swallowed so a broken extension cannot take down a run.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import * as log from "../../log.js";
import type { MikanHookMap, MikanHookName } from "./types.js";

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
}
