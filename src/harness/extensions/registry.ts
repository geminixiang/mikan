/**
 * Hook registry and dispatch for mikan extensions.
 *
 * The registry collects hook handlers and contributed tools from activated
 * extensions and dispatches events from the harness runner. Handler failures
 * are logged and swallowed so a broken extension cannot take down a run.
 */
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import * as log from "../../log.js";
import type {
  BeforeAgentStartHookEvent,
  BeforeAgentStartHookResult,
  ContextHookEvent,
  ExtensionBlockAction,
  ExtensionBlockActionHandler,
  ExtensionCommand,
  ExtensionCommandContext,
  ExtensionDisposer,
  ExtensionScheduleCallbackEvent,
  ExtensionScheduleCallbackHandler,
  MessageEndHookEvent,
  MessageEndHookResult,
  MikanHookMap,
  MikanHookName,
  ToolResultHookEvent,
  ToolResultHookResult,
} from "./types.js";

const COMMAND_NAME_PATTERN = /^[a-z0-9_-]+$/i;

/**
 * Parse `/name args…` slash-command text. Returns undefined when the text is
 * not a slash command with a valid name (`COMMAND_NAME_PATTERN`).
 */
export function parseCommandInput(text: string): { name: string; args: string } | undefined {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const name = match?.[1];
  if (name === undefined || !COMMAND_NAME_PATTERN.test(name)) return undefined;
  return { name, args: match?.[2]?.trim() ?? "" };
}

type HookHandlers = {
  [T in MikanHookName]: Array<{ owner: string; handler: MikanHookMap[T] }>;
};

export class ExtensionRegistry {
  private handlers: HookHandlers = {
    before_agent_start: [],
    context: [],
    tool_call: [],
    tool_result: [],
    message_end: [],
    turn_end: [],
    session_compact: [],
    agent_error: [],
    budget_exceeded: [],
  };
  private tools: AgentTool[] = [];
  private commands = new Map<string, { owner: string; command: ExtensionCommand }>();
  /** Block action handlers keyed `<slug>\n<actionId>` (slug scopes, so no cross-extension dups). */
  private actions = new Map<string, { owner: string; handler: ExtensionBlockActionHandler }>();
  /** Schedule callback handlers keyed `<slug>\n<callbackName>`, mirroring actions. */
  private scheduleCallbacks = new Map<string, { handler: ExtensionScheduleCallbackHandler }>();
  private disposers: Array<{ owner: string; disposer: ExtensionDisposer }> = [];

  register<T extends MikanHookName>(owner: string, hook: T, handler: MikanHookMap[T]): void {
    this.handlers[hook].push({ owner, handler });
  }

  registerTool(tool: AgentTool): void {
    this.tools.push(tool);
  }

  /**
   * Register an extension command. Invalid names throw (surfaces as an
   * activation error for that extension); a duplicate name is logged and
   * ignored so the first registration wins, mirroring hook isolation.
   */
  registerCommand(owner: string, command: ExtensionCommand): void {
    if (!COMMAND_NAME_PATTERN.test(command.name)) {
      throw new Error(`Invalid extension command name: ${JSON.stringify(command.name)}`);
    }
    const key = command.name.toLowerCase();
    const existing = this.commands.get(key);
    if (existing) {
      log.logWarning(
        `Extension command "/${command.name}" already registered by ${existing.owner}`,
        `ignoring registration from ${owner}`,
      );
      return;
    }
    this.commands.set(key, { owner, command });
  }

  registerDisposer(owner: string, disposer: ExtensionDisposer): void {
    this.disposers.push({ owner, disposer });
  }

  /**
   * Register a block action handler for `actionId` under an extension slug.
   * A duplicate registration is logged and ignored (first wins), mirroring
   * command registration.
   */
  registerAction(slug: string, actionId: string, handler: ExtensionBlockActionHandler): void {
    if (!actionId) throw new Error("Extension block action id must be non-empty");
    const key = `${slug}\n${actionId}`;
    if (this.actions.has(key)) {
      log.logWarning(
        `Extension block action "${actionId}" already registered by ${slug}`,
        "ignoring duplicate registration",
      );
      return;
    }
    this.actions.set(key, { owner: slug, handler });
  }

  /**
   * Register a schedule callback handler under an extension slug. Invalid
   * names throw (an activation error for that extension); a duplicate
   * registration is logged and ignored (first wins), mirroring commands.
   */
  registerScheduleCallback(
    slug: string,
    callbackName: string,
    handler: ExtensionScheduleCallbackHandler,
  ): void {
    if (!COMMAND_NAME_PATTERN.test(callbackName)) {
      throw new Error(`Invalid schedule callback name: ${JSON.stringify(callbackName)}`);
    }
    const key = `${slug}\n${callbackName}`;
    if (this.scheduleCallbacks.has(key)) {
      log.logWarning(
        `Extension schedule callback "${callbackName}" already registered by ${slug}`,
        "ignoring duplicate registration",
      );
      return;
    }
    this.scheduleCallbacks.set(key, { handler });
  }

  /**
   * Run the handler for a fired callback schedule. Returns true when a
   * matching handler exists — including when it threw (the fire was
   * consumed; the error is logged).
   */
  async dispatchScheduleCallback(
    slug: string,
    callbackName: string,
    event: ExtensionScheduleCallbackEvent,
  ): Promise<boolean> {
    const entry = this.scheduleCallbacks.get(`${slug}\n${callbackName}`);
    if (!entry) return false;
    try {
      await entry.handler(event);
    } catch (err) {
      log.logWarning(
        `Extension schedule callback "${callbackName}" failed (${slug}, schedule "${event.scheduleName}")`,
        err instanceof Error ? err.message : String(err),
      );
    }
    return true;
  }

  /**
   * Run the handler for an extension-owned block action. Returns true when a
   * matching handler exists — including when it threw (the action was
   * consumed; the error is logged, never surfaced to the platform).
   */
  async dispatchAction(slug: string, action: ExtensionBlockAction): Promise<boolean> {
    const entry = this.actions.get(`${slug}\n${action.actionId}`);
    if (!entry) return false;
    try {
      await entry.handler(action);
    } catch (err) {
      log.logWarning(
        `Extension block action "${action.actionId}" failed (${entry.owner})`,
        err instanceof Error ? err.message : String(err),
      );
    }
    return true;
  }

  getContributedTools(): AgentTool[] {
    return [...this.tools];
  }

  /** Registered commands, for inventory surfaces. */
  getCommands(): ExtensionCommand[] {
    return [...this.commands.values()].map((entry) => entry.command);
  }

  /**
   * Run the handler for `/name`, if an extension registered it. Returns true
   * when a matching command exists — including when its handler threw (the
   * command was consumed; the error is logged and reported to the user).
   */
  async dispatchCommand(name: string, context: ExtensionCommandContext): Promise<boolean> {
    const entry = this.commands.get(name.toLowerCase());
    if (!entry) return false;
    try {
      await entry.command.handler(context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.logWarning(`Extension command "/${entry.command.name}" failed (${entry.owner})`, message);
      try {
        await context.respond(`Command /${entry.command.name} failed: ${message}`);
      } catch {
        // The reply channel itself failed; the log line above is the record.
      }
    }
    return true;
  }

  /**
   * Run all registered disposers in reverse registration order (LIFO).
   * Disposer errors are logged and never propagate. Idempotent: disposers
   * run once and the list is cleared.
   */
  async dispose(): Promise<void> {
    const disposers = this.disposers;
    this.disposers = [];
    for (const { owner, disposer } of disposers.toReversed()) {
      try {
        await disposer();
      } catch (err) {
        log.logWarning(
          `Extension disposer failed (${owner})`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
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
   * Dispatch `context` with Pi-compatible chaining semantics. Handlers receive
   * a call-local clone, so in-place mutations and returned replacements affect
   * only this LLM call and never the canonical transcript.
   */
  async emitContext(event: ContextHookEvent): Promise<AgentMessage[]> {
    let messages = structuredClone(event.messages);
    for (const { owner, handler } of this.handlers.context) {
      try {
        const result = await handler({ ...event, messages });
        if (result?.messages) messages = result.messages;
      } catch (err) {
        log.logWarning(
          `Extension hook "context" failed (${owner})`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return messages;
  }

  /**
   * Dispatch `message_end` with Pi-compatible chaining semantics. Each handler
   * sees the replacement from the previous handler. Role-changing replacements
   * are rejected because the agent lifecycle event role cannot be changed.
   */
  async emitMessageEnd(event: MessageEndHookEvent): Promise<MessageEndHookResult | undefined> {
    let message = event.message;
    let modified = false;
    for (const { owner, handler } of this.handlers.message_end) {
      try {
        const result = await handler({ ...event, message });
        if (!result?.message) continue;
        if (result.message.role !== message.role) {
          log.logWarning(
            `Extension hook "message_end" failed (${owner})`,
            "message_end handlers must return a message with the same role",
          );
          continue;
        }
        message = result.message;
        modified = true;
      } catch (err) {
        log.logWarning(
          `Extension hook "message_end" failed (${owner})`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return modified ? { message } : undefined;
  }

  /**
   * Dispatch `tool_result` with chaining semantics: each handler sees content,
   * details, isError, and usage as rewritten by earlier handlers, so e.g. a
   * redaction extension processes the output of upstream rewriters instead of
   * the original. Returns the accumulated override, or undefined when no
   * handler changed anything.
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
        if (result.details !== undefined) {
          merged.details = result.details;
          chained.details = result.details;
        }
        if (result.isError !== undefined) {
          merged.isError = result.isError;
          chained.isError = result.isError;
        }
        if (result.usage !== undefined) {
          merged.usage = result.usage;
          chained.usage = result.usage;
        }
      } catch (err) {
        log.logWarning(
          `Extension hook "tool_result" failed (${owner})`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return merged.content !== undefined ||
      merged.details !== undefined ||
      merged.isError !== undefined ||
      merged.usage !== undefined
      ? merged
      : undefined;
  }
}

/**
 * Action-id namespacing for extension-posted interactive messages.
 *
 * Blocks posted through `api.blockkit.post` get every `action_id` rewritten
 * to `ext:<slug>:<original>` so the platform adapter can route interactions
 * exclusively to the owning extension's `onAction` handlers (never into an
 * agent run). Model-posted blocks carry no prefix and keep the existing
 * conversation-event path; the two worlds cannot collide because extension
 * slugs are admin-controlled, filesystem-safe identifiers (no `:`).
 */

export const EXT_ACTION_PREFIX = "ext:";

/** Deep-clone blocks, rewriting every `action_id` to `ext:<slug>:<id>`. */
export function namespaceActionIds<T>(blocks: T, slug: string): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "action_id" && typeof value === "string") {
        out[key] = `${EXT_ACTION_PREFIX}${slug}:${value}`;
      } else {
        out[key] = walk(value);
      }
    }
    return out;
  };
  return walk(blocks) as T;
}

/** Parse an `ext:<slug>:<actionId>` routing id; null for non-extension actions. */
export function parseExtActionId(actionId: string): { slug: string; actionId: string } | null {
  if (!actionId.startsWith(EXT_ACTION_PREFIX)) return null;
  const rest = actionId.slice(EXT_ACTION_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { slug: rest.slice(0, separator), actionId: rest.slice(separator + 1) };
}
