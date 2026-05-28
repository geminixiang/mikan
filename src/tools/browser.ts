import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { BrowserCommandType, BrowserExtensionManager } from "../browser-extension.js";

const browserSchema = Type.Object({
  label: Type.String({ description: "Brief description of the browser action (shown to user)" }),
  action: Type.Union([
    Type.Literal("list_tabs"),
    Type.Literal("open_tab"),
    Type.Literal("activate_tab"),
    Type.Literal("reload_tab"),
    Type.Literal("get_active_tab"),
    Type.Literal("screenshot"),
    Type.Literal("wait_for"),
    Type.Literal("reload_until"),
    Type.Literal("inspect_page"),
    Type.Literal("find_elements"),
    Type.Literal("find_iframes"),
  ]),
  url: Type.Optional(Type.String({ description: "URL for open_tab" })),
  tabId: Type.Optional(
    Type.Number({ description: "Chrome tab id for activate_tab/reload_tab/wait_for/find_*" }),
  ),
  windowId: Type.Optional(Type.Number({ description: "Chrome window id for screenshot" })),
  selector: Type.Optional(
    Type.String({ description: "CSS selector for wait_for / reload_until / find_elements" }),
  ),
  text: Type.Optional(Type.String({ description: "Visible text to wait for" })),
  srcIncludes: Type.Optional(
    Type.String({ description: "Substring to match against iframe src for find_iframes" }),
  ),
  maxResults: Type.Optional(Type.Number({ description: "Maximum results to return for find_*" })),
  timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds" })),
  intervalMs: Type.Optional(Type.Number({ description: "Polling interval in milliseconds" })),
  maxAttempts: Type.Optional(
    Type.Number({ description: "Maximum reload attempts for reload_until" }),
  ),
});

type BrowserToolParams = {
  label: string;
  action: BrowserCommandType;
  url?: string;
  tabId?: number;
  windowId?: number;
  selector?: string;
  text?: string;
  srcIncludes?: string;
  timeoutMs?: number;
  intervalMs?: number;
  maxAttempts?: number;
  maxResults?: number;
};

interface BrowserToolContext {
  conversationId: string;
  hostOutputDir: string;
  uploadFile?: (filePath: string, title?: string) => Promise<void>;
}

export function createBrowserTool(manager: BrowserExtensionManager): {
  tool: AgentTool<typeof browserSchema>;
  setBrowserContext: (context: BrowserToolContext) => void;
} {
  let context: BrowserToolContext | null = null;

  const tool: AgentTool<typeof browserSchema> = {
    name: "browser",
    label: "browser",
    description:
      "Operate the Chrome browser extension paired with this conversation. Use this when the user asks to inspect, open, refresh, wait on, query elements/iframes, or screenshot their browser. Requires the user to have paired via /pi-login browser.",
    parameters: browserSchema,
    execute: async (_toolCallId: string, params: BrowserToolParams, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("Operation aborted");
      if (!context) throw new Error("Browser tool context not configured");

      const payload: Record<string, unknown> = {};
      if (params.url) payload.url = params.url;
      if (params.tabId !== undefined) payload.tabId = params.tabId;
      if (params.windowId !== undefined) payload.windowId = params.windowId;
      if (params.selector !== undefined) payload.selector = params.selector;
      if (params.text !== undefined) payload.text = params.text;
      if (params.srcIncludes !== undefined) payload.srcIncludes = params.srcIncludes;
      if (params.timeoutMs !== undefined) payload.timeoutMs = params.timeoutMs;
      if (params.intervalMs !== undefined) payload.intervalMs = params.intervalMs;
      if (params.maxAttempts !== undefined) payload.maxAttempts = params.maxAttempts;
      if (params.maxResults !== undefined) payload.maxResults = params.maxResults;

      const { result } = await manager.enqueueAndWait(
        context.conversationId,
        params.action,
        payload,
      );
      if (!result.ok) throw new Error(result.error ?? "Browser command failed");

      const data = await maybeUploadScreenshot(context, result.data);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        details: data,
      };
    },
  };

  return {
    tool,
    setBrowserContext: (nextContext) => {
      context = nextContext;
    },
  };
}

async function maybeUploadScreenshot(context: BrowserToolContext, data: unknown): Promise<unknown> {
  if (!data || typeof data !== "object") return data;
  const obj = data as { dataUrl?: unknown; title?: unknown; url?: unknown };
  if (typeof obj.dataUrl !== "string") return data;
  const match = obj.dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!match) return data;

  mkdirSync(context.hostOutputDir, { recursive: true });
  const filePath = join(context.hostOutputDir, `browser-screenshot-${Date.now()}.png`);
  writeFileSync(filePath, Buffer.from(match[1], "base64"), { mode: 0o600 });
  if (context.uploadFile) {
    await context.uploadFile(
      filePath,
      typeof obj.title === "string" ? obj.title : "Browser screenshot",
    );
  }

  return {
    ...obj,
    dataUrl: undefined,
    screenshotPath: filePath,
    screenshotUploaded: !!context.uploadFile,
  };
}
