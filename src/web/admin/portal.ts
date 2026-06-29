import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { homedir } from "os";
import { basename, join, resolve as pathResolve, sep as pathSep } from "path";
import { AuthStorage } from "../../harness/auth-storage.js";
import { ModelRegistry } from "../../harness/model-registry.js";
import { SessionManager } from "../../harness/session-manager.js";

import {
  loadConversationAutoReplyConfig,
  loadGlobalSettings,
  resolveConversationSettings,
  saveConversationAutoReplyConfig,
  updateConversationSettings,
  updateGlobalSettings,
  type AgentConfig,
} from "../../config.js";
import { escapeHtml } from "../../utils/html.js";
import { readRawBody } from "../../utils/http-body.js";
import { renderPortalShell } from "../../portal-shell.js";
import { resolveExistingSessionFile } from "../session-view/service.js";
import { PRODUCT_NAME } from "../../platform-messages.js";
import { resolveActorVaultKey } from "../../vault/routing.js";
import { sharedVaultKey } from "../../vault/index.js";
import { modelKey, resolveAdminModelAccessStatuses } from "./provider-models.js";
import type { AdminToken } from "./store.js";

export type { AdminRuntimeBridge, AdminServices } from "./types.js";
import type { AdminServices } from "./types.js";

// ── Handler ────────────────────────────────────────────────────────────────────

export async function handleAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  services: AdminServices,
): Promise<boolean> {
  if (!url.pathname.startsWith("/admin")) return false;

  if (req.method === "GET" && url.pathname === "/admin") {
    const provided = url.searchParams.get("token") ?? "";
    const token = services.adminTokenStore.peek(provided);
    if (!token) {
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        renderAdminErrorPage(
          "Admin link is missing, invalid, or expired. Send `/admin` to the bot to get a fresh link.",
        ),
      );
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(renderAdminPage(token));
    return true;
  }

  if (url.pathname.startsWith("/admin/api/")) {
    await routeApiRequest(req, res, url, services);
    return true;
  }

  return false;
}

// ── API routing ────────────────────────────────────────────────────────────────

async function routeApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  services: AdminServices,
): Promise<void> {
  if (req.method === "GET") {
    const token = services.adminTokenStore.peek(url.searchParams.get("token") ?? "");
    if (!token) {
      jsonRes(res, 403, { error: "Unauthorized" });
      return;
    }
    if (url.pathname === "/admin/api/me") {
      serveMe(res, token);
      return;
    }
    if (url.pathname === "/admin/api/conversations") {
      serveConversationsList(res, services);
      return;
    }
    if (url.pathname === "/admin/api/session-usage") {
      serveSessionUsage(res, services);
      return;
    }
    if (url.pathname === "/admin/api/conversation-state") {
      serveConversationState(res, url, services, token);
      return;
    }
    if (url.pathname === "/admin/api/settings/global") {
      serveGlobalSettings(res);
      return;
    }
    if (url.pathname === "/admin/api/models") {
      void serveModelsList(res);
      return;
    }
    if (url.pathname === "/admin/api/workspace/tree") {
      serveWorkspaceTree(res, url, services, token);
      return;
    }
    if (url.pathname === "/admin/api/workspace/file") {
      serveWorkspaceFile(res, url, services, token);
      return;
    }
    if (url.pathname === "/admin/api/skills") {
      serveSkillsList(res, url, services, token);
      return;
    }
    if (url.pathname === "/admin/api/skills/file") {
      serveSkillFile(res, url, services, token);
      return;
    }
    if (url.pathname === "/admin/api/events") {
      serveEventsList(res, services);
      return;
    }
    if (url.pathname === "/admin/api/events/file") {
      serveEventsFile(res, url, services);
      return;
    }
    if (url.pathname === "/admin/api/conversations/events") {
      serveConversationEventsList(res, url, services, token);
      return;
    }
    jsonRes(res, 404, { error: "Not found" });
    return;
  }

  if (req.method !== "POST") {
    jsonRes(res, 405, { error: "Method not allowed" });
    return;
  }

  const body = await readJsonBody(req, res);
  if (!body) return;

  const rawToken = typeof body.token === "string" ? body.token : "";
  const token = services.adminTokenStore.peek(rawToken);
  if (!token) {
    jsonRes(res, 403, { error: "Unauthorized" });
    return;
  }
  if (url.pathname === "/admin/api/conversations/model") {
    serveConversationModelUpdate(res, body, services, token);
    return;
  }
  if (url.pathname === "/admin/api/conversations/sandbox") {
    serveConversationSandboxUpdate(res, body, services, token);
    return;
  }
  if (url.pathname === "/admin/api/conversations/auto-reply") {
    serveConversationAutoReplyUpdate(res, body, services, token);
    return;
  }
  if (url.pathname === "/admin/api/conversations/slack") {
    serveConversationSlackUpdate(res, body, services, token);
    return;
  }
  if (url.pathname === "/admin/api/conversations/session-link") {
    serveConversationSessionLink(res, body, services, token);
    return;
  }
  if (url.pathname === "/admin/api/conversations/login-link") {
    serveConversationLoginLink(res, body, services, token);
    return;
  }
  if (url.pathname === "/admin/api/conversations/events/delete") {
    serveConversationEventDelete(res, body, services, token);
    return;
  }
  if (url.pathname === "/admin/api/settings/model") {
    serveGlobalModelUpdate(res, body);
    return;
  }
  if (url.pathname === "/admin/api/settings/sandbox") {
    serveGlobalSandboxUpdate(res, body);
    return;
  }
  if (url.pathname === "/admin/api/settings/slack") {
    serveGlobalSlackUpdate(res, body);
    return;
  }
  jsonRes(res, 404, { error: "Not found" });
}

// ── Scope helpers ──────────────────────────────────────────────────────────────

function resolveConversationId(
  requested: string,
  token: AdminToken,
): { conversationId: string; error?: string } {
  if (!requested) return { conversationId: token.conversationId };
  if (requested === token.conversationId) return { conversationId: requested };
  if (requested.includes("/") || requested.includes("..")) {
    return { conversationId: requested, error: "Invalid conversationId." };
  }
  return { conversationId: requested };
}

function resolveTargetConversation(
  body: Record<string, unknown>,
  token: AdminToken,
): { conversationId: string; error?: string } {
  const requested = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  return resolveConversationId(requested, token);
}

function requireAdminWorkingDir(res: ServerResponse, services: AdminServices): string | null {
  if (!services.workingDir) {
    jsonRes(res, 503, { error: "Working directory not available" });
    return null;
  }
  return services.workingDir;
}

// ── API handlers ───────────────────────────────────────────────────────────────

function serveMe(res: ServerResponse, token: AdminToken): void {
  jsonRes(res, 200, {
    platform: token.platform,
    platformUserId: token.platformUserId,
    platformUserName: token.platformUserName ?? null,
    conversationId: token.conversationId,
    expiresAt: token.expiresAt,
  });
}

const SETTINGS_FILES = new Set(["settings.json", "auto-reply", "auto-reply.disabled"]);

function listConversationDirs(workingDir: string): string[] {
  if (!existsSync(workingDir)) return [];
  const skip = new Set(["vaults", "skills", "events", "node_modules", ".git"]);
  return readdirSync(workingDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !skip.has(entry.name))
    .map((entry) => entry.name)
    .filter((name) => {
      const dir = join(workingDir, name);
      try {
        const items = readdirSync(dir);
        return items.some((item) => SETTINGS_FILES.has(item) || item.endsWith(".jsonl"));
      } catch {
        return false;
      }
    })
    .toSorted((a, b) => a.localeCompare(b));
}

function conversationLastActivity(workingDir: string, conversationId: string): number | null {
  const dir = join(workingDir, conversationId);
  if (!existsSync(dir)) return null;
  let latest = 0;
  const visit = (path: string, depth: number): void => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      try {
        const stats = statSync(full);
        if (stats.mtimeMs > latest) latest = stats.mtimeMs;
      } catch {
        // ignore
      }
    }
  };
  visit(dir, 0);
  return latest > 0 ? latest : null;
}

function conversationDisplayLabel(services: AdminServices, conversationId: string): string {
  for (const [platform, bot] of Object.entries(services.botsByPlatform ?? {})) {
    const channel = bot?.getMessagingInfo().channels.find((c) => c.id === conversationId);
    if (channel) return `${platform}:#${channel.name}:${conversationId}`;
  }
  return conversationId;
}

function serveConversationsList(res: ServerResponse, services: AdminServices): void {
  const workingDir = requireAdminWorkingDir(res, services);
  if (!workingDir) return;

  const ids = listConversationDirs(workingDir);

  const runningKeys = new Set<string>(
    services.runtime?.getRunningSessions().map((s) => s.sessionKey) ?? [],
  );

  const conversations = ids.map((conversationId) => {
    const lastActivity = conversationLastActivity(workingDir, conversationId);
    const running = Array.from(runningKeys).some(
      (key) => key === conversationId || key.startsWith(`${conversationId}:`),
    );
    return {
      conversationId,
      label: conversationDisplayLabel(services, conversationId),
      running,
      lastActivityAt: lastActivity,
    };
  });

  jsonRes(res, 200, { conversations });
}

interface SessionUsageRow {
  conversationId: string;
  label: string;
  fileName: string;
  sessionId: string;
  updatedAt: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

function serveSessionUsage(res: ServerResponse, services: AdminServices): void {
  const workingDir = requireAdminWorkingDir(res, services);
  if (!workingDir) return;

  const rows = listConversationDirs(workingDir)
    .flatMap((conversationId) =>
      listConversationSessionUsage(
        workingDir,
        conversationId,
        conversationDisplayLabel(services, conversationId),
      ),
    )
    .toSorted((a, b) => b.total - a.total)
    .slice(0, 20);

  jsonRes(res, 200, { sessions: rows });
}

function listConversationSessionUsage(
  workingDir: string,
  conversationId: string,
  label: string,
): SessionUsageRow[] {
  const sessionDir = join(workingDir, conversationId, "sessions");
  try {
    return readdirSync(sessionDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .flatMap((entry) => readSessionUsage(join(sessionDir, entry.name), conversationId, label));
  } catch {
    return [];
  }
}

function readSessionUsage(
  sessionFile: string,
  conversationId: string,
  label: string,
): SessionUsageRow[] {
  try {
    const manager = SessionManager.open(sessionFile);
    const header = manager.getHeader();
    if (!header) return [];

    const entries = manager.getEntries();
    const usage = entries.reduce(
      (sum, entry) => {
        if (entry.type !== "message" || entry.message.role !== "assistant") return sum;
        const message = entry.message as unknown as AssistantUsageMessage;
        const item = message.usage;
        if (!item) return sum;
        sum.input += numberOrZero(item.input);
        sum.output += numberOrZero(item.output);
        sum.cacheRead += numberOrZero(item.cacheRead);
        sum.cacheWrite += numberOrZero(item.cacheWrite);
        sum.cost += numberOrZero(item.cost?.total);
        return sum;
      },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    );
    const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    if (total <= 0) return [];

    return [
      {
        conversationId,
        label,
        fileName: basename(sessionFile),
        sessionId: header.id,
        updatedAt: entries.at(-1)?.timestamp ?? header.timestamp,
        ...usage,
        total,
      },
    ];
  } catch {
    return [];
  }
}

interface AssistantUsageMessage {
  usage?: {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    cost?: { total?: unknown };
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function serveConversationState(
  res: ServerResponse,
  url: URL,
  services: AdminServices,
  token: AdminToken,
): void {
  const workingDir = requireAdminWorkingDir(res, services);
  if (!workingDir) return;

  const requested = url.searchParams.get("conversationId")?.trim() ?? "";
  const conversationId = requested || token.conversationId;
  if (conversationId.includes("/") || conversationId.includes("..")) {
    jsonRes(res, 400, { error: "Invalid conversationId" });
    return;
  }

  const dir = join(workingDir, conversationId);
  const globalConfig = loadGlobalSettings();
  const conversationConfig = resolveConversationSettings(dir);
  const autoReply = loadConversationAutoReplyConfig(dir);

  jsonRes(res, 200, {
    conversationId,
    provider: conversationConfig.provider,
    model: conversationConfig.model,
    thinkingLevel: conversationConfig.thinkingLevel,
    globalProvider: globalConfig.provider,
    globalModel: globalConfig.model,
    globalThinkingLevel: globalConfig.thinkingLevel,
    sandboxImageWorkspaceMount: conversationConfig.sandboxImageWorkspaceMount ?? null,
    globalSandboxImageWorkspaceMount: globalConfig.sandboxImageWorkspaceMount ?? null,
    autoReplyEnabled: autoReply.enabled,
    autoReplyRules: autoReply.rules,
    slack: {
      replyMode:
        conversationConfig.slack?.replyMode ?? globalConfig.slack?.replyMode ?? "top-level",
      globalReplyMode: globalConfig.slack?.replyMode ?? "top-level",
    },
  });
}

function serveGlobalSettings(res: ServerResponse): void {
  try {
    const config = loadGlobalSettings();
    jsonRes(res, 200, {
      provider: config.provider,
      model: config.model,
      thinkingLevel: config.thinkingLevel,
      sandboxCpus: config.sandboxCpus ?? null,
      sandboxMemory: config.sandboxMemory ?? null,
      sandboxBoostCpus: config.sandboxBoostCpus ?? null,
      sandboxBoostMemory: config.sandboxBoostMemory ?? null,
      sandboxImageWorkspaceMount: config.sandboxImageWorkspaceMount ?? null,
      defaultSharedVault: config.defaultSharedVault ?? null,
      slack: {
        replyMode: config.slack?.replyMode ?? "top-level",
      },
    });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function serveModelsList(res: ServerResponse): Promise<void> {
  try {
    const authStorage = AuthStorage.create(join(homedir(), ".pi", "mikan", "auth.json"));
    const registry = ModelRegistry.create(authStorage);
    const availableModels = await registry.getAvailable();
    const statuses = await resolveAdminModelAccessStatuses(registry, availableModels);
    const models = availableModels.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name ?? model.id,
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      status: statuses.get(modelKey(model.provider, model.id))?.status ?? "available",
    }));
    jsonRes(res, 200, { models });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function serveConversationModelUpdate(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
  token: AdminToken,
): void {
  const provider = typeof body.provider === "string" ? body.provider.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const thinkingLevel =
    typeof body.thinkingLevel === "string" && VALID_THINKING_LEVELS.has(body.thinkingLevel)
      ? (body.thinkingLevel as AgentConfig["thinkingLevel"])
      : undefined;

  if (!provider || !model) {
    jsonRes(res, 400, { error: "Missing provider or model" });
    return;
  }
  const scope = resolveTargetConversation(body, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return;
  }
  const workingDir = requireAdminWorkingDir(res, services);
  if (!workingDir) return;
  const dir = join(workingDir, scope.conversationId);

  try {
    updateConversationSettings(dir, {
      provider,
      model,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
    let runtimeSwitched: boolean | null = null;
    if (services.runtime) {
      runtimeSwitched = services.runtime.switchConversationModel(
        scope.conversationId,
        provider,
        model,
      );
    }
    jsonRes(res, 200, { ok: true, runtimeSwitched });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function serveConversationSandboxUpdate(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
  token: AdminToken,
): void {
  const workspaceMount = body.workspaceMount;
  if (workspaceMount !== "private" && workspaceMount !== "full") {
    jsonRes(res, 400, { error: "workspaceMount must be 'private' or 'full'" });
    return;
  }
  const scope = resolveTargetConversation(body, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return;
  }
  const workingDir = requireAdminWorkingDir(res, services);
  if (!workingDir) return;
  const dir = join(workingDir, scope.conversationId);
  try {
    updateConversationSettings(dir, { sandboxImageWorkspaceMount: workspaceMount });
    jsonRes(res, 200, { ok: true });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function serveConversationSlackUpdate(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
  token: AdminToken,
): void {
  const replyMode = body.replyMode;
  if (replyMode !== "top-level" && replyMode !== "thread") {
    jsonRes(res, 400, { error: "replyMode must be 'top-level' or 'thread'" });
    return;
  }
  const scope = resolveTargetConversation(body, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return;
  }
  const workingDir = requireAdminWorkingDir(res, services);
  if (!workingDir) return;
  const dir = join(workingDir, scope.conversationId);
  try {
    updateConversationSettings(dir, { slack: { replyMode } });
    jsonRes(res, 200, { ok: true });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function serveConversationAutoReplyUpdate(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
  token: AdminToken,
): void {
  const enabled = body.enabled === true;
  const rules = body.rules;
  if (
    rules !== undefined &&
    (!Array.isArray(rules) || rules.some((rule) => typeof rule !== "string"))
  ) {
    jsonRes(res, 400, { error: "rules must be an array of strings" });
    return;
  }
  const scope = resolveTargetConversation(body, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return;
  }
  const workingDir = requireAdminWorkingDir(res, services);
  if (!workingDir) return;
  const dir = join(workingDir, scope.conversationId);
  try {
    const existing = loadConversationAutoReplyConfig(dir);
    saveConversationAutoReplyConfig(dir, {
      enabled,
      rules: rules ?? existing.rules,
    });
    jsonRes(res, 200, { ok: true });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function serveConversationSessionLink(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
  token: AdminToken,
): void {
  const scope = resolveTargetConversation(body, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return;
  }
  const workingDir = requireAdminWorkingDir(res, services);
  if (!workingDir) return;
  if (!services.sessionViewTokenStore) {
    jsonRes(res, 503, { error: "Session view token store not available" });
    return;
  }
  if (!services.portalBaseUrl) {
    jsonRes(res, 503, {
      error: "Portal URL not configured. Set MIKAN_LINK_URL to enable link generation.",
    });
    return;
  }

  const sessionFile = resolveExistingSessionFile(
    workingDir,
    scope.conversationId,
    scope.conversationId,
  );
  if (!sessionFile) {
    jsonRes(res, 404, { error: "No session file found for this conversation" });
    return;
  }

  try {
    const { token: viewToken } = services.sessionViewTokenStore.create(
      token.platform,
      token.platformUserId,
      scope.conversationId,
      scope.conversationId,
      sessionFile,
      token.platformUserName,
    );
    const url = `${services.portalBaseUrl}/session?token=${encodeURIComponent(viewToken)}`;
    jsonRes(res, 200, { ok: true, url });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function serveConversationLoginLink(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
  token: AdminToken,
): void {
  const scope = resolveTargetConversation(body, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return;
  }
  if (!services.portalBaseUrl) {
    jsonRes(res, 503, { error: "Portal URL not configured." });
    return;
  }
  if (!services.sandbox) {
    jsonRes(res, 503, { error: "Sandbox config not available." });
    return;
  }
  const sharedName = typeof body.sharedVault === "string" ? body.sharedVault.trim() : "";
  let vaultId: string;
  if (sharedName) {
    const key = sharedVaultKey(sharedName);
    if (!key) {
      jsonRes(res, 400, { error: "Invalid shared vault name" });
      return;
    }
    vaultId = key;
  } else {
    try {
      vaultId = resolveActorVaultKey(services.sandbox, token.platformUserId, scope.conversationId);
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
  }
  try {
    const { token: linkToken } = services.linkTokenStore.create(
      token.platform,
      token.platformUserId,
      scope.conversationId,
      vaultId,
      "",
    );
    const url = `${services.portalBaseUrl}/link?token=${encodeURIComponent(linkToken)}`;
    jsonRes(res, 200, { ok: true, url, vaultId });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function serveGlobalModelUpdate(res: ServerResponse, body: Record<string, unknown>): void {
  const provider = typeof body.provider === "string" ? body.provider.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const thinkingLevel =
    typeof body.thinkingLevel === "string" && VALID_THINKING_LEVELS.has(body.thinkingLevel)
      ? (body.thinkingLevel as AgentConfig["thinkingLevel"])
      : undefined;

  if (!provider || !model) {
    jsonRes(res, 400, { error: "Missing provider or model" });
    return;
  }

  try {
    updateGlobalSettings({
      provider,
      model,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
    jsonRes(res, 200, { ok: true });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function serveGlobalSlackUpdate(res: ServerResponse, body: Record<string, unknown>): void {
  const replyMode = body.replyMode;
  if (replyMode !== "top-level" && replyMode !== "thread") {
    jsonRes(res, 400, { error: "replyMode must be 'top-level' or 'thread'" });
    return;
  }

  try {
    updateGlobalSettings({ slack: { replyMode } });
    jsonRes(res, 200, { ok: true });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function serveGlobalSandboxUpdate(res: ServerResponse, body: Record<string, unknown>): void {
  const cpus = typeof body.cpus === "string" ? body.cpus.trim() : "";
  const memory = typeof body.memory === "string" ? body.memory.trim() : "";
  const boostCpus = typeof body.boostCpus === "string" ? body.boostCpus.trim() : "";
  const boostMemory = typeof body.boostMemory === "string" ? body.boostMemory.trim() : "";
  const workspaceMount = body.workspaceMount;
  const validMount = workspaceMount === "private" || workspaceMount === "full";

  const update: Partial<AgentConfig> = {};
  if (cpus) update.sandboxCpus = cpus;
  if (memory) update.sandboxMemory = memory;
  if (boostCpus) update.sandboxBoostCpus = boostCpus;
  if (boostMemory) update.sandboxBoostMemory = boostMemory;
  if (validMount) update.sandboxImageWorkspaceMount = workspaceMount as "private" | "full";

  if (Object.keys(update).length === 0) {
    jsonRes(res, 400, { error: "No valid sandbox fields provided" });
    return;
  }

  try {
    updateGlobalSettings(update);
    jsonRes(res, 200, { ok: true });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Workspace ──────────────────────────────────────────────────────────────────

const WORKSPACE_TREE_MAX_DEPTH = 4;
const WORKSPACE_TREE_MAX_ENTRIES = 800;
const PREVIEW_FILE_MAX_BYTES = 256 * 1024;

const WORKSPACE_TOP_FILES = new Set(["auto-reply", "auto-reply.disabled"]);
const WORKSPACE_TOP_DIRS = new Set(["scratch"]);

/**
 * Limit what the admin UI can browse under a conversation directory.
 * Allowed: top-level "scratch/" subtree, and the two auto-reply marker files.
 */
function isWorkspacePathAllowed(rel: string): boolean {
  if (rel === "") return true;
  const segments = rel.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  const first = segments[0];
  if (segments.length === 1) {
    return WORKSPACE_TOP_DIRS.has(first) || WORKSPACE_TOP_FILES.has(first);
  }
  return WORKSPACE_TOP_DIRS.has(first);
}

function resolveConversationFromQuery(
  url: URL,
  token: AdminToken,
): { conversationId: string; error?: string } {
  const requested = (url.searchParams.get("conversationId") ?? "").trim();
  return resolveConversationId(requested, token);
}

interface SafePathResult {
  absolute: string;
  error?: string;
}

function safeJoinUnderRoot(rootDir: string, relative: string): SafePathResult {
  if (relative.startsWith("/") || relative.includes("\0")) {
    return { absolute: "", error: "Invalid path" };
  }
  if (relative.split(/[\\/]+/).some((part) => part === ".." || part === "")) {
    if (relative !== "") return { absolute: "", error: "Invalid path" };
  }
  const target = pathResolve(rootDir, relative);
  const rootAbs = pathResolve(rootDir);
  if (target !== rootAbs && !target.startsWith(rootAbs + pathSep)) {
    return { absolute: "", error: "Path escapes conversation directory" };
  }
  return { absolute: target };
}

interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
  mtimeMs?: number;
  children?: TreeNode[];
  truncated?: boolean;
}

function buildTree(startDir: string, relPrefix: string): TreeNode | null {
  let counter = { value: 0 };
  const walk = (dir: string, rel: string, depth: number): TreeNode | null => {
    if (counter.value >= WORKSPACE_TREE_MAX_ENTRIES) return null;
    let stats;
    try {
      stats = statSync(dir);
    } catch {
      return null;
    }
    const name = rel === "" ? "." : basename(rel);
    if (!stats.isDirectory()) {
      counter.value += 1;
      return {
        name,
        path: rel,
        type: "file",
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      };
    }
    counter.value += 1;
    if (depth >= WORKSPACE_TREE_MAX_DEPTH) {
      return { name, path: rel, type: "dir", truncated: true };
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return { name, path: rel, type: "dir" };
    }
    const children: TreeNode[] = [];
    let truncated = false;
    for (const entry of entries.toSorted((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    })) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (!isWorkspacePathAllowed(childRel)) continue;
      if (counter.value >= WORKSPACE_TREE_MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const node = walk(join(dir, entry.name), childRel, depth + 1);
      if (node) children.push(node);
    }
    return {
      name,
      path: rel,
      type: "dir",
      children,
      ...(truncated ? { truncated: true } : {}),
    };
  };
  const node = walk(startDir, relPrefix, 0);
  return node;
}

function serveWorkspaceTree(
  res: ServerResponse,
  url: URL,
  services: AdminServices,
  token: AdminToken,
): void {
  const scope = resolveConversationFromQuery(url, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return;
  }
  const workingDir = requireAdminWorkingDir(res, services);
  if (!workingDir) return;
  const convDir = join(workingDir, scope.conversationId);
  if (!existsSync(convDir)) {
    jsonRes(res, 200, { conversationId: scope.conversationId, tree: null });
    return;
  }
  const requestedSub = (url.searchParams.get("path") ?? "").trim();
  if (!isWorkspacePathAllowed(requestedSub)) {
    jsonRes(res, 403, { error: "Workspace path is not exposed" });
    return;
  }
  const startSafe = safeJoinUnderRoot(convDir, requestedSub);
  if (startSafe.error) {
    jsonRes(res, 400, { error: startSafe.error });
    return;
  }
  const tree = buildTree(startSafe.absolute, requestedSub);
  jsonRes(res, 200, {
    conversationId: scope.conversationId,
    root: requestedSub || ".",
    tree,
  });
}

const BINARY_PROBE_BYTES = 4096;

function looksTextual(buf: Buffer): boolean {
  const limit = Math.min(buf.length, BINARY_PROBE_BYTES);
  for (let i = 0; i < limit; i++) {
    const byte = buf[i];
    if (byte === 0) return false;
    if (byte < 9) return false;
    if (byte === 11 || byte === 12) return false;
    if (byte > 13 && byte < 32) return false;
  }
  return true;
}

function servePreviewFile(
  res: ServerResponse,
  absolutePath: string,
  metadata: Record<string, unknown>,
  notFoundMessage: string,
): void {
  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    jsonRes(res, 404, { error: notFoundMessage });
    return;
  }
  if (!stats.isFile()) {
    jsonRes(res, 400, { error: "Not a file" });
    return;
  }
  if (stats.size > PREVIEW_FILE_MAX_BYTES) {
    jsonRes(res, 413, {
      error: "File too large to preview",
      size: stats.size,
      limit: PREVIEW_FILE_MAX_BYTES,
    });
    return;
  }
  let buf: Buffer;
  try {
    buf = readFileSync(absolutePath);
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!looksTextual(buf)) {
    jsonRes(res, 200, {
      ...metadata,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      binary: true,
      content: null,
    });
    return;
  }
  jsonRes(res, 200, {
    ...metadata,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    binary: false,
    content: buf.toString("utf-8"),
  });
}

function serveWorkspaceFile(
  res: ServerResponse,
  url: URL,
  services: AdminServices,
  token: AdminToken,
): void {
  const scope = resolveConversationFromQuery(url, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return;
  }
  const workingDir = requireAdminWorkingDir(res, services);
  if (!workingDir) return;
  const requestedPath = (url.searchParams.get("path") ?? "").trim();
  if (!requestedPath) {
    jsonRes(res, 400, { error: "Missing path" });
    return;
  }
  if (!isWorkspacePathAllowed(requestedPath)) {
    jsonRes(res, 403, { error: "Workspace path is not exposed" });
    return;
  }
  const convDir = join(workingDir, scope.conversationId);
  const safe = safeJoinUnderRoot(convDir, requestedPath);
  if (safe.error) {
    jsonRes(res, 400, { error: safe.error });
    return;
  }
  servePreviewFile(res, safe.absolute, { path: requestedPath }, "File not found");
}

// ── Skills ─────────────────────────────────────────────────────────────────────

interface SkillEntry {
  name: string;
  description: string;
  source: "global" | "conversation";
  path: string;
  directory: string;
}

function parseSkillFrontmatter(filePath: string): { name?: string; description?: string } {
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    return {};
  }
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = text.slice(3, end);
  const out: { name?: string; description?: string } = {};
  for (const line of block.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "name") out.name = value;
    if (key === "description") out.description = value;
  }
  return out;
}

function readSkillsFromDir(skillsDir: string, source: SkillEntry["source"]): SkillEntry[] {
  if (!existsSync(skillsDir)) return [];
  const out: SkillEntry[] = [];
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillMd = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    const meta = parseSkillFrontmatter(skillMd);
    out.push({
      name: meta.name ?? entry.name,
      description: meta.description ?? "",
      source,
      path: skillMd,
      directory: entry.name,
    });
  }
  return out.toSorted((a, b) => a.name.localeCompare(b.name));
}

function serveSkillsList(
  res: ServerResponse,
  url: URL,
  services: AdminServices,
  token: AdminToken,
): void {
  const scope = resolveConversationFromQuery(url, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return;
  }
  const workingDir = requireAdminWorkingDir(res, services);
  if (!workingDir) return;
  const global = readSkillsFromDir(join(workingDir, "skills"), "global");
  const conversation = readSkillsFromDir(
    join(workingDir, scope.conversationId, "skills"),
    "conversation",
  );
  jsonRes(res, 200, {
    conversationId: scope.conversationId,
    skills: [...global, ...conversation],
  });
}

function serveSkillFile(
  res: ServerResponse,
  url: URL,
  services: AdminServices,
  token: AdminToken,
): void {
  const scope = resolveConversationFromQuery(url, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return;
  }
  const workingDir = requireAdminWorkingDir(res, services);
  if (!workingDir) return;

  const source = (url.searchParams.get("source") ?? "").trim();
  const directory = (url.searchParams.get("directory") ?? "").trim();
  if (source !== "global" && source !== "conversation") {
    jsonRes(res, 400, { error: "Invalid skill source" });
    return;
  }
  if (
    !directory ||
    directory.includes("/") ||
    directory.includes("\\") ||
    directory.includes("..")
  ) {
    jsonRes(res, 400, { error: "Invalid skill directory" });
    return;
  }

  const skillsRoot =
    source === "global"
      ? join(workingDir, "skills")
      : join(workingDir, scope.conversationId, "skills");
  const safe = safeJoinUnderRoot(skillsRoot, join(directory, "SKILL.md"));
  if (safe.error) {
    jsonRes(res, 400, { error: safe.error });
    return;
  }

  servePreviewFile(res, safe.absolute, { source, directory }, "Skill file not found");
}

// ── Events ─────────────────────────────────────────────────────────────────────

const EVENTS_FILE_MAX_BYTES = 64 * 1024;

interface EventSummary {
  name: string;
  size: number;
  mtimeMs: number;
  type: string | null;
  platform: string | null;
  conversationId: string | null;
  text: string | null;
  at: string | null;
  schedule: string | null;
  timezone: string | null;
}

function listAllEvents(workingDir: string): EventSummary[] {
  const dir = join(workingDir, "events");
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e): EventSummary | null => {
      const filePath = join(dir, e.name);
      let stats;
      try {
        stats = statSync(filePath);
      } catch {
        return null;
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(readFileSync(filePath, "utf-8"));
      } catch {
        // Keep entry; just omit parsed fields.
      }
      const meta = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
      // events.ts accepts `channelId` as a legacy alias for `conversationId`.
      const conversationId =
        typeof meta.conversationId === "string"
          ? meta.conversationId
          : typeof meta.channelId === "string"
            ? meta.channelId
            : null;
      return {
        name: e.name,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        type: typeof meta.type === "string" ? meta.type : null,
        platform: typeof meta.platform === "string" ? meta.platform : null,
        conversationId,
        text: typeof meta.text === "string" ? meta.text : null,
        at: typeof meta.at === "string" ? meta.at : null,
        schedule: typeof meta.schedule === "string" ? meta.schedule : null,
        timezone: typeof meta.timezone === "string" ? meta.timezone : null,
      };
    })
    .filter((e): e is EventSummary => e !== null)
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

function serveEventsList(res: ServerResponse, services: AdminServices): void {
  const workingDir = requireAdminWorkingDir(res, services);
  if (!workingDir) return;
  jsonRes(res, 200, { events: listAllEvents(workingDir) });
}

/** Per-conversation listing — filter all events by conversationId match. */
function serveConversationEventsList(
  res: ServerResponse,
  url: URL,
  services: AdminServices,
  token: AdminToken,
): void {
  const scope = resolveConversationFromQuery(url, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return;
  }
  const workingDir = requireAdminWorkingDir(res, services);
  if (!workingDir) return;
  const events = listAllEvents(workingDir).filter((e) => e.conversationId === scope.conversationId);
  jsonRes(res, 200, { conversationId: scope.conversationId, events });
}

function serveEventsFile(res: ServerResponse, url: URL, services: AdminServices): void {
  const workingDir = requireAdminWorkingDir(res, services);
  if (!workingDir) return;
  const name = (url.searchParams.get("name") ?? "").trim();
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    jsonRes(res, 400, { error: "Invalid name" });
    return;
  }
  const filePath = join(workingDir, "events", name);
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    jsonRes(res, 404, { error: "Not found" });
    return;
  }
  if (!stats.isFile()) {
    jsonRes(res, 400, { error: "Not a file" });
    return;
  }
  if (stats.size > EVENTS_FILE_MAX_BYTES) {
    jsonRes(res, 413, { error: "File too large" });
    return;
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  jsonRes(res, 200, { name, content: raw });
}

/** Delete a single event file scoped to the caller's conversation. */
function serveConversationEventDelete(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
  token: AdminToken,
): void {
  const scope = resolveTargetConversation(body, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return;
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    jsonRes(res, 400, { error: "Invalid name" });
    return;
  }
  const workingDir = requireAdminWorkingDir(res, services);
  if (!workingDir) return;
  const filePath = join(workingDir, "events", name);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    jsonRes(res, 404, { error: "Event not found" });
    return;
  }
  let parsed: Record<string, unknown> = {};
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object") parsed = j as Record<string, unknown>;
  } catch {
    // Malformed events cannot be associated with a conversation below.
  }
  const eventConvId =
    typeof parsed.conversationId === "string"
      ? parsed.conversationId
      : typeof parsed.channelId === "string"
        ? parsed.channelId
        : null;
  if (eventConvId !== scope.conversationId) {
    jsonRes(res, 403, { error: "Event does not belong to this conversation." });
    return;
  }
  try {
    rmSync(filePath, { force: true });
    jsonRes(res, 200, { ok: true });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function jsonRes(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  const data = await readRawBody(req, res, 32 * 1024);
  if (data === null) return null;

  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    jsonRes(res, 400, { error: "Invalid JSON" });
    return null;
  }
}

const esc = escapeHtml;

// ── HTML ───────────────────────────────────────────────────────────────────────

function renderAdminPage(token: AdminToken): string {
  const userLabel = token.platformUserName ?? token.platformUserId;
  const body = `<nav class="tab-nav" role="tablist" aria-label="Admin sections">
      <button class="tab-btn active" role="tab" aria-selected="true" aria-controls="panel-conversation" data-tab="conversation">Conversation</button>
      <button class="tab-btn" role="tab" aria-selected="false" aria-controls="panel-global" data-tab="global">Global</button>
    </nav>

    <div class="tab-panel active" id="panel-conversation">
      <section class="card sect" id="sect-settings" data-section="settings">
        <header class="sect-head">
          <div>
            <p class="eyebrow">Settings</p>
            <h2 class="card-title">模型 / Thinking / Auto-reply / Workspace mount</h2>
          </div>
          <button class="refresh-btn" onclick="loadSettings()">↻</button>
        </header>
        <div id="settings-content"><div class="loading-msg">Loading…</div></div>
      </section>

      <section class="card sect" id="sect-workspace" data-section="workspace">
        <header class="sect-head">
          <div>
            <p class="eyebrow">Workspace</p>
            <h2 class="card-title">檔案瀏覽 (只讀)</h2>
          </div>
          <button class="refresh-btn" onclick="loadWorkspace()">↻</button>
        </header>
        <div class="workspace-split">
          <div id="workspace-tree" class="workspace-tree"><div class="loading-msg">Loading…</div></div>
          <div id="workspace-preview" class="workspace-preview"><div class="placeholder-msg">Click a file to preview</div></div>
        </div>
      </section>

      <section class="card sect" id="sect-skills" data-section="skills">
        <header class="sect-head">
          <div>
            <p class="eyebrow">Skills</p>
            <h2 class="card-title">可用的 skills</h2>
          </div>
          <button class="refresh-btn" onclick="loadSkills()">↻</button>
        </header>
        <div class="workspace-split">
          <div id="skills-content" class="workspace-tree"><div class="loading-msg">Loading…</div></div>
          <div id="skills-preview" class="workspace-preview"><div class="placeholder-msg">Click a skill to preview SKILL.md</div></div>
        </div>
      </section>

      <section class="card sect" id="sect-vault" data-section="vault">
        <header class="sect-head">
          <div>
            <p class="eyebrow">Vault</p>
            <h2 class="card-title">該對話的憑證</h2>
          </div>
          <button class="primary-action-btn" onclick="openLogin()">Open login form</button>
        </header>
        <div id="vault-link-result" class="link-result" style="display:none"></div>
        <iframe id="login-frame" class="portal-frame" title="Login" style="display:none"></iframe>
      </section>

      <section class="card sect" id="sect-events" data-section="events">
        <header class="sect-head">
          <div>
            <p class="eyebrow">Events</p>
            <h2 class="card-title">關聯此對話的 events</h2>
          </div>
          <button class="refresh-btn" onclick="loadConversationEvents()">↻</button>
        </header>
        <div id="events-content"><div class="loading-msg">Loading…</div></div>
      </section>

      <section class="card sect" id="sect-session" data-section="session">
        <header class="sect-head">
          <div>
            <p class="eyebrow">Session View</p>
            <h2 class="card-title">對話歷史檢視</h2>
          </div>
          <button class="primary-action-btn" onclick="openSessionView()">Open session view</button>
        </header>
        <div id="session-link-result" class="link-result" style="display:none"></div>
        <iframe id="session-frame" class="portal-frame" title="Session View" style="display:none"></iframe>
      </section>
    </div>

    <div class="tab-panel" id="panel-global">
      <section class="card sect">
        <header class="sect-head">
          <div>
            <p class="eyebrow">All Conversations</p>
            <h2 class="card-title">所有對話</h2>
          </div>
          <button class="refresh-btn" onclick="loadAllConversations()">↻</button>
        </header>
        <div id="all-conv-content"><div class="loading-msg">Loading…</div></div>
      </section>

      <section class="card sect">
        <header class="sect-head">
          <div>
            <p class="eyebrow">Token Usage</p>
            <h2 class="card-title">Top 20 sessions</h2>
          </div>
          <button class="refresh-btn" onclick="loadSessionUsage()">↻</button>
        </header>
        <div id="session-usage-content"><div class="loading-msg">Loading…</div></div>
      </section>

      <section class="card sect">
        <header class="sect-head">
          <div>
            <p class="eyebrow">Global Settings</p>
            <h2 class="card-title">全域預設</h2>
          </div>
          <button class="refresh-btn" onclick="loadGlobalSettings()">↻</button>
        </header>
        <div id="global-settings-content"><div class="loading-msg">Loading…</div></div>
      </section>

      <section class="card sect">
        <header class="sect-head">
          <div>
            <p class="eyebrow">Global Skills</p>
            <h2 class="card-title">全域 skills</h2>
          </div>
          <button class="refresh-btn" onclick="loadGlobalSkills()">↻</button>
        </header>
        <div id="global-skills-content"><div class="loading-msg">Loading…</div></div>
      </section>

      <section class="card sect">
        <header class="sect-head">
          <div>
            <p class="eyebrow">Global Events</p>
            <h2 class="card-title">全域 events.json</h2>
          </div>
          <button class="refresh-btn" onclick="loadEvents()">↻</button>
        </header>
        <div id="global-events-content"><div class="loading-msg">Loading…</div></div>
      </section>
    </div>`;

  const script = `
    const adminToken = ${JSON.stringify(token.token)};
    const defaultConversationId = ${JSON.stringify(token.conversationId)};
    let activeConversationId = defaultConversationId;
    let availableModels = [];
    let modelsLoaded = false;

    // ── Helpers ──────────────────────────────────────────────────────────────────

    function escHtml(str) {
      return String(str).replace(/[&<>"']/g, (c) => (
        {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
      ));
    }
    function escAttr(str) {
      return String(str).replace(/["'&<>]/g, (c) => (
        {'"':'&quot;',"'":'&#39;','&':'&amp;','<':'&lt;','>':'&gt;'}[c]
      ));
    }
    async function copyToClipboard(text) {
      try { await navigator.clipboard.writeText(text); } catch { prompt('Copy this link:', text); }
    }
    async function apiGet(path) {
      const url = path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(adminToken);
      const r = await fetch(url);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    }
    async function apiPost(path, body) {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: adminToken, ...body }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    }
    async function loadModels() {
      try {
        const data = await apiGet('/admin/api/models');
        availableModels = Array.isArray(data.models) ? data.models : [];
      } catch (err) {
        availableModels = [];
      } finally {
        modelsLoaded = true;
      }
    }
    function modelRef(provider, model) {
      return provider && model ? provider + '/' + model : '';
    }
    function parseModelRef(value) {
      const slash = value.indexOf('/');
      if (slash <= 0 || slash === value.length - 1) return { provider: '', model: '' };
      return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
    }
    function renderModelOptions(currentProvider, currentModel) {
      const current = modelRef(currentProvider, currentModel);
      const seen = new Set();
      const groups = {
        available: [],
        unverified: [],
      };
      if (current) {
        seen.add(current);
        groups.available.push('<option value="' + escAttr(current) + '">' + escHtml(current + ' (current)') + '</option>');
      }
      for (const model of availableModels) {
        const ref = modelRef(model.provider, model.id);
        if (!ref || seen.has(ref)) continue;
        seen.add(ref);
        const details = [model.name && model.name !== model.id ? model.name : '', model.reasoning ? 'thinking' : '', Array.isArray(model.input) && model.input.includes('image') ? 'image' : '']
          .filter(Boolean)
          .join(' · ');
        const option = '<option value="' + escAttr(ref) + '">' + escHtml(details ? ref + ' — ' + details : ref) + '</option>';
        if (model.status === 'unverified') groups.unverified.push(option);
        else groups.available.push(option);
      }
      const sections = [];
      if (groups.available.length > 0) sections.push('<optgroup label="Available">' + groups.available.join('') + '</optgroup>');
      if (groups.unverified.length > 0) sections.push('<optgroup label="Configured but unverified">' + groups.unverified.join('') + '</optgroup>');
      if (sections.length === 0) {
        return '<option value="">No available models</option>';
      }
      return sections.join('');
    }

    // ── Tab switching ────────────────────────────────────────────────────────────

    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');

    function switchTab(tabId) {
      tabBtns.forEach((btn) => {
        const active = btn.dataset.tab === tabId;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      tabPanels.forEach((panel) => panel.classList.toggle('active', panel.id === 'panel-' + tabId));
      if (tabId === 'global') initGlobal();
    }
    tabBtns.forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

    // ── Conversation switcher ───────────────────────────────────────────────────

    async function initConvSwitcher() {
      const sel = document.getElementById('conv-switcher');
      try {
        const data = await apiGet('/admin/api/conversations');
        sel.innerHTML = data.conversations.map((c) => {
          const label = (c.label || c.conversationId) + (c.running ? ' (running)' : '');
          const selected = c.conversationId === defaultConversationId ? ' selected' : '';
          return '<option value="' + escAttr(c.conversationId) + '"' + selected + '>' + escHtml(label) + '</option>';
        }).join('');
        sel.addEventListener('change', () => setActiveConversation(sel.value));
      } catch (err) {
        // ignore; conversation selector stays empty
      }
    }

    function setActiveConversation(id) {
      activeConversationId = id;
      const sel = document.getElementById('conv-switcher');
      if (sel && sel.value !== id) sel.value = id;
      // Reset all conversation sections.
      loadSettings();
      loadWorkspace();
      loadSkills();
      loadConversationEvents();
      openLogin(true);
      openSessionView(true);
    }

    // ── Settings ─────────────────────────────────────────────────────────────────

    async function loadSettings() {
      const container = document.getElementById('settings-content');
      container.innerHTML = '<div class="loading-msg">Loading…</div>';
      if (!modelsLoaded) await loadModels();
      try {
        const data = await apiGet('/admin/api/conversation-state?conversationId=' + encodeURIComponent(activeConversationId));
        container.innerHTML = renderSettings(data);
      } catch (err) {
        container.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    function renderSettings(data) {
      const thinking = ['off','minimal','low','medium','high','xhigh'];
      const thinkingOpts = thinking.map((t) =>
        '<option value="' + t + '"' + (data.thinkingLevel === t ? ' selected' : '') + '>' + t + '</option>'
      ).join('');
      const mounts = ['private','full'];
      const mountOpts = mounts.map((m) =>
        '<option value="' + m + '"' + (data.sandboxImageWorkspaceMount === m ? ' selected' : '') + '>' + m + '</option>'
      ).join('');
      const rulesText = (data.autoReplyRules || []).join('\\n');
      const replyModes = ['top-level','thread'];
      const replyModeOpts = replyModes.map((m) =>
        '<option value="' + m + '"' + (((data.slack && data.slack.replyMode) || 'top-level') === m ? ' selected' : '') + '>' + m + '</option>'
      ).join('');
      const globalReplyMode = (data.slack && data.slack.globalReplyMode) || 'top-level';
      const globalModel = [data.globalProvider, data.globalModel].filter(Boolean).join('/');
      const globalModelLabel = globalModel + (data.globalThinkingLevel ? ':' + data.globalThinkingLevel : '');
      const globalMount = data.globalSandboxImageWorkspaceMount || 'private';
      return [
        '<div class="config-grid">',
          '<div class="config-block">',
            '<h3 class="card-subtitle">Model</h3>',
            '<div class="config-row config-row-stack"><label>Model</label><select id="m-model-ref">' + renderModelOptions(data.provider, data.model) + '</select></div>',
            '<div class="config-row"><label>Thinking</label><select id="m-thinking">' + thinkingOpts + '</select></div>',
            '<p class="muted-note">Global default: ' + escHtml(globalModelLabel) + '</p>',
            '<button class="primary-action-btn" onclick="saveModel(this)">Save model</button>',
            '<div id="model-save-result" class="inline-result" style="display:none"></div>',
          '</div>',
          '<div class="config-block">',
            '<h3 class="card-subtitle">Auto-reply</h3>',
            '<div class="config-row"><label>Enabled</label><label class="toggle"><input type="checkbox" id="a-enabled"' + (data.autoReplyEnabled ? ' checked' : '') + '> on</label></div>',
            '<div class="config-row config-row-stack"><label>Rules</label><textarea id="a-rules" rows="5" placeholder="一行一條規則">' + escHtml(rulesText) + '</textarea></div>',
            '<button class="primary-action-btn" onclick="saveAutoReply(this)">Save auto-reply</button>',
            '<div id="auto-save-result" class="inline-result" style="display:none"></div>',
          '</div>',
          '<div class="config-block">',
            '<h3 class="card-subtitle">Workspace mount</h3>',
            '<div class="config-row"><label>Mode</label><select id="m-mount">' + mountOpts + '</select></div>',
            '<p class="muted-note">Global default: ' + escHtml(globalMount) + '</p>',
            '<button class="primary-action-btn" onclick="saveMount(this)">Save mount</button>',
            '<div id="mount-save-result" class="inline-result" style="display:none"></div>',
          '</div>',
          '<div class="config-block">',
            '<h3 class="card-subtitle">Slack</h3>',
            '<div class="config-row"><label>Reply mode</label><select id="m-slack-reply-mode">' + replyModeOpts + '</select></div>',
            '<p class="muted-note">Global default: ' + escHtml(globalReplyMode) + '</p>',
            '<button class="primary-action-btn" onclick="saveSlack(this)">Save Slack</button>',
            '<div id="slack-save-result" class="inline-result" style="display:none"></div>',
          '</div>',
        '</div>',
      ].join('');
    }

    async function saveModel(btn) {
      const selectedModel = parseModelRef(document.getElementById('m-model-ref').value.trim());
      const provider = selectedModel.provider;
      const model = selectedModel.model;
      const thinkingLevel = document.getElementById('m-thinking').value;
      const result = document.getElementById('model-save-result');
      if (!provider || !model) {
        result.style.display = 'block'; result.className = 'inline-result err';
        result.textContent = 'Provider and model are required';
        return;
      }
      btn.disabled = true; btn.textContent = 'Saving…'; result.style.display = 'none';
      try {
        const data = await apiPost('/admin/api/conversations/model', {
          conversationId: activeConversationId, provider, model, thinkingLevel,
        });
        result.style.display = 'block'; result.className = 'inline-result ok';
        result.textContent = data.runtimeSwitched === false
          ? 'Saved — running session pinned; new model applies on next start.'
          : 'Saved ✓';
      } catch (err) {
        result.style.display = 'block'; result.className = 'inline-result err';
        result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Save model';
      }
    }

    async function saveAutoReply(btn) {
      const enabled = document.getElementById('a-enabled').checked;
      const rules = document.getElementById('a-rules').value.split('\\n').map((s) => s.trim()).filter(Boolean);
      const result = document.getElementById('auto-save-result');
      btn.disabled = true; btn.textContent = 'Saving…'; result.style.display = 'none';
      try {
        await apiPost('/admin/api/conversations/auto-reply', {
          conversationId: activeConversationId, enabled, rules,
        });
        result.style.display = 'block'; result.className = 'inline-result ok'; result.textContent = 'Saved ✓';
      } catch (err) {
        result.style.display = 'block'; result.className = 'inline-result err'; result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Save auto-reply';
      }
    }

    async function saveMount(btn) {
      const workspaceMount = document.getElementById('m-mount').value;
      const result = document.getElementById('mount-save-result');
      btn.disabled = true; btn.textContent = 'Saving…'; result.style.display = 'none';
      try {
        await apiPost('/admin/api/conversations/sandbox', {
          conversationId: activeConversationId, workspaceMount,
        });
        result.style.display = 'block'; result.className = 'inline-result ok'; result.textContent = 'Saved ✓';
      } catch (err) {
        result.style.display = 'block'; result.className = 'inline-result err'; result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Save mount';
      }
    }

    async function saveSlack(btn) {
      const replyMode = document.getElementById('m-slack-reply-mode').value;
      const result = document.getElementById('slack-save-result');
      btn.disabled = true; btn.textContent = 'Saving…'; result.style.display = 'none';
      try {
        await apiPost('/admin/api/conversations/slack', {
          conversationId: activeConversationId, replyMode,
        });
        result.style.display = 'block'; result.className = 'inline-result ok'; result.textContent = 'Saved ✓';
      } catch (err) {
        result.style.display = 'block'; result.className = 'inline-result err'; result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Save Slack';
      }
    }

    // ── Workspace ────────────────────────────────────────────────────────────────

    async function loadWorkspace() {
      const treeEl = document.getElementById('workspace-tree');
      const previewEl = document.getElementById('workspace-preview');
      treeEl.innerHTML = '<div class="loading-msg">Loading…</div>';
      previewEl.innerHTML = '<div class="placeholder-msg">Click a file to preview</div>';
      try {
        const data = await apiGet('/admin/api/workspace/tree?conversationId=' + encodeURIComponent(activeConversationId));
        if (!data.tree) {
          treeEl.innerHTML = '<div class="empty-state">No files</div>';
          return;
        }
        treeEl.innerHTML = '<ul class="tree-root">' + renderTreeChildren(data.tree) + '</ul>';
      } catch (err) {
        treeEl.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    function renderTreeChildren(node) {
      if (node.type === 'file') {
        return '<li><button class="tree-file" onclick="previewFile(\\'' + escAttr(node.path) + '\\')">' + escHtml(node.name) + '</button></li>';
      }
      if (!node.children || node.children.length === 0) {
        return '<li><span class="tree-dir empty">' + escHtml(node.name || '.') + '/</span></li>';
      }
      const inner = node.children.map((c) =>
        c.type === 'file'
          ? '<li><button class="tree-file" onclick="previewFile(\\'' + escAttr(c.path) + '\\')">' + escHtml(c.name) + '</button></li>'
          : '<li><details open><summary class="tree-dir">' + escHtml(c.name) + '/</summary><ul>' + renderTreeChildren(c) + '</ul></details></li>'
      ).join('');
      return inner;
    }

    function renderPreviewFileResult(previewEl, label, data) {
      if (data.binary) {
        previewEl.innerHTML = '<div class="preview-meta">' + escHtml(label) + ' · ' + data.size + ' bytes · binary</div><div class="placeholder-msg">Binary file — preview not available</div>';
        return;
      }
      previewEl.innerHTML =
        '<div class="preview-meta">' + escHtml(label) + ' · ' + data.size + ' bytes</div>' +
        '<pre class="preview-body">' + escHtml(data.content || '') + '</pre>';
    }

    async function previewFile(path) {
      const previewEl = document.getElementById('workspace-preview');
      previewEl.innerHTML = '<div class="loading-msg">Loading ' + escHtml(path) + '…</div>';
      try {
        const data = await apiGet('/admin/api/workspace/file?conversationId=' + encodeURIComponent(activeConversationId) + '&path=' + encodeURIComponent(path));
        renderPreviewFileResult(previewEl, path, data);
      } catch (err) {
        previewEl.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    // ── Skills ───────────────────────────────────────────────────────────────────

    async function loadSkills() {
      const container = document.getElementById('skills-content');
      const previewEl = document.getElementById('skills-preview');
      container.innerHTML = '<div class="loading-msg">Loading…</div>';
      if (previewEl) previewEl.innerHTML = '<div class="placeholder-msg">Click a skill to preview SKILL.md</div>';
      try {
        const data = await apiGet('/admin/api/skills?conversationId=' + encodeURIComponent(activeConversationId));
        if (data.skills.length === 0) {
          container.innerHTML = '<div class="empty-state">No skills available</div>';
          return;
        }
        container.innerHTML = '<div class="skills-list">' +
          data.skills.map((s) =>
            '<button class="skill-row skill-row-btn" data-skill-source="' + escAttr(s.source) + '" data-skill-directory="' + escAttr(s.directory) + '" data-skill-name="' + escAttr(s.name) + '">' +
              '<div class="skill-name">' + escHtml(s.name) + '<span class="skill-source skill-source-' + s.source + '">' + s.source + '</span></div>' +
              (s.description ? '<div class="skill-desc">' + escHtml(s.description) + '</div>' : '') +
            '</button>'
          ).join('') + '</div>';

      } catch (err) {
        container.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    async function previewSkill(source, directory, name) {
      const previewEl = document.getElementById('skills-preview');
      if (!source || !directory) {
        previewEl.innerHTML = '<div class="err-msg">Missing skill source or directory</div>';
        return;
      }
      previewEl.innerHTML = '<div class="loading-msg">Loading ' + escHtml(name || directory) + '…</div>';
      try {
        const data = await apiGet('/admin/api/skills/file?conversationId=' + encodeURIComponent(activeConversationId) + '&source=' + encodeURIComponent(source) + '&directory=' + encodeURIComponent(directory));
        renderPreviewFileResult(previewEl, source + '/' + directory + '/SKILL.md', data);
      } catch (err) {
        previewEl.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    document.getElementById('skills-content').addEventListener('click', (event) => {
      const btn = event.target.closest('[data-skill-source]');
      if (!btn) return;
      previewSkill(btn.dataset.skillSource, btn.dataset.skillDirectory, btn.dataset.skillName);
    });

    // ── Vault (Login link) ───────────────────────────────────────────────────────

    async function openLogin(silent) {
      const result = document.getElementById('vault-link-result');
      const frame = document.getElementById('login-frame');
      if (silent) { frame.removeAttribute('src'); frame.style.display = 'none'; result.style.display = 'none'; return; }
      result.style.display = 'block'; result.className = 'link-result loading'; result.textContent = 'Generating link…';
      try {
        const data = await apiPost('/admin/api/conversations/login-link', { conversationId: activeConversationId });
        result.className = 'link-result ok';
        result.innerHTML =
          '<span class="link-vault">vault: <code>' + escHtml(data.vaultId) + '</code></span>' +
          '<a href="' + escAttr(data.url) + '" target="_blank" rel="noopener">' + escHtml(data.url) + '</a>' +
          '<button class="copy-link-btn" onclick="copyToClipboard(' + JSON.stringify(data.url) + ')">Copy</button>';
        frame.src = data.url; frame.style.display = 'block';
      } catch (err) {
        result.className = 'link-result err'; result.textContent = err.message;
        frame.removeAttribute('src'); frame.style.display = 'none';
      }
    }

    // ── Session View ─────────────────────────────────────────────────────────────

    async function openSessionView(silent) {
      const result = document.getElementById('session-link-result');
      const frame = document.getElementById('session-frame');
      if (silent) { frame.removeAttribute('src'); frame.style.display = 'none'; result.style.display = 'none'; return; }
      result.style.display = 'block'; result.className = 'link-result loading'; result.textContent = 'Generating link…';
      try {
        const data = await apiPost('/admin/api/conversations/session-link', { conversationId: activeConversationId });
        result.className = 'link-result ok';
        result.innerHTML =
          '<a href="' + escAttr(data.url) + '" target="_blank" rel="noopener">' + escHtml(data.url) + '</a>' +
          '<button class="copy-link-btn" onclick="copyToClipboard(' + JSON.stringify(data.url) + ')">Copy</button>';
        frame.src = data.url; frame.style.display = 'block';
      } catch (err) {
        result.className = 'link-result err'; result.textContent = err.message;
        frame.removeAttribute('src'); frame.style.display = 'none';
      }
    }

    // ── Events ───────────────────────────────────────────────────────────────────

    async function loadConversationEvents() {
      const container = document.getElementById('events-content');
      if (!container) return;
      container.innerHTML = '<div class="loading-msg">Loading…</div>';
      try {
        const data = await apiGet('/admin/api/conversations/events?conversationId=' + encodeURIComponent(activeConversationId));
        if (data.events.length === 0) {
          container.innerHTML = '<div class="empty-state">沒有關聯此對話的 event</div>';
          return;
        }
        container.innerHTML = '<div class="events-list">' +
          data.events.map((e) => renderEventRow(e, true)).join('') + '</div>';
      } catch (err) {
        container.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    async function loadEvents() {
      const container = document.getElementById('global-events-content');
      if (!container) return;
      container.innerHTML = '<div class="loading-msg">Loading…</div>';
      try {
        const data = await apiGet('/admin/api/events');
        if (data.events.length === 0) {
          container.innerHTML = '<div class="empty-state">No events scheduled</div>';
          return;
        }
        container.innerHTML = '<div class="events-list">' +
          data.events.map((e) => renderEventRow(e, false)).join('') + '</div>';
      } catch (err) {
        container.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    function renderEventRow(e, allowDelete) {
      const meta = [e.type, e.platform, e.conversationId, e.schedule || e.at]
        .filter(Boolean).map(escHtml).join(' · ');
      const preview = e.text ? '<div class="event-text">' + escHtml(e.text.length > 240 ? e.text.slice(0, 237) + '…' : e.text) + '</div>' : '';
      const deleteBtn = allowDelete
        ? '<button class="event-delete-btn" onclick="deleteEvent(\\'' + escAttr(e.name) + '\\', this)">Delete</button>'
        : '';
      return '<div class="event-row">' +
        '<div class="event-row-top">' +
          '<div class="event-name"><code>' + escHtml(e.name) + '</code></div>' +
          deleteBtn +
        '</div>' +
        '<div class="event-meta">' + meta + '</div>' +
        preview +
      '</div>';
    }

    async function deleteEvent(name, btn) {
      if (!confirm('Delete event "' + name + '"?')) return;
      btn.disabled = true; btn.textContent = 'Deleting…';
      try {
        await apiPost('/admin/api/conversations/events/delete', {
          conversationId: activeConversationId, name,
        });
        await loadConversationEvents();
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Delete';
        alert(err.message);
      }
    }

    // ── Global section ──────────────────────────────────────────────────────────

    let globalLoaded = false;
    function initGlobal() {
      if (globalLoaded) return;
      globalLoaded = true;
      loadAllConversations();
      loadSessionUsage();
      loadGlobalSettings();
      loadGlobalSkills();
      loadEvents();
    }

    async function loadAllConversations() {
      const container = document.getElementById('all-conv-content');
      container.innerHTML = '<div class="loading-msg">Loading…</div>';
      try {
        const data = await apiGet('/admin/api/conversations');
        if (data.conversations.length === 0) {
          container.innerHTML = '<div class="empty-state">No conversations found</div>';
          return;
        }
        container.innerHTML = '<div class="conv-list">' + data.conversations.map((c) => {
          const last = c.lastActivityAt ? new Date(c.lastActivityAt).toLocaleString() : '—';
          return '<button class="conv-row-btn" onclick="setActiveConversation(\\'' + escAttr(c.conversationId) + '\\'); switchTab(\\'conversation\\');">' +
            '<span class="conv-id">' + escHtml(c.label || c.conversationId) + '</span>' +
            (c.running ? '<span class="status-pill running">running</span>' : '') +
            '<span class="conv-last">' + escHtml(last) + '</span>' +
          '</button>';
        }).join('') + '</div>';
      } catch (err) {
        container.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    async function loadSessionUsage() {
      const container = document.getElementById('session-usage-content');
      container.innerHTML = '<div class="loading-msg">Loading…</div>';
      try {
        const data = await apiGet('/admin/api/session-usage');
        if (data.sessions.length === 0) {
          container.innerHTML = '<div class="empty-state">No token usage found</div>';
          return;
        }
        container.innerHTML = '<div class="usage-table-wrap"><table class="usage-table"><thead><tr><th>#</th><th>Channel</th><th>Session</th><th>Updated</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Cache Write</th><th>Total</th><th>Cost</th></tr></thead><tbody>' +
          data.sessions.map((s, i) => '<tr>' +
            '<td>' + (i + 1) + '</td>' +
            '<td>' + escHtml(s.label || s.conversationId) + '</td>' +
            '<td><code>' + escHtml(s.fileName) + '</code></td>' +
            '<td>' + escHtml(new Date(s.updatedAt).toLocaleString()) + '</td>' +
            '<td>' + fmtNum(s.input) + '</td>' +
            '<td>' + fmtNum(s.output) + '</td>' +
            '<td>' + fmtNum(s.cacheRead) + '</td>' +
            '<td>' + fmtNum(s.cacheWrite) + '</td>' +
            '<td><strong>' + fmtNum(s.total) + '</strong></td>' +
            '<td>' + (s.cost > 0 ? '$' + Number(s.cost).toFixed(4) : '—') + '</td>' +
          '</tr>').join('') + '</tbody></table></div>';
      } catch (err) {
        container.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    function fmtNum(value) {
      return Number(value || 0).toLocaleString('en-US');
    }

    async function loadGlobalSettings() {
      const container = document.getElementById('global-settings-content');
      container.innerHTML = '<div class="loading-msg">Loading…</div>';
      if (!modelsLoaded) await loadModels();
      try {
        const data = await apiGet('/admin/api/settings/global');
        container.innerHTML = renderGlobalSettings(data);
      } catch (err) {
        container.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    function renderGlobalSettings(data) {
      const thinking = ['off','minimal','low','medium','high','xhigh'];
      const thinkingOpts = thinking.map((t) =>
        '<option value="' + t + '"' + (data.thinkingLevel === t ? ' selected' : '') + '>' + t + '</option>'
      ).join('');
      const mounts = ['private','full'];
      const mountOpts = mounts.map((m) =>
        '<option value="' + m + '"' + (data.sandboxImageWorkspaceMount === m ? ' selected' : '') + '>' + m + '</option>'
      ).join('');
      const replyModes = ['top-level','thread'];
      const replyModeOpts = replyModes.map((m) =>
        '<option value="' + m + '"' + (((data.slack && data.slack.replyMode) || 'top-level') === m ? ' selected' : '') + '>' + m + '</option>'
      ).join('');
      return [
        '<div class="config-grid">',
          '<div class="config-block">',
            '<h3 class="card-subtitle">Default model</h3>',
            '<div class="config-row config-row-stack"><label>Model</label><select id="g-model-ref">' + renderModelOptions(data.provider, data.model) + '</select></div>',
            '<div class="config-row"><label>Thinking</label><select id="g-thinking">' + thinkingOpts + '</select></div>',
            '<button class="primary-action-btn" onclick="saveGlobalModel(this)">Save model</button>',
            '<div id="g-model-result" class="inline-result" style="display:none"></div>',
          '</div>',
          '<div class="config-block">',
            '<h3 class="card-subtitle">Sandbox limits</h3>',
            '<div class="config-row"><label>CPUs</label><input id="g-cpus" placeholder="0.5" value="' + escAttr(data.sandboxCpus || '') + '"></div>',
            '<div class="config-row"><label>Memory</label><input id="g-mem" placeholder="1g" value="' + escAttr(data.sandboxMemory || '') + '"></div>',
            '<div class="config-row"><label>Boost CPUs</label><input id="g-bcpus" placeholder="2" value="' + escAttr(data.sandboxBoostCpus || '') + '"></div>',
            '<div class="config-row"><label>Boost Mem</label><input id="g-bmem" placeholder="4g" value="' + escAttr(data.sandboxBoostMemory || '') + '"></div>',
            '<div class="config-row"><label>Mount</label><select id="g-mount">' + mountOpts + '</select></div>',
            '<button class="primary-action-btn" onclick="saveGlobalSandbox(this)">Save sandbox</button>',
            '<div id="g-sandbox-result" class="inline-result" style="display:none"></div>',
          '</div>',
          '<div class="config-block">',
            '<h3 class="card-subtitle">Slack</h3>',
            '<div class="config-row"><label>Reply mode</label><select id="g-slack-reply-mode">' + replyModeOpts + '</select></div>',
            '<button class="primary-action-btn" onclick="saveGlobalSlack(this)">Save Slack</button>',
            '<div id="g-slack-result" class="inline-result" style="display:none"></div>',
          '</div>',
        '</div>',
      ].join('');
    }

    async function saveGlobalModel(btn) {
      const selectedModel = parseModelRef(document.getElementById('g-model-ref').value.trim());
      const provider = selectedModel.provider;
      const model = selectedModel.model;
      const thinkingLevel = document.getElementById('g-thinking').value;
      const result = document.getElementById('g-model-result');
      if (!provider || !model) {
        result.style.display = 'block'; result.className = 'inline-result err';
        result.textContent = 'Provider and model are required'; return;
      }
      btn.disabled = true; btn.textContent = 'Saving…'; result.style.display = 'none';
      try {
        await apiPost('/admin/api/settings/model', { provider, model, thinkingLevel });
        result.style.display = 'block'; result.className = 'inline-result ok'; result.textContent = 'Saved ✓';
      } catch (err) {
        result.style.display = 'block'; result.className = 'inline-result err'; result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Save model';
      }
    }

    async function saveGlobalSandbox(btn) {
      const cpus = document.getElementById('g-cpus').value.trim();
      const memory = document.getElementById('g-mem').value.trim();
      const boostCpus = document.getElementById('g-bcpus').value.trim();
      const boostMemory = document.getElementById('g-bmem').value.trim();
      const workspaceMount = document.getElementById('g-mount').value;
      const result = document.getElementById('g-sandbox-result');
      btn.disabled = true; btn.textContent = 'Saving…'; result.style.display = 'none';
      try {
        await apiPost('/admin/api/settings/sandbox', { cpus, memory, boostCpus, boostMemory, workspaceMount });
        result.style.display = 'block'; result.className = 'inline-result ok'; result.textContent = 'Saved ✓';
      } catch (err) {
        result.style.display = 'block'; result.className = 'inline-result err'; result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Save sandbox';
      }
    }

    async function saveGlobalSlack(btn) {
      const replyMode = document.getElementById('g-slack-reply-mode').value;
      const result = document.getElementById('g-slack-result');
      btn.disabled = true; btn.textContent = 'Saving…'; result.style.display = 'none';
      try {
        await apiPost('/admin/api/settings/slack', { replyMode });
        result.style.display = 'block'; result.className = 'inline-result ok'; result.textContent = 'Saved ✓';
      } catch (err) {
        result.style.display = 'block'; result.className = 'inline-result err'; result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Save Slack';
      }
    }

    async function loadGlobalSkills() {
      const container = document.getElementById('global-skills-content');
      container.innerHTML = '<div class="loading-msg">Loading…</div>';
      try {
        // Reuse skills endpoint scoped to a conversation that doesn't have any of its own; the global half is what we want.
        const data = await apiGet('/admin/api/skills?conversationId=' + encodeURIComponent(activeConversationId));
        const globals = data.skills.filter((s) => s.source === 'global');
        if (globals.length === 0) {
          container.innerHTML = '<div class="empty-state">No global skills</div>';
          return;
        }
        container.innerHTML = '<div class="skills-list">' + globals.map((s) =>
          '<div class="skill-row"><div class="skill-name">' + escHtml(s.name) + '</div>' +
          (s.description ? '<div class="skill-desc">' + escHtml(s.description) + '</div>' : '') + '</div>'
        ).join('') + '</div>';
      } catch (err) {
        container.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    // ── Init ─────────────────────────────────────────────────────────────────────

    initConvSwitcher();
    loadModels().finally(() => {
      loadSettings();
      loadWorkspace();
      loadSkills();
      loadConversationEvents();
    });
  `;

  return renderPortalShell({
    activeView: "admin",
    pageTitle: "Admin",
    identity: { primary: token.platform, secondary: userLabel },
    conversationSwitcher: { currentId: token.conversationId },
    body,
    extraStyles: adminViewStyles,
    inlineScript: script,
  });
}

function renderAdminErrorPage(message: string): string {
  return renderPortalShell({
    activeView: "admin",
    pageTitle: "Admin",
    body: `<section class="card" style="text-align:center;padding:40px 32px">
      <p class="eyebrow">${PRODUCT_NAME} admin</p>
      <h1 class="page-title" style="margin:12px 0 16px">Access Denied</h1>
      <div class="err-msg">${esc(message)}</div>
    </section>`,
  });
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const adminViewStyles = `
  .tab-nav {
    display: flex; gap: 6px; padding: 6px;
    border: 1px solid var(--border); border-radius: 16px;
    background: rgba(255,255,255,0.72); backdrop-filter: blur(8px);
    overflow-x: auto; scrollbar-width: none;
  }
  .tab-nav::-webkit-scrollbar { display: none; }
  .tab-btn {
    flex: 1; min-width: 80px; padding: 10px 16px;
    border: none; border-radius: 10px; background: transparent;
    color: var(--muted);
    font: 500 0.88rem/1.2 'DM Sans', sans-serif;
    cursor: pointer; white-space: nowrap;
    transition: background 140ms, color 140ms;
  }
  .tab-btn:hover { background: rgba(0,0,0,0.04); color: var(--text); }
  .tab-btn.active { background: var(--text); color: #fafafa; font-weight: 600; }
  .tab-btn:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }

  .tab-panel { display: none; flex-direction: column; gap: 14px; }
  .tab-panel.active { display: flex; }

  .card-desc { color: var(--muted); font-size: 0.9rem; line-height: 1.55; margin-bottom: 12px; }

  .link-result {
    margin-top: 12px; padding: 10px 14px; border-radius: 10px;
    display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    font-size: 0.84rem;
  }
  .link-result.ok { background: var(--ok-bg); border: 1px solid var(--ok-border); }
  .link-result.err { background: var(--err-bg); border: 1px solid var(--err-border); color: var(--err-text); }
  .link-result.loading { background: rgba(0,0,0,0.025); border: 1px solid var(--border); color: var(--muted); }
  .link-result a {
    color: var(--ok-text);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.78rem; word-break: break-all; flex: 1; min-width: 0;
  }
  .link-vault { color: var(--muted); font-size: 0.78rem; flex-shrink: 0; }
  .copy-link-btn {
    padding: 5px 12px; border: 1px solid var(--ok-border); border-radius: 7px;
    background: rgba(255,255,255,0.7); color: var(--ok-text);
    font: 500 0.78rem/1.2 'DM Sans', sans-serif;
    cursor: pointer; flex-shrink: 0;
  }

  .portal-frame {
    width: 100%; min-height: 720px;
    border: 1px solid var(--border); border-radius: 14px; background: #fff;
  }

  .config-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 18px;
  }
  .config-block { display: flex; flex-direction: column; gap: 10px; }
  .config-row { display: grid; grid-template-columns: 110px 1fr; gap: 10px; align-items: center; }
  .config-row.config-row-stack { grid-template-columns: 1fr; }
  .config-row label { font-size: 0.82rem; color: var(--muted); }
  .config-row input, .config-row select, .config-row textarea {
    padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px;
    font-family: inherit; font-size: 0.84rem; width: 100%;
  }
  .config-row textarea {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    resize: vertical;
  }
  .toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 0.84rem; }

  .inline-result {
    padding: 8px 12px; border-radius: 8px; font-size: 0.82rem; margin-top: 4px;
  }
  .inline-result.ok { background: var(--ok-bg); color: var(--ok-text); border: 1px solid var(--ok-border); }
  .inline-result.err { background: var(--err-bg); color: var(--err-text); border: 1px solid var(--err-border); }

  /* ── Sections (Conversation page stack) ─────────────────────────────── */

  .sect-head {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; margin-bottom: 14px; flex-wrap: wrap;
  }
  .sect-head .card-title { margin-bottom: 0; }
  .sect-disabled { opacity: 0.7; }

  .refresh-btn {
    flex-shrink: 0; padding: 6px 12px;
    border: 1px solid var(--border); border-radius: 10px;
    background: rgba(0,0,0,0.025); color: var(--muted);
    font: 500 0.84rem/1.2 'DM Sans', sans-serif; cursor: pointer;
  }
  .refresh-btn:hover { background: rgba(0,0,0,0.06); color: var(--text); }

  /* ── Workspace ──────────────────────────────────────────────────────── */

  .workspace-split {
    display: grid; grid-template-columns: 260px 1fr; gap: 14px;
    min-height: 360px;
  }
  .workspace-tree {
    border: 1px solid var(--border); border-radius: 12px; padding: 10px;
    background: rgba(0,0,0,0.02); overflow: auto; max-height: 480px;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.78rem;
  }
  .workspace-tree ul { list-style: none; padding-left: 12px; margin: 0; }
  .workspace-tree .tree-root { padding-left: 0; }
  .workspace-tree details { margin: 1px 0; }
  .workspace-tree summary { cursor: pointer; padding: 2px 4px; border-radius: 4px; }
  .workspace-tree summary:hover { background: rgba(0,0,0,0.05); }
  .tree-dir { color: var(--text); font-weight: 600; }
  .tree-dir.empty { color: var(--subtle); font-weight: 400; }
  .tree-file {
    display: block; width: 100%; text-align: left;
    background: transparent; border: none; cursor: pointer;
    padding: 2px 4px; border-radius: 4px;
    font-family: inherit; font-size: inherit; color: var(--muted);
  }
  .tree-file:hover { background: rgba(0,0,0,0.05); color: var(--text); }

  .workspace-preview {
    border: 1px solid var(--border); border-radius: 12px;
    background: #fff; padding: 12px; overflow: auto; max-height: 480px;
  }
  .preview-meta {
    font-size: 0.74rem; color: var(--subtle);
    margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--border);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }
  .preview-body {
    margin: 0; white-space: pre-wrap; word-break: break-word;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.78rem; color: var(--text);
  }
  .placeholder-msg { color: var(--subtle); font-size: 0.86rem; padding: 24px 8px; text-align: center; }

  /* ── Skills ─────────────────────────────────────────────────────────── */

  .skills-list { display: flex; flex-direction: column; gap: 8px; }
  .skill-row {
    padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px;
    background: rgba(0,0,0,0.02);
  }
  .skill-row-btn {
    width: 100%; text-align: left; cursor: pointer; font-family: inherit;
  }
  .skill-row-btn:hover { background: rgba(0,0,0,0.05); }
  .skill-name {
    font-weight: 650; font-size: 0.9rem; color: var(--text);
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  }
  .skill-source {
    padding: 1px 8px; border-radius: 999px; font-size: 0.7rem;
    font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  }
  .skill-source-global { background: rgba(59,130,246,0.1); color: #1d4ed8; }
  .skill-source-conversation { background: rgba(217,119,6,0.1); color: var(--accent); }
  .skill-desc { color: var(--muted); font-size: 0.82rem; margin-top: 4px; line-height: 1.5; }

  /* ── Events ─────────────────────────────────────────────────────────── */

  .events-list { display: flex; flex-direction: column; gap: 8px; }
  .event-row {
    padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px;
    background: rgba(0,0,0,0.02);
  }
  .event-row-top {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px;
  }
  .event-name { min-width: 0; flex: 1; word-break: break-all; }
  .event-name code { font-size: 0.82rem; background: transparent; padding: 0; }
  .event-meta { font-size: 0.74rem; color: var(--muted); margin-top: 3px; }
  .event-text {
    font-size: 0.82rem; color: var(--text); margin-top: 6px;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    white-space: pre-wrap; word-break: break-word;
  }
  .event-delete-btn {
    flex-shrink: 0; padding: 4px 10px;
    border-radius: 7px; border: 1px solid rgba(185, 28, 28, 0.18);
    background: rgba(0,0,0,0.03); color: var(--err-text);
    font: 500 0.76rem/1.2 'DM Sans', sans-serif; cursor: pointer;
  }
  .event-delete-btn:hover:not(:disabled) {
    background: var(--err-bg); border-color: rgba(185, 28, 28, 0.28);
  }
  .event-delete-btn:disabled { opacity: 0.5; cursor: wait; }

  /* ── All Conversations list ─────────────────────────────────────────── */

  .conv-list { display: flex; flex-direction: column; gap: 6px; }
  .conv-row-btn {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 14px; border: 1px solid var(--border); border-radius: 10px;
    background: rgba(0,0,0,0.02); cursor: pointer; text-align: left;
    transition: background 120ms, border-color 120ms;
  }
  .conv-row-btn:hover { background: rgba(0,0,0,0.05); border-color: rgba(0,0,0,0.14); }
  .conv-id { flex: 1; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.84rem; }
  .conv-last { color: var(--subtle); font-size: 0.78rem; }

  .usage-table-wrap { overflow-x: auto; }
  .usage-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
  .usage-table th, .usage-table td {
    padding: 8px 10px; border-bottom: 1px solid var(--border);
    text-align: left; white-space: nowrap;
  }
  .usage-table th {
    color: var(--subtle); font-size: 0.68rem;
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  .usage-table code { font-size: 0.72rem; }

  .status-pill {
    display: inline-flex; padding: 2px 9px; border-radius: 999px;
    font-size: 0.7rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  }
  .status-pill.running { background: var(--ok-bg); color: var(--ok-text); border: 1px solid var(--ok-border); }

  @media (max-width: 640px) {
    .tab-btn { padding: 9px 12px; font-size: 0.82rem; min-width: 60px; }
    .config-grid { grid-template-columns: 1fr; }
    .config-row { grid-template-columns: 1fr; gap: 4px; }
    .portal-frame { min-height: 520px; }
    .workspace-split { grid-template-columns: 1fr; }
    .workspace-tree, .workspace-preview { max-height: 260px; }
  }
`;
