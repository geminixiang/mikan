import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { BrowserCommandType } from "../browser-extension.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { replyWithContext } from "./utils.js";

function normalizeCommandText(text: string): string {
  return text
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/<((?:https?:\/\/)[^>|]+)(?:\|[^>]*)?>/g, "$1")
    .trim();
}

function parseBrowserCommand(text: string): { action: string; args: string[] } | undefined {
  const normalized = normalizeCommandText(text);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  const command = tokens[0].toLowerCase();

  if (
    (command === "/pi-login" || command === "/login" || command === "login") &&
    tokens[1]?.toLowerCase() === "browser"
  ) {
    return { action: "pair", args: tokens.slice(2) };
  }
  if (command === "browser" || command === "/browser" || command === "/pi-browser") {
    return { action: tokens[1]?.toLowerCase() || "help", args: tokens.slice(2) };
  }

  return undefined;
}

function summarizeResult(type: BrowserCommandType, data: unknown): string {
  if (type === "screenshot" && data && typeof data === "object") {
    const obj = data as { dataUrl?: unknown; url?: unknown; title?: unknown };
    const size = typeof obj.dataUrl === "string" ? Math.round(obj.dataUrl.length / 1024) : 0;
    return `Screenshot captured (${size} KB). URL: ${String(obj.url ?? "unknown")}`;
  }
  return "```json\n" + JSON.stringify(data ?? null, null, 2).slice(0, 3000) + "\n```";
}

async function uploadScreenshotIfPresent(context: CommandContext, data: unknown): Promise<boolean> {
  if (!data || typeof data !== "object") return false;
  const obj = data as { dataUrl?: unknown; title?: unknown };
  if (typeof obj.dataUrl !== "string") return false;
  const match = obj.dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!match) return false;

  const dir = join(context.services.workingDir, ".mama-browser-screenshots");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `browser-screenshot-${Date.now()}.png`);
  writeFileSync(path, Buffer.from(match[1], "base64"), { mode: 0o600 });
  await context.responseCtx.uploadFile(
    path,
    typeof obj.title === "string" ? obj.title : "Browser screenshot",
  );
  return true;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeDomainLikeMatch(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");
}

function normalizeSelectorForAutoLinkedUrls(selector: string): string {
  return selector.replace(/(\[src\*=(['"]))https?:\/\//gi, "$1");
}

export class BrowserCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    const parsed = parseBrowserCommand(context.commandText);
    if (!parsed) return false;

    const manager = context.services.browserExtensionManager;
    if (!manager) {
      await replyWithContext(context.responseCtx, "Browser extension support is not enabled.");
      return true;
    }

    if (parsed.action === "pair") {
      if (!context.services.portalBaseUrl) {
        await replyWithContext(
          context.responseCtx,
          "Browser pairing requires `MAMA_LINK_URL` or `MAMA_LINK_PORT`.",
        );
        return true;
      }
      const pairing = manager.createPairing(
        context.platform,
        context.platformUserId,
        context.conversationId,
      );
      await replyWithContext(
        context.responseCtx,
        `Pair your Mama Chrome extension with this conversation.\n\nServer: ${context.services.portalBaseUrl}\nPairing code: \`${pairing.code}\`\n\nCode expires in 10 minutes.`,
      );
      return true;
    }

    if (parsed.action === "list") {
      const browsers = manager.listForConversation(context.conversationId);
      await replyWithContext(
        context.responseCtx,
        browsers.length
          ? browsers
              .map((browser) => {
                const age = Math.round((Date.now() - browser.lastSeenAt) / 1000);
                return `- ${browser.browserId}${browser.name ? ` (${browser.name})` : ""}, last seen ${age}s ago`;
              })
              .join("\n")
          : "No paired browsers for this conversation.",
      );
      return true;
    }

    const commandMap: Record<string, BrowserCommandType> = {
      tabs: "list_tabs",
      open: "open_tab",
      active: "get_active_tab",
      reload: "reload_tab",
      screenshot: "screenshot",
      activate: "activate_tab",
      inspect: "inspect_page",
      wait: "wait_for",
      reloaduntil: "reload_until",
      "reload-until": "reload_until",
      find: "find_elements",
      iframes: "find_iframes",
    };
    const type = commandMap[parsed.action];
    if (!type) {
      await replyWithContext(
        context.responseCtx,
        "Browser commands: `/pi-login browser`, `browser list`, `browser tabs`, `browser open <url>`, `browser active`, `browser activate <tabId>`, `browser reload [tabId]`, `browser screenshot [windowId]`, `browser inspect`, `browser wait <selector-or-text>`, `browser reload-until <selector-or-text> [maxAttempts]`, `browser find <selector>`, `browser iframes [src-substring]`.",
      );
      return true;
    }

    const payload: Record<string, unknown> = {};
    if (type === "open_tab") {
      const url = normalizeCommandText(parsed.args.join(" ")).replace(/^<|>$/g, "").trim();
      if (!/^https?:\/\//i.test(url)) {
        await replyWithContext(context.responseCtx, "Usage: `browser open https://example.com`.");
        return true;
      }
      payload.url = url;
    }
    if (type === "reload_tab" || type === "activate_tab") {
      const tabId = parsePositiveInt(parsed.args[0]);
      if (tabId) payload.tabId = tabId;
      if (type === "activate_tab" && !tabId) {
        await replyWithContext(context.responseCtx, "Usage: `browser activate <tabId>`.");
        return true;
      }
    }
    if (type === "screenshot") {
      const windowId = parsePositiveInt(parsed.args[0]);
      if (windowId) payload.windowId = windowId;
    }
    if (type === "wait_for") {
      const query = normalizeCommandText(parsed.args.join(" ")).trim();
      if (!query) {
        await replyWithContext(
          context.responseCtx,
          "Usage: `browser wait <selector>` or `browser wait text:Player loaded`.",
        );
        return true;
      }
      if (query.startsWith("text:")) payload.text = query.slice(5);
      else payload.selector = query;
      payload.timeoutMs = 15000;
    }
    if (type === "reload_until") {
      const [firstArg, secondArg] = parsed.args;
      const query = normalizeCommandText(firstArg || "").trim();
      if (!query) {
        await replyWithContext(
          context.responseCtx,
          "Usage: `browser reload-until <selector>` or `browser reload-until text:Player loaded [maxAttempts]`.",
        );
        return true;
      }
      if (query.startsWith("text:")) payload.text = query.slice(5);
      else payload.selector = query;
      const maxAttempts = parsePositiveInt(secondArg);
      if (maxAttempts) payload.maxAttempts = maxAttempts;
    }
    if (type === "find_elements") {
      const selector = normalizeSelectorForAutoLinkedUrls(
        normalizeCommandText(parsed.args.join(" ")).trim(),
      );
      if (!selector) {
        await replyWithContext(
          context.responseCtx,
          'Usage: `browser find iframe[src*="player.gliacloud.com"]`.',
        );
        return true;
      }
      payload.selector = selector;
    }
    if (type === "find_iframes") {
      const srcIncludes = normalizeDomainLikeMatch(normalizeCommandText(parsed.args.join(" ")));
      if (srcIncludes) payload.srcIncludes = srcIncludes;
    }

    await replyWithContext(context.responseCtx, `Sending browser command: ${type} ...`);
    try {
      const { result } = await manager.enqueueAndWait(context.conversationId, type, payload);
      if (!result.ok) {
        await replyWithContext(
          context.responseCtx,
          `Browser command failed: ${result.error ?? "unknown error"}`,
        );
        return true;
      }
      const uploaded =
        type === "screenshot" ? await uploadScreenshotIfPresent(context, result.data) : false;
      await replyWithContext(
        context.responseCtx,
        `${summarizeResult(type, result.data)}${uploaded ? "\nUploaded screenshot." : ""}`,
      );
    } catch (error) {
      await replyWithContext(
        context.responseCtx,
        error instanceof Error ? error.message : String(error),
      );
    }
    return true;
  }
}
