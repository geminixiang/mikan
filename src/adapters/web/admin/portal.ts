import { validateEventFilename } from "../../../events/index.js";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join, resolve as pathResolve, sep as pathSep } from "node:path";
import { MikanModels, parseFrontmatter } from "../../../harness/index.js";
import { SessionStore } from "../../../sessions/session-store.js";
import type { EventStore } from "../../../events/index.js";
import type { PlatformName } from "../../../adapter.js";
import { InMemoryTokenStore } from "../token-store.js";
import type { AdminToken } from "./types.js";
export type { AdminToken } from "./types.js";

const ADMIN_TOKEN_TTL_MS = 30 * 60 * 1000;

export class InMemoryAdminTokenStore extends InMemoryTokenStore<AdminToken> {
  create(args: {
    platform: PlatformName;
    platformUserId: string;
    conversationId: string;
    platformUserName?: string;
  }): AdminToken {
    this.deleteWhere(
      (token) => token.platform === args.platform && token.platformUserId === args.platformUserId,
    );
    return this.createRecord(ADMIN_TOKEN_TTL_MS, {
      platform: args.platform,
      platformUserId: args.platformUserId,
      ...(args.platformUserName ? { platformUserName: args.platformUserName } : {}),
      conversationId: args.conversationId,
    });
  }
}

import {
  loadOfficeVisibilityOverride,
  loadGlobalSettings,
  loadScopeMcpServers,
  resolveConversationSettings,
  type AgentConfig,
  type SandboxSettings,
} from "../../../config.js";
import { findMcpPreset, listMcpPresets, materializeMcpPreset } from "../../../harness/mcp.js";
import { loadMcpTools } from "../../../harness/mcp.js";
import {
  isValidMcpServerName,
  parseStandardMcpServers,
  redactMcpUrl,
} from "../../../harness/mcp.js";
import type { McpServerConfig } from "../../../harness/types.js";
import {
  applyConversationSettings,
  applyOfficeVisibility,
  applyGlobalSettings,
} from "../../../settings-mutation.js";
import {
  escapeHtml,
  jsonResponse as jsonRes,
  readJsonBody,
  renderPortalShell,
} from "../portal-shell.js";
import { resolveExistingSessionFile } from "../session-view/portal.js";
import { PRODUCT_NAME } from "../../../platform-messages.js";
import { credentialAuthorizationKey } from "../../../sandbox/identity.js";
import { resolveWorkspaceProjection } from "../../../office/projection.js";
import { sharedVaultKey } from "../../../vault/index.js";
import { modelKey, resolveAdminModelAccessStatuses } from "./provider-models.js";

export type { AdminRuntimeBridge, AdminServices, EventSummary } from "./types.js";
import type { AdminServices, EventSummary } from "./types.js";
import type { OfficeAddress } from "../../../adapter.js";
import {
  assertPlatformName,
  createOfficeAddress,
  listRegisteredOffices,
  sameOffice,
  type Office,
  type Workspace,
} from "../../../office/index.js";

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
    await routeGetApiRequest(res, url, services);
    return;
  }
  if (req.method !== "POST") {
    jsonRes(res, 405, { error: "Method not allowed" });
    return;
  }
  await routePostApiRequest(req, res, url, services);
}

async function routeGetApiRequest(
  res: ServerResponse,
  url: URL,
  services: AdminServices,
): Promise<void> {
  const token = services.adminTokenStore.peek(url.searchParams.get("token") ?? "");
  if (!token) {
    jsonRes(res, 403, { error: "Unauthorized" });
    return;
  }
  switch (url.pathname) {
    case "/admin/api/conversations":
      return serveConversationsList(res, services);
    case "/admin/api/session-usage":
      return serveSessionUsage(res, services);
    case "/admin/api/conversation-usage":
      return serveConversationUsage(res, url, services);
    case "/admin/api/conversation-state":
      return serveConversationState(res, url, services, token);
    case "/admin/api/settings/global":
      return serveGlobalSettings(res);
    case "/admin/api/models":
      return serveModelsList(res);
    case "/admin/api/workspace/tree":
      return serveWorkspaceTree(res, url, services, token);
    case "/admin/api/workspace/file":
      return serveWorkspaceFile(res, url, services, token);
    case "/admin/api/skills":
      return serveSkillsList(res, url, services, token);
    case "/admin/api/skills/file":
      return serveSkillFile(res, url, services, token);
    case "/admin/api/mcp-servers":
      return serveMcpServersList(res, url, services, token);
    case "/admin/api/events":
      return serveEventsList(res, services);
    case "/admin/api/conversations/events":
      return serveConversationEventsList(res, url, services, token);
    default:
      jsonRes(res, 404, { error: "Not found" });
  }
}

async function routePostApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  services: AdminServices,
): Promise<void> {
  const body = await readJsonBody(req, res, 32 * 1024);
  if (!body) return;
  const token = services.adminTokenStore.peek(typeof body.token === "string" ? body.token : "");
  if (!token) {
    jsonRes(res, 403, { error: "Unauthorized" });
    return;
  }
  switch (url.pathname) {
    case "/admin/api/conversations/model":
      return serveConversationModelUpdate(res, body, services, token);
    case "/admin/api/conversations/visibility":
      return serveConversationVisibilityUpdate(res, body, services, token);
    case "/admin/api/conversations/slack":
      return serveConversationSlackUpdate(res, body, services, token);
    case "/admin/api/conversations/session-link":
      return serveConversationSessionLink(res, body, services, token);
    case "/admin/api/conversations/login-link":
      return serveConversationLoginLink(res, body, services, token);
    case "/admin/api/conversations/events/delete":
      return serveConversationEventDelete(res, body, services, token);
    case "/admin/api/mcp-servers/mutate":
      return serveMcpServerMutation(res, body, services, token);
    case "/admin/api/settings/model":
      return serveGlobalModelUpdate(res, body, services);
    case "/admin/api/settings/sandbox":
      return serveGlobalSandboxUpdate(res, body, services);
    case "/admin/api/settings/slack":
      return serveGlobalSlackUpdate(res, body, services);
    default:
      jsonRes(res, 404, { error: "Not found" });
  }
}

// ── Scope helpers ──────────────────────────────────────────────────────────────

interface AdminConversationScope {
  address: OfficeAddress;
  conversationId: string;
  error?: string;
}

/**
 * Admin scope is a full office address. The platform defaults to the token's
 * (an admin invoked from Slack browses Slack offices); cross-platform targets
 * name theirs explicitly. Identity validation is the address factory's.
 */
export function resolveConversationScope(
  requestedId: string,
  requestedPlatform: string,
  token: AdminToken,
): AdminConversationScope {
  const fallback = createOfficeAddress(token.platform, token.conversationId);
  try {
    const address = createOfficeAddress(
      requestedPlatform ? assertPlatformName(requestedPlatform) : token.platform,
      requestedId || token.conversationId,
    );
    return { address, conversationId: address.conversationId };
  } catch {
    return {
      address: fallback,
      conversationId: fallback.conversationId,
      error: "Invalid conversation scope.",
    };
  }
}

function resolveTargetConversation(
  body: Record<string, unknown>,
  token: AdminToken,
): AdminConversationScope {
  const requested = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  const platform = typeof body.platform === "string" ? body.platform.trim() : "";
  return resolveConversationScope(requested, platform, token);
}

function requireAdminWorkspace(res: ServerResponse, services: AdminServices): Workspace | null {
  if (!services.workspace) {
    jsonRes(res, 503, { error: "Working directory not available" });
    return null;
  }
  return services.workspace;
}

function requireConversationWorkspace(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
  token: AdminToken,
): { scope: AdminConversationScope; workspace: Workspace } | undefined {
  const scope = resolveTargetConversation(body, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return undefined;
  }
  const workspace = requireAdminWorkspace(res, services);
  return workspace ? { scope, workspace } : undefined;
}

// ── API handlers ───────────────────────────────────────────────────────────────

/**
 * Office directories are office-key named and not reversible to raw ids, so
 * enumeration reads the office registry — the durable raw-id ↔ office
 * mapping — instead of scanning the workspace. Offices whose directory
 * disappeared are filtered out.
 */
function listAdminOffices(workspace: Workspace): OfficeAddress[] {
  return listRegisteredOffices(workspace.stateDir)
    .filter((office) => existsSync(workspace.office(office).dir))
    .map((office) => createOfficeAddress(office.platform, office.conversationId))
    .toSorted(
      (a, b) =>
        a.platform.localeCompare(b.platform) || a.conversationId.localeCompare(b.conversationId),
    );
}

function conversationLastActivity(workspace: Workspace, office: OfficeAddress): number | null {
  const dir = workspace.office(office).dir;
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

function conversationDisplayLabel(services: AdminServices, office: OfficeAddress): string {
  const bot = services.botsByPlatform?.[office.platform];
  const channel = bot?.getMessagingInfo().channels.find((c) => c.id === office.conversationId);
  if (channel) return `${office.platform}:#${channel.name}:${office.conversationId}`;
  return `${office.platform}:${office.conversationId}`;
}

function serveConversationsList(res: ServerResponse, services: AdminServices): void {
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;

  const running = services.runtime?.getRunningSessions() ?? [];

  const conversations = listAdminOffices(workspace).map((office) => ({
    platform: office.platform,
    conversationId: office.conversationId,
    label: conversationDisplayLabel(services, office),
    running: running.some((session) => sameOffice(session.address, office)),
    lastActivityAt: conversationLastActivity(workspace, office),
  }));

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

async function serveSessionUsage(res: ServerResponse, services: AdminServices): Promise<void> {
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;

  const usageLists: SessionUsageRow[][] = [];
  for (const office of listAdminOffices(workspace)) {
    usageLists.push(
      await listConversationSessionUsage(
        workspace,
        office,
        conversationDisplayLabel(services, office),
      ),
    );
  }
  const rows = usageLists
    .flat()
    .toSorted((a, b) => b.total - a.total)
    .slice(0, 20);

  jsonRes(res, 200, { sessions: rows });
}

async function listConversationSessionUsage(
  workspace: Workspace,
  office: OfficeAddress,
  label: string,
): Promise<SessionUsageRow[]> {
  const sessionDir = workspace.office(office).sessionsDir;
  let files: string[];
  try {
    files = readdirSync(sessionDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const rows: SessionUsageRow[] = [];
  for (const name of files) {
    rows.push(...(await readSessionUsage(join(sessionDir, name), office.conversationId, label)));
  }
  return rows;
}

async function readSessionUsage(
  sessionFile: string,
  conversationId: string,
  label: string,
): Promise<SessionUsageRow[]> {
  try {
    const manager = await SessionStore.inspect(sessionFile);
    const header = manager.getHeader();

    const entries = await manager.getEntries();
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
        updatedAt:
          entries.length > 0 ? new Date(entries.at(-1)!.timestamp).toISOString() : header.timestamp,
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

interface UsageBucket {
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

function localDayKey(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function emptyBucket(date: string): UsageBucket {
  return { date, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

/** Per-conversation daily token usage over the last N days (N clamped to 1..7). */
async function serveConversationUsage(
  res: ServerResponse,
  url: URL,
  services: AdminServices,
): Promise<void> {
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;

  const conversationId = (url.searchParams.get("conversationId") ?? "").trim();
  const platformParam = (url.searchParams.get("platform") ?? "").trim();
  const office = listAdminOffices(workspace).find(
    (candidate) =>
      candidate.conversationId === conversationId &&
      (!platformParam || candidate.platform === platformParam),
  );
  if (!office) {
    jsonRes(res, 400, { error: "Unknown conversationId" });
    return;
  }

  const days = 14;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const buckets = new Map<string, UsageBucket>();
  const order: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = localDayKey(d);
    order.push(key);
    buckets.set(key, emptyBucket(key));
  }
  const cutoff = new Date(today);
  cutoff.setDate(today.getDate() - (days - 1));

  const flags = { hasOlder: false };
  const sessionDir = workspace.office(office).sessionsDir;
  try {
    for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      await accumulateSessionUsageByDay(join(sessionDir, entry.name), cutoff, buckets, flags);
    }
  } catch {
    // No sessions directory yet — return empty buckets.
  }

  const series = order.map((key) => buckets.get(key) ?? emptyBucket(key));
  const totals = series.reduce((sum, b) => {
    sum.input += b.input;
    sum.output += b.output;
    sum.cacheRead += b.cacheRead;
    sum.cacheWrite += b.cacheWrite;
    sum.total += b.total;
    sum.cost += b.cost;
    return sum;
  }, emptyBucket(""));

  jsonRes(res, 200, {
    platform: office.platform,
    conversationId,
    label: conversationDisplayLabel(services, office),
    days,
    hasOlder: flags.hasOlder,
    buckets: series,
    totals: {
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      total: totals.total,
      cost: totals.cost,
    },
  });
}

async function accumulateSessionUsageByDay(
  sessionFile: string,
  cutoff: Date,
  buckets: Map<string, UsageBucket>,
  flags: { hasOlder: boolean },
): Promise<void> {
  try {
    const manager = await SessionStore.inspect(sessionFile);

    for (const entry of await manager.getEntries()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const usage = (entry.message as unknown as AssistantUsageMessage).usage;
      if (!usage || !entry.timestamp) continue;

      const when = new Date(entry.timestamp);
      if (Number.isNaN(when.getTime())) continue;
      if (when < cutoff) {
        flags.hasOlder = true;
        continue;
      }

      const bucket = buckets.get(localDayKey(when));
      if (!bucket) continue;

      const input = numberOrZero(usage.input);
      const output = numberOrZero(usage.output);
      const cacheRead = numberOrZero(usage.cacheRead);
      const cacheWrite = numberOrZero(usage.cacheWrite);
      bucket.input += input;
      bucket.output += output;
      bucket.cacheRead += cacheRead;
      bucket.cacheWrite += cacheWrite;
      bucket.total += input + output + cacheRead + cacheWrite;
      bucket.cost += numberOrZero(usage.cost?.total);
    }
  } catch {
    // Skip unreadable session files.
  }
}

function serveConversationState(
  res: ServerResponse,
  url: URL,
  services: AdminServices,
  token: AdminToken,
): void {
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;

  const scope = resolveConversationFromQuery(url, token);
  if (scope.error) {
    jsonRes(res, 400, { error: scope.error });
    return;
  }
  const conversationId = scope.conversationId;

  const office = workspace.office(scope.address);
  const globalConfig = loadGlobalSettings();
  const conversationConfig = resolveConversationSettings(office);
  const conversationWorkspace = resolveWorkspaceProjection(office);

  jsonRes(res, 200, {
    conversationId,
    provider: conversationConfig.provider,
    model: conversationConfig.model,
    thinkingLevel: conversationConfig.thinkingLevel,
    globalProvider: globalConfig.provider,
    globalModel: globalConfig.model,
    globalThinkingLevel: globalConfig.thinkingLevel,
    officeVisibility: conversationWorkspace.visibility,
    officeVisibilitySource: conversationWorkspace.source,
    officeVisibilityOverride: loadOfficeVisibilityOverride(office),
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
      sandboxCpus: config.sandbox?.cpus ?? null,
      sandboxMemory: config.sandbox?.memory ?? null,
      sandboxBoostCpus: config.sandbox?.boost?.cpus ?? null,
      sandboxBoostMemory: config.sandbox?.boost?.memory ?? null,
      defaultSharedVault: config.sandbox?.defaultSharedVault ?? null,
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
    const registry = MikanModels.create();
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

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

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
  const target = requireConversationWorkspace(res, body, services, token);
  if (!target) return;
  const { scope, workspace } = target;

  try {
    const result = applyConversationSettings(services.runtime, workspace.office(scope.address), {
      provider,
      model,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
    if (!result.ok) {
      jsonRes(res, 409, {
        error: "Conversation has a running job; retry after it finishes (or /stop it).",
      });
      return;
    }
    jsonRes(res, 200, { ok: true, runtimeSwitched: result.runtimeSwitched });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function serveConversationVisibilityUpdate(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
  token: AdminToken,
): void {
  if (body.visibility !== "private" && body.visibility !== "default") {
    jsonRes(res, 400, { error: "visibility must be 'private' or 'default'" });
    return;
  }
  const target = requireConversationWorkspace(res, body, services, token);
  if (!target) return;
  const { scope, workspace } = target;
  try {
    const result = applyOfficeVisibility(
      services.runtime,
      workspace.office(scope.address),
      body.visibility === "private" ? "private" : null,
    );
    if (!result.ok) {
      jsonRes(res, 409, { error: "Conversation is busy; retry when the current run finishes" });
      return;
    }
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
  const target = requireConversationWorkspace(res, body, services, token);
  if (!target) return;
  const { scope, workspace } = target;
  respondWithSettingsUpdate(res, () => {
    applyConversationSettings(services.runtime, workspace.office(scope.address), {
      slack: { replyMode },
    });
    return { ok: true };
  });
}

function serveConversationSessionLink(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
  token: AdminToken,
): void {
  const target = requireConversationWorkspace(res, body, services, token);
  if (!target) return;
  const { scope, workspace } = target;
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
    workspace.office(scope.address).dir,
    scope.conversationId,
  );
  if (!sessionFile) {
    jsonRes(res, 404, { error: "No session file found for this conversation" });
    return;
  }

  try {
    const { token: viewToken } = services.sessionViewTokenStore.create({
      platform: token.platform,
      platformUserId: token.platformUserId,
      conversationId: scope.conversationId,
      sessionKey: scope.conversationId,
      sessionFile,
      platformUserName: token.platformUserName,
    });
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
      vaultId = credentialAuthorizationKey(services.sandbox, {
        userId: token.platformUserId,
        address: scope.address,
      });
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

function serveGlobalModelUpdate(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
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

  respondWithSettingsUpdate(res, () => {
    const result = applyGlobalSettings(services.runtime, {
      provider,
      model,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
    return {
      ok: true,
      staleConversations: result.staleConversations.map(
        (office) => `${office.platform}:${office.conversationId}`,
      ),
    };
  });
}

function serveGlobalSlackUpdate(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
): void {
  const replyMode = body.replyMode;
  if (replyMode !== "top-level" && replyMode !== "thread") {
    jsonRes(res, 400, { error: "replyMode must be 'top-level' or 'thread'" });
    return;
  }

  respondWithSettingsUpdate(res, () => {
    applyGlobalSettings(services.runtime, { slack: { replyMode } });
    return { ok: true };
  });
}

function serveGlobalSandboxUpdate(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
): void {
  const cpus = typeof body.cpus === "string" ? body.cpus.trim() : "";
  const memory = typeof body.memory === "string" ? body.memory.trim() : "";
  const boostCpus = typeof body.boostCpus === "string" ? body.boostCpus.trim() : "";
  const boostMemory = typeof body.boostMemory === "string" ? body.boostMemory.trim() : "";
  const update: SandboxSettings = {
    ...(cpus ? { cpus } : {}),
    ...(memory ? { memory } : {}),
    ...(boostCpus || boostMemory
      ? {
          boost: {
            ...(boostCpus ? { cpus: boostCpus } : {}),
            ...(boostMemory ? { memory: boostMemory } : {}),
          },
        }
      : {}),
  };

  if (Object.keys(update).length === 0) {
    jsonRes(res, 400, { error: "No valid sandbox fields provided" });
    return;
  }

  respondWithSettingsUpdate(res, () => {
    applyGlobalSettings(services.runtime, { sandbox: update });
    return { ok: true };
  });
}

function respondWithSettingsUpdate(res: ServerResponse, update: () => object): void {
  try {
    jsonRes(res, 200, update());
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Workspace ──────────────────────────────────────────────────────────────────

const WORKSPACE_TREE_MAX_DEPTH = 4;
const WORKSPACE_TREE_MAX_ENTRIES = 800;
const PREVIEW_FILE_MAX_BYTES = 256 * 1024;

const WORKSPACE_TOP_DIRS = new Set(["scratch"]);

/**
 * Limit what the admin UI can browse under a conversation directory.
 * Allowed: top-level "scratch/" subtree.
 */
function isWorkspacePathAllowed(rel: string): boolean {
  if (rel === "") return true;
  const first = rel.split("/").find(Boolean);
  if (first === undefined) return true;
  return WORKSPACE_TOP_DIRS.has(first);
}

function resolveConversationFromQuery(url: URL, token: AdminToken): AdminConversationScope {
  const requested = (url.searchParams.get("conversationId") ?? "").trim();
  const platform = (url.searchParams.get("platform") ?? "").trim();
  return resolveConversationScope(requested, platform, token);
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
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;
  const convDir = workspace.office(scope.address).dir;
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
    if (byte === undefined || byte === 0) return false;
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
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;
  const requestedPath = (url.searchParams.get("path") ?? "").trim();
  if (!requestedPath) {
    jsonRes(res, 400, { error: "Missing path" });
    return;
  }
  if (!isWorkspacePathAllowed(requestedPath)) {
    jsonRes(res, 403, { error: "Workspace path is not exposed" });
    return;
  }
  const convDir = workspace.office(scope.address).dir;
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

/**
 * Read skill metadata via the harness frontmatter parser (the owning module).
 * The portal historically accepted frontmatter keys case-insensitively, so
 * the lookup — not the parser — preserves that leniency.
 */
function readSkillMeta(filePath: string): { name?: string; description?: string } {
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    return {};
  }
  const { values } = parseFrontmatter(text);
  const out: { name?: string; description?: string } = {};
  for (const [key, value] of Object.entries(values)) {
    const normalized = key.toLowerCase();
    if (normalized === "name") out.name = value;
    if (normalized === "description") out.description = value;
  }
  return out;
}

export function readSkillsFromDir(skillsDir: string, source: SkillEntry["source"]): SkillEntry[] {
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
    const meta = readSkillMeta(skillMd);
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

/**
 * List MCP servers for both scopes, with env/header VALUES redacted to key
 * names: they carry API keys, and this response renders in a browser. The
 * panel edits full entries but only ever needs to show which keys exist.
 */
function serveMcpServersList(
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
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;
  const servers = loadScopeMcpServers(workspace.office(scope.address));
  jsonRes(res, 200, {
    conversationId: scope.conversationId,
    presets: listMcpPresets(),
    global: redactMcpServers(servers.global),
    conversation: redactMcpServers(servers.conversation),
  });
}

function redactMcpServers(map: Record<string, McpServerConfig>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(map).map(([name, config]) => [
      name,
      {
        ...(config.command !== undefined ? { command: config.command } : {}),
        ...(config.args !== undefined ? { args: config.args } : {}),
        ...(config.url !== undefined ? { url: redactMcpUrl(config.url) } : {}),
        ...(config.disabled !== undefined ? { disabled: config.disabled } : {}),
        envKeys: Object.keys(config.env ?? {}),
        headerKeys: Object.keys(config.headers ?? {}),
      },
    ]),
  );
}

function mcpStringMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && k.trim()) out[k.trim()] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const MCP_VERIFY_TIMEOUT_MS = 20_000;

type McpVerifyResult = { name: string; tools: number } | { name: string; error: string };

/**
 * Connect to the given servers once, the way the runner will, and report per
 * server either the tool count or the server's own error text. This is the
 * difference between "settings.json was written" and "it works": the runner
 * only logs load failures host-side, so without this the portal is the only
 * place an operator can learn that a pasted token is wrong.
 *
 * For stdio entries this runs the configured command on the host now, at save
 * time, rather than at the next message.
 */
async function verifyMcpServers(
  servers: Record<string, McpServerConfig>,
): Promise<McpVerifyResult[]> {
  const names = Object.keys(servers);
  if (names.length === 0) return [];
  const loaded = await loadMcpTools(servers, AbortSignal.timeout(MCP_VERIFY_TIMEOUT_MS));
  try {
    return names.map((name) => {
      const failure = loaded.errors.find((e) => e.server === name);
      if (failure) {
        const url = servers[name]?.url;
        const error = url ? failure.error.split(url).join(redactMcpUrl(url)) : failure.error;
        return { name, error };
      }
      const prefix = `mcp__${name}__`;
      return { name, tools: loaded.tools.filter((t) => t.name.startsWith(prefix)).length };
    });
  } finally {
    await loaded.dispose();
  }
}

type McpMutationPlan =
  | { next: Record<string, McpServerConfig>; touched: Record<string, McpServerConfig> }
  | { status: number; error: string };

/**
 * Compute the scope's next server map for one mutation. `import` takes the
 * cross-client `mcpServers` JSON verbatim (see `parseStandardMcpServers`) and
 * replaces every named entry outright — a pasted declaration is the whole
 * truth for that server, so no env/header carry-over from the previous entry.
 * `touched` lists the entries to connection-check after the write.
 */
function planMcpMutation(
  action: "import" | "install" | "remove" | "toggle",
  body: Record<string, unknown>,
  current: Record<string, McpServerConfig>,
): McpMutationPlan {
  const next: Record<string, McpServerConfig> = { ...current };
  if (action === "import") {
    const parsed = parseStandardMcpServers(typeof body.json === "string" ? body.json : "");
    if (!parsed.servers) return { status: 400, error: parsed.error };
    Object.assign(next, parsed.servers);
    return { next, touched: parsed.servers };
  }
  const preset =
    action === "install" && typeof body.presetId === "string"
      ? findMcpPreset(body.presetId)
      : undefined;
  if (action === "install" && !preset) return { status: 400, error: "unknown MCP preset" };
  const name = preset?.serverName ?? (typeof body.name === "string" ? body.name.trim() : "");
  if (!isValidMcpServerName(name)) {
    return {
      status: 400,
      error: "invalid server name (letters, digits, '_' or '-', starting with a letter)",
    };
  }
  if (action === "install") {
    try {
      next[name] = materializeMcpPreset(preset!, mcpStringMap(body.credentials) ?? {});
    } catch (err) {
      return { status: 400, error: err instanceof Error ? err.message : String(err) };
    }
    return { next, touched: { [name]: next[name] } };
  }
  if (!(name in next)) return { status: 404, error: "Not declared here." };
  if (action === "remove") {
    delete next[name];
    return { next, touched: {} };
  }
  const entry = next[name]!;
  next[name] = entry.disabled ? { ...entry, disabled: undefined } : { ...entry, disabled: true };
  return { next, touched: {} };
}

/**
 * Import / install / remove / toggle / test MCP servers in one scope. Reads
 * the scope's raw map, applies the change, and writes the full map back
 * wholesale because merging would make removal impossible. Runner
 * caches refresh via applyGlobalSettings/applyConversationSettings.
 *
 * Writes persist even when the follow-up connection check fails: the
 * operator edits the entry, not retypes it. `test` re-checks an existing
 * entry without writing.
 */
async function serveMcpServerMutation(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
  token: AdminToken,
): Promise<void> {
  const action = body.action;
  if (
    action !== "import" &&
    action !== "install" &&
    action !== "remove" &&
    action !== "toggle" &&
    action !== "test"
  ) {
    jsonRes(res, 400, {
      error: "action must be 'import', 'install', 'remove', 'toggle', or 'test'",
    });
    return;
  }
  const mutationScope = body.scope === "global" ? "global" : "conversation";
  const scope = resolveTargetConversation(body, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return;
  }
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;
  const office = workspace.office(scope.address);
  const maps = loadScopeMcpServers(office);
  const current = mutationScope === "global" ? maps.global : maps.conversation;

  if (action === "test") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const entry = current[name];
    if (!entry) {
      jsonRes(res, 404, { error: "Not declared here." });
      return;
    }
    const results = await verifyMcpServers({ [name]: { ...entry, disabled: undefined } });
    jsonRes(res, 200, { ok: true, results });
    return;
  }

  const plan = planMcpMutation(action, body, current);
  if ("error" in plan) {
    jsonRes(res, plan.status, { error: plan.error });
    return;
  }
  const result =
    mutationScope === "global"
      ? applyGlobalSettings(services.runtime, { mcpServers: plan.next })
      : applyConversationSettings(services.runtime, office, { mcpServers: plan.next });
  if (!result.ok) {
    jsonRes(res, 409, { error: "Conversation is busy; try again shortly." });
    return;
  }
  const results = await verifyMcpServers(plan.touched);
  jsonRes(res, 200, { ok: true, results });
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
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;
  const global = readSkillsFromDir(workspace.skillsDir, "global");
  const conversation = readSkillsFromDir(workspace.office(scope.address).skillsDir, "conversation");
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
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;

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
    source === "global" ? workspace.skillsDir : workspace.office(scope.address).skillsDir;
  const safe = safeJoinUnderRoot(skillsRoot, join(directory, "SKILL.md"));
  if (safe.error) {
    jsonRes(res, 400, { error: safe.error });
    return;
  }

  servePreviewFile(res, safe.absolute, { source, directory }, "Skill file not found");
}

// ── Events ─────────────────────────────────────────────────────────────────────

/**
 * List events through the owning store, whose payloads are validated by the
 * event-format module (files that fail validation stay visible with a null
 * payload so operators can delete them).
 */
export async function listOfficeEvents(store: EventStore): Promise<EventSummary[]> {
  const entries = await store.list();
  return entries.map((entry) => {
    const payload = entry.payload;
    return {
      name: entry.filename,
      officePlatform: store.address.platform,
      officeConversationId: store.address.conversationId,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      type: payload?.type ?? null,
      platform: payload?.platform ?? null,
      conversationId: payload?.conversationId ?? null,
      text: payload?.text ?? null,
      at: payload?.type === "one-shot" ? payload.at : null,
      schedule: payload?.type === "periodic" ? payload.schedule : null,
      timezone: payload?.type === "periodic" ? payload.timezone : null,
    };
  });
}

function requireAdminEventStore(
  res: ServerResponse,
  services: AdminServices,
  office: Office,
): EventStore | null {
  if (!services.eventStore) {
    jsonRes(res, 503, { error: "Working directory not available" });
    return null;
  }
  return services.eventStore(office);
}

/** Every registered office's events, each read through its own store. */
async function serveEventsList(res: ServerResponse, services: AdminServices): Promise<void> {
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;
  if (!services.eventStore) {
    jsonRes(res, 503, { error: "Working directory not available" });
    return;
  }
  const events: EventSummary[] = [];
  for (const record of listRegisteredOffices(workspace.stateDir)) {
    events.push(...(await listOfficeEvents(services.eventStore(workspace.office(record)))));
  }
  jsonRes(res, 200, { events });
}

/** Per-conversation listing through that office's confined store. */
async function serveConversationEventsList(
  res: ServerResponse,
  url: URL,
  services: AdminServices,
  token: AdminToken,
): Promise<void> {
  const scope = resolveConversationFromQuery(url, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return;
  }
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;
  const store = requireAdminEventStore(res, services, workspace.office(scope.address));
  if (!store) return;
  jsonRes(res, 200, {
    conversationId: scope.conversationId,
    events: await listOfficeEvents(store),
  });
}

/** Delete a single event file scoped to the caller's conversation. */
async function serveConversationEventDelete(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
  token: AdminToken,
): Promise<void> {
  const scope = resolveTargetConversation(body, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return;
  }
  let name: string;
  try {
    name = validateEventFilename(typeof body.name === "string" ? body.name : "");
  } catch {
    jsonRes(res, 400, { error: "Invalid name" });
    return;
  }
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;
  const store = requireAdminEventStore(res, services, workspace.office(scope.address));
  if (!store) return;
  // The store is confined to this office: another office's filename is "not found".
  try {
    await store.delete(name);
    jsonRes(res, 200, { ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    jsonRes(res, /not found/.test(message) ? 404 : 500, { error: message });
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────────

const esc = escapeHtml;

// ── HTML ───────────────────────────────────────────────────────────────────────

const adminViewBody = `<nav class="tab-nav" role="tablist" aria-label="Admin sections">
      <button class="tab-btn active" role="tab" aria-selected="true" aria-controls="panel-conversation" data-tab="conversation">Conversation</button>
      <button class="tab-btn" role="tab" aria-selected="false" aria-controls="panel-global" data-tab="global">Global</button>
    </nav>

    <div class="tab-panel active" id="panel-conversation">
      <details class="card sect" id="sect-settings" data-section="settings" open>
        <summary class="sect-head">
          <div class="sect-title"><span class="sect-caret" aria-hidden="true">▸</span><div>
            <p class="eyebrow">Settings</p>
            <h2 class="card-title">模型 / Thinking / Auto-reply / Workspace mount</h2>
          </div></div>
          <button class="refresh-btn" onclick="event.stopPropagation(); loadSettings()">↻</button>
        </summary>
        <div class="sect-body">
          <div id="settings-content"><div class="loading-msg">Loading…</div></div>
        </div>
      </details>

      <details class="card sect" id="sect-workspace" data-section="workspace">
        <summary class="sect-head">
          <div class="sect-title"><span class="sect-caret" aria-hidden="true">▸</span><div>
            <p class="eyebrow">Workspace</p>
            <h2 class="card-title">檔案瀏覽 (只讀)</h2>
          </div></div>
          <button class="refresh-btn" onclick="event.stopPropagation(); loadWorkspace()">↻</button>
        </summary>
        <div class="sect-body">
          <div class="workspace-split">
            <div id="workspace-tree" class="workspace-tree"><div class="loading-msg">Loading…</div></div>
            <div id="workspace-preview" class="workspace-preview"><div class="placeholder-msg">Click a file to preview</div></div>
          </div>
        </div>
      </details>

      <details class="card sect" id="sect-skills" data-section="skills">
        <summary class="sect-head">
          <div class="sect-title"><span class="sect-caret" aria-hidden="true">▸</span><div>
            <p class="eyebrow">Skills</p>
            <h2 class="card-title">可用的 skills</h2>
          </div></div>
          <button class="refresh-btn" onclick="event.stopPropagation(); loadSkills()">↻</button>
        </summary>
        <div class="sect-body">
          <div class="workspace-split">
            <div id="skills-content" class="workspace-tree"><div class="loading-msg">Loading…</div></div>
            <div id="skills-preview" class="workspace-preview"><div class="placeholder-msg">Click a skill to preview SKILL.md</div></div>
          </div>
        </div>
      </details>

      <details class="card sect" id="sect-mcp" data-section="mcp">
        <summary class="sect-head">
          <div class="sect-title"><span class="sect-caret" aria-hidden="true">▸</span><div>
            <p class="eyebrow">MCP Servers</p>
            <h2 class="card-title">此對話的 MCP servers</h2>
          </div></div>
          <button class="refresh-btn" onclick="event.stopPropagation(); loadMcpServers()">↻</button>
        </summary>
        <div class="sect-body">
          <div id="mcp-conv-msg" class="status-msg" style="display:none"></div>
          <div id="mcp-conv-content"><div class="loading-msg">Loading…</div></div>
        </div>
      </details>

      <details class="card sect" id="sect-vault" data-section="vault">
        <summary class="sect-head">
          <div class="sect-title"><span class="sect-caret" aria-hidden="true">▸</span><div>
            <p class="eyebrow">Vault</p>
            <h2 class="card-title">該對話的憑證</h2>
          </div></div>
          <button class="primary-action-btn" onclick="event.stopPropagation(); openLogin()">Open in new tab ↗</button>
        </summary>
        <div class="sect-body">
          <div id="vault-link-result" class="link-result" style="display:none"></div>
          <p class="card-desc">Opens the one-time credential form for this conversation's vault in a new tab.</p>
        </div>
      </details>

      <details class="card sect" id="sect-events" data-section="events">
        <summary class="sect-head">
          <div class="sect-title"><span class="sect-caret" aria-hidden="true">▸</span><div>
            <p class="eyebrow">Events</p>
            <h2 class="card-title">關聯此對話的 events</h2>
          </div></div>
          <button class="refresh-btn" onclick="event.stopPropagation(); loadConversationEvents()">↻</button>
        </summary>
        <div class="sect-body">
          <div id="events-content"><div class="loading-msg">Loading…</div></div>
        </div>
      </details>

      <details class="card sect" id="sect-session" data-section="session">
        <summary class="sect-head">
          <div class="sect-title"><span class="sect-caret" aria-hidden="true">▸</span><div>
            <p class="eyebrow">Session View</p>
            <h2 class="card-title">對話歷史檢視</h2>
          </div></div>
          <button class="primary-action-btn" onclick="event.stopPropagation(); openSessionView()">Open in new tab ↗</button>
        </summary>
        <div class="sect-body">
          <div id="session-link-result" class="link-result" style="display:none"></div>
          <p class="card-desc">Opens the session timeline for this conversation in a new tab.</p>
        </div>
      </details>
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
          </div>
          <button class="refresh-btn" onclick="loadTokenUsage()">↻</button>
        </header>
        <h2 class="card-subtitle" style="margin-bottom:10px">Top 20 sessions</h3>
        <div id="session-usage-content"><div class="loading-msg">Loading…</div></div>
        <h2 class="card-subtitle" style="margin:24px 0 10px">Usage timeline</h3>
        <div class="timeline-controls">
          <label>Conversation
            <select id="timeline-conv" onchange="loadUsageTimeline()"></select>
          </label>
        </div>
        <div id="usage-timeline-content"><div class="loading-msg">Loading…</div></div>
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
            <p class="eyebrow">Global MCP Servers</p>
            <h2 class="card-title">所有對話都可用的 MCP servers</h2>
          </div>
          <button class="refresh-btn" onclick="loadMcpServers()">↻</button>
        </header>
        <div id="mcp-global-msg" class="status-msg" style="display:none"></div>
        <div id="mcp-global-content"><div class="loading-msg">Loading…</div></div>
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
    </div>

    <dialog id="mcp-install-dialog" class="mcp-dialog" aria-labelledby="mcp-dialog-title">
      <div class="mcp-dialog-head">
        <div>
          <p class="eyebrow">Install MCP preset</p>
          <h2 id="mcp-dialog-title" class="card-title"></h2>
        </div>
        <button class="mcp-dialog-close" type="button" aria-label="Close" onclick="closeMcpInstall()">×</button>
      </div>
      <div id="mcp-dialog-content"></div>
      <div id="mcp-dialog-error" class="inline-result err" style="display:none"></div>
      <div class="mcp-dialog-actions">
        <button class="mcp-btn" type="button" onclick="closeMcpInstall()">Cancel</button>
        <button id="mcp-dialog-install" class="primary-action-btn" type="button" onclick="installMcpPreset(this)">Install preset</button>
      </div>
    </dialog>

    <dialog id="mcp-custom-dialog" class="mcp-dialog" aria-labelledby="mcp-custom-dialog-title">
      <div class="mcp-dialog-head">
        <div>
          <p class="eyebrow">Add MCP server</p>
          <h2 id="mcp-custom-dialog-title" class="card-title">新增自訂 server</h2>
        </div>
        <button class="mcp-dialog-close" type="button" aria-label="Close" onclick="closeMcpCustomDialog()">×</button>
      </div>
      <div id="mcp-custom-dialog-content"></div>
      <div id="mcp-custom-dialog-error" class="inline-result err" style="display:none"></div>
      <div class="mcp-dialog-actions">
        <button class="mcp-btn" type="button" onclick="closeMcpCustomDialog()">Cancel</button>
        <button id="mcp-custom-dialog-submit" class="primary-action-btn" type="button" onclick="submitMcpCustomDialog(this)">新增並測試連線</button>
      </div>
    </dialog>`;

const adminViewScript = `    let activeConversationKey = defaultConversationKey;
    function scopeOf(key) {
      const sep = key.indexOf(':');
      return { platform: key.slice(0, sep), conversationId: key.slice(sep + 1) };
    }
    function scopeQuery() {
      const scope = scopeOf(activeConversationKey);
      return 'conversationId=' + encodeURIComponent(scope.conversationId) +
        '&platform=' + encodeURIComponent(scope.platform);
    }
    function scopeBody() {
      const scope = scopeOf(activeConversationKey);
      return { conversationId: scope.conversationId, platform: scope.platform };
    }
    let availableModels = [];
    let modelsLoaded = false;
    let mcpPresets = [];
    let mcpServersByScope = { conversation: {}, global: {} };
    let pendingMcpInstall = null;

    // ── Helpers ──────────────────────────────────────────────────────────────────

    function escHtml(str) {
      return String(str).replace(/[&<>"']/g, (c) => (
        {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
      ));
    }
    const escAttr = escHtml;
    async function copyToClipboard(text) {
      try { await navigator.clipboard.writeText(text); } catch { prompt('Copy this link:', text); }
    }
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element
        ? event.target.closest('[data-admin-action]')
        : null;
      if (!target) return;
      switch (target.dataset.adminAction) {
        case 'preview-file':
          void previewFile(target.dataset.filePath || '');
          break;
        case 'copy-link':
          void copyToClipboard(target.dataset.copyText || '');
          break;
        case 'delete-event':
          void deleteEvent(target.dataset.eventName || '', target);
          break;
        case 'select-conversation':
          setActiveConversation(target.dataset.conversationId || '');
          switchTab('conversation');
          break;
        case 'toggle-timeline-filter':
          toggleTimelineFilter(target.dataset.filterKey || '');
          break;
      }
    });
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
          const key = c.platform + ':' + c.conversationId;
          const label = (c.label || c.conversationId) + (c.running ? ' (running)' : '');
          const selected = key === defaultConversationKey ? ' selected' : '';
          return '<option value="' + escAttr(key) + '"' + selected + '>' + escHtml(label) + '</option>';
        }).join('');
        sel.addEventListener('change', () => setActiveConversation(sel.value));
      } catch (err) {
        // ignore; conversation selector stays empty
      }
    }

    // Sections load lazily: only when their <details> is (or becomes) open,
    // so switching conversations or opening the admin page doesn't fire every
    // API at once. sectionLoaded is cleared on conversation switch so an
    // already-open section refetches for the new scope.
    //
    // Looked up by name (not collected into an object up front) because the
    // loaders below are const declarations further down this same script;
    // referencing them before their own line runs would hit the temporal
    // dead zone. By the time this function is actually called (after a
    // <details> toggle, always after the whole script has executed), they're
    // all initialized.
    function sectionLoader(key) {
      switch (key) {
        case 'settings': return loadSettings;
        case 'workspace': return loadWorkspace;
        case 'skills': return loadSkills;
        case 'mcp': return loadMcpServers;
        case 'events': return loadConversationEvents;
        default: return undefined;
      }
    }
    const sectionLoaded = new Set();

    function conversationSectionEls() {
      return document.querySelectorAll('#panel-conversation > details[data-section]');
    }

    function ensureSectionLoaded(key) {
      if (sectionLoaded.has(key)) return;
      const loader = sectionLoader(key);
      if (!loader) return;
      sectionLoaded.add(key);
      loader();
    }

    function initSections() {
      conversationSectionEls().forEach((el) => {
        const key = el.dataset.section;
        const stored = localStorage.getItem('admin-sect-' + key);
        if (stored !== null) el.open = stored === '1';
        if (el.open) ensureSectionLoaded(key);
        el.addEventListener('toggle', () => {
          localStorage.setItem('admin-sect-' + key, el.open ? '1' : '0');
          if (el.open) ensureSectionLoaded(key);
        });
      });
    }

    function setActiveConversation(key) {
      activeConversationKey = key;
      const sel = document.getElementById('conv-switcher');
      if (sel && sel.value !== key) sel.value = key;
      // Data is scoped to the previous conversation; drop it so any open
      // section refetches, and closed sections load fresh on next expand.
      sectionLoaded.clear();
      conversationSectionEls().forEach((el) => {
        if (el.open) ensureSectionLoaded(el.dataset.section);
      });
      openLogin(true);
      openSessionView(true);
    }

    // ── Settings ─────────────────────────────────────────────────────────────────

    const loadSettings = () => loadSettingsPanel('settings-content', () => '/admin/api/conversation-state?' + scopeQuery(), renderSettings);
    const loadGlobalSettings = () => loadSettingsPanel('global-settings-content', () => '/admin/api/settings/global', renderGlobalSettings);

    async function loadSettingsPanel(id, path, render) {
      const container = document.getElementById(id);
      container.innerHTML = '<div class="loading-msg">Loading…</div>';
      if (!modelsLoaded) await loadModels();
      try {
        const data = await apiGet(path());
        container.innerHTML = render(data);
      } catch (err) {
        container.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    function renderConfigCard(title, content, action, buttonLabel, resultId) {
      return '<div class="config-block"><h3 class="card-subtitle">' + title + '</h3>' + content +
        '<button class="primary-action-btn" onclick="' + action + '(this)">' + buttonLabel + '</button>' +
        '<div id="' + resultId + '" class="inline-result" style="display:none"></div></div>';
    }

    function renderOptions(choices, selected) {
      return choices.map(([value, label]) =>
        '<option value="' + escAttr(value) + '"' + (selected === value ? ' selected' : '') + '>' + escHtml(label) + '</option>'
      ).join('');
    }
    function renderThinkingOptions(value) {
      return renderOptions(['off','minimal','low','medium','high','xhigh','max'].map((t) => [t, t]), value);
    }
    function renderReplyOptions(slack) {
      return renderOptions(['top-level','thread'].map((m) => [m, m]), (slack && slack.replyMode) || 'top-level');
    }
    function renderSettings(data) {
      const thinkingOpts = renderThinkingOptions(data.thinkingLevel);
      const replyModeOpts = renderReplyOptions(data.slack);
      const globalReplyMode = (data.slack && data.slack.globalReplyMode) || 'top-level';
      const globalModel = [data.globalProvider, data.globalModel].filter(Boolean).join('/');
      const globalModelLabel = globalModel + (data.globalThinkingLevel ? ':' + data.globalThinkingLevel : '');
      return [
        '<div class="config-grid">',
          renderConfigCard('Model', [
            '<div class="config-row config-row-stack"><label>Model</label><select id="m-model-ref">' + renderModelOptions(data.provider, data.model) + '</select></div>',
            '<div class="config-row"><label>Thinking</label><select id="m-thinking">' + thinkingOpts + '</select></div>',
            '<p class="muted-note">Global default: ' + escHtml(globalModelLabel) + '</p>',
          ].join(''), 'saveModel', 'Save model', 'model-save-result'),

          renderVisibilityCard(data),
          renderConfigCard('Slack', [
            '<div class="config-row"><label>Reply mode</label><select id="m-slack-reply-mode">' + replyModeOpts + '</select></div>',
            '<p class="muted-note">Global default: ' + escHtml(globalReplyMode) + '</p>',
          ].join(''), 'saveSlack', 'Save Slack', 'slack-save-result'),
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
      await saveConversationSetting(btn, result, 'model', { provider, model, thinkingLevel }, 'Save model');
    }

    async function saveSlack(btn) {
      const replyMode = document.getElementById('m-slack-reply-mode').value;
      const result = document.getElementById('slack-save-result');
      await saveConversationSetting(btn, result, 'slack', { replyMode }, 'Save Slack');
    }

    // Only a public Slack channel has a choice to make; private channels and
    // DMs are always hidden, so the card just states that without a control.
    function renderVisibilityCard(data) {
      const hidden = data.officeVisibilityOverride === 'private';
      const canChoose = data.officeVisibilitySource === 'platform' ? data.officeVisibility === 'public' : hidden;
      if (!canChoose) {
        const why = data.officeVisibilitySource === 'platform'
          ? 'This is a DM or private channel, so its files are hidden from every other office. Slack decides this; it cannot be opened up here.'
          : 'Slack has not reported what kind of conversation this is yet, so it is treated as hidden until it does.';
        return '<div class="config-block"><h3 class="card-subtitle">Who can see the files in this office</h3>' +
          '<p><strong>Hidden</strong> — only this office.</p><p class="muted-note">' + why + '</p></div>';
      }
      return renderConfigCard('Who can see the files in this office', [
        '<div class="config-row"><label><input type="checkbox" id="m-visibility"' + (hidden ? ' checked' : '') + '> Hide the files in this channel from other offices</label></div>',
        '<p>' + (hidden
          ? '<strong>Hidden</strong> — other offices cannot read the files in this channel, and it can read shared MEMORY.md and skills but not change them.'
          : '<strong>Shared</strong> — every other office can read the files in this channel (read-only), and this channel may update shared MEMORY.md and skills.') + '</p>',
        '<p class="muted-note">Slack says this is a public channel, which is why sharing is the default. Hiding is the only change allowed; nothing can be made more visible than Slack allows.</p>',
      ].join(''), 'saveVisibility', 'Save', 'mount-save-result');
    }

    async function saveVisibility(btn) {
      const visibility = document.getElementById('m-visibility').checked ? 'private' : 'default';
      const result = document.getElementById('mount-save-result');
      await saveConversationSetting(btn, result, 'visibility', { visibility }, 'Save visibility', loadSettings);
    }

    function saveConversationSetting(btn, result, setting, values, label, onSaved) {
      return saveSetting(btn, result, 'conversations/' + setting, { ...scopeBody(), ...values }, label, onSaved);
    }

    async function saveSetting(btn, result, path, values, label, onSaved) {
      btn.disabled = true; btn.textContent = 'Saving…'; result.style.display = 'none';
      try {
        await apiPost('/admin/api/' + path, values);
        result.style.display = 'block'; result.className = 'inline-result ok'; result.textContent = 'Saved ✓';
        if (onSaved) onSaved();
      } catch (err) {
        result.style.display = 'block'; result.className = 'inline-result err'; result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = label;
      }
    }

    // ── Workspace ────────────────────────────────────────────────────────────────

    async function loadWorkspace() {
      const treeEl = document.getElementById('workspace-tree');
      const previewEl = document.getElementById('workspace-preview');
      treeEl.innerHTML = '<div class="loading-msg">Loading…</div>';
      previewEl.innerHTML = '<div class="placeholder-msg">Click a file to preview</div>';
      try {
        const data = await apiGet('/admin/api/workspace/tree?' + scopeQuery());
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
        return '<li><button class="tree-file" data-admin-action="preview-file" data-file-path="' + escAttr(node.path) + '">' + escHtml(node.name) + '</button></li>';
      }
      if (!node.children || node.children.length === 0) {
        return '<li><span class="tree-dir empty">' + escHtml(node.name || '.') + '/</span></li>';
      }
      const inner = node.children.map((c) =>
        c.type === 'file'
          ? '<li><button class="tree-file" data-admin-action="preview-file" data-file-path="' + escAttr(c.path) + '">' + escHtml(c.name) + '</button></li>'
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
        const data = await apiGet('/admin/api/workspace/file?' + scopeQuery() + '&path=' + encodeURIComponent(path));
        renderPreviewFileResult(previewEl, path, data);
      } catch (err) {
        previewEl.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    // ── Skills ───────────────────────────────────────────────────────────────────

    async function loadScopePanels(prefix, endpoint, render) {
      const convEl = document.getElementById(prefix + '-conv-content');
      const globalEl = document.getElementById(prefix + '-global-content');
      if (convEl) convEl.innerHTML = '<div class="loading-msg">Loading…</div>';
      if (globalEl) globalEl.innerHTML = '<div class="loading-msg">Loading…</div>';
      try {
        const data = await apiGet('/admin/api/' + endpoint + '?' + scopeQuery());
        render(data, convEl, globalEl);
      } catch (err) {
        if (convEl) convEl.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
        if (globalEl) globalEl.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    // ── MCP servers ───────────────────────────────────────────────────────────────────────

    function mcpMessage(scope, text, kind) {
      const el = document.getElementById(scope === 'global' ? 'mcp-global-msg' : 'mcp-conv-msg');
      if (!el) return;
      el.style.display = 'block';
      el.className = 'status-msg status-msg-' + kind;
      el.textContent = text;
    }

    function mcpTransport(server) {
      return server.command
        ? server.command + (server.args && server.args.length ? ' ' + server.args.join(' ') : '')
        : (server.url || '');
    }

    function renderMcpServer(scope, name, server) {
      const transport = (server.command ? 'stdio: ' : 'http: ') + mcpTransport(server);
      const keys = [];
      if (server.envKeys && server.envKeys.length) keys.push('env: ' + server.envKeys.join(', '));
      if (server.headerKeys && server.headerKeys.length) keys.push('headers: ' + server.headerKeys.join(', '));
      return '<article class="mcp-preset mcp-installed-card">' +
        '<div class="mcp-preset-top">' +
          '<span class="mcp-preset-category">' + (server.command ? 'STDIO' : 'HTTP') + '</span>' +
          (server.disabled ? '<span class="mcp-badge mcp-badge-warn">disabled</span>' : '<span class="mcp-badge mcp-badge-ok">enabled</span>') +
        '</div>' +
        '<h3>' + escHtml(name) + '</h3>' +
        '<p class="mcp-preset-meta mcp-installed-transport">' + escHtml(transport) + '</p>' +
        (keys.length ? '<div class="mcp-preset-meta">' + escHtml(keys.join(' · ')) + '</div>' : '') +
        '<div class="mcp-preset-actions">' +
          '<button class="mcp-btn" data-mcp-action="test" data-mcp-scope="' + scope + '" data-mcp-name="' + escAttr(name) + '">Test</button>' +
          '<button class="mcp-btn" data-mcp-action="toggle" data-mcp-scope="' + scope + '" data-mcp-name="' + escAttr(name) + '">' + (server.disabled ? 'Enable' : 'Disable') + '</button>' +
          '<button class="mcp-btn mcp-btn-danger" data-mcp-action="remove" data-mcp-scope="' + scope + '" data-mcp-name="' + escAttr(name) + '">Remove</button>' +
        '</div>' +
      '</article>';
    }

    function renderMcpPreset(scope, preset, servers) {
      const installed = Boolean(servers[preset.serverName]);
      const transport = preset.server.command ? 'Runs on host' : 'Remote service';
      return '<article class="mcp-preset">' +
        '<div class="mcp-preset-top">' +
          '<span class="mcp-preset-category">' + escHtml(preset.category) + '</span>' +
          (installed ? '<span class="mcp-badge mcp-badge-ok">Installed here</span>' : '') +
        '</div>' +
        '<h3>' + escHtml(preset.name) + '</h3>' +
        '<p>' + escHtml(preset.description) + '</p>' +
        '<div class="mcp-preset-meta">' + escHtml(transport) + ' · <code>' + escHtml(preset.serverName) + '</code></div>' +
        '<div class="mcp-preset-actions">' +
          '<a href="' + escAttr(preset.sourceUrl) + '" target="_blank" rel="noopener">Source ↗</a>' +
          '<button class="primary-action-btn" data-mcp-action="preset" data-mcp-scope="' + scope + '" data-mcp-preset="' + escAttr(preset.id) + '">' + (installed ? 'Review' : 'Install') + '</button>' +
        '</div>' +
      '</article>';
    }

    function renderMcpScope(el, scope, servers) {
      const presets = mcpPresets.map((preset) => renderMcpPreset(scope, preset, servers)).join('');
      const rows = Object.entries(servers).map(([name, server]) => renderMcpServer(scope, name, server)).join('');
      el.innerHTML =
        '<div class="mcp-market-head"><div><h3>Explore presets</h3><p>Reviewed recipes that install into this scope.</p></div><span>' + mcpPresets.length + ' available</span></div>' +
        '<div class="mcp-preset-grid">' + presets + '</div>' +
        '<details class="mcp-installed" open><summary>Installed in this scope</summary>' +
          '<div class="mcp-preset-grid">' +
            rows +
            '<button type="button" class="mcp-add-card" data-mcp-action="open-custom" data-mcp-scope="' + scope + '">' +
              '<span class="mcp-add-card-plus">+</span><span>新增 server</span>' +
            '</button>' +
          '</div>' +
        '</details>';
    }

    function renderMcpGuidedForm(scope) {
      return '<div class="mcp-guided-grid">' +
        '<label class="mcp-field"><span>Server 名稱</span><input id="mcp-' + scope + '-g-name" class="form-input mcp-json" placeholder="例如 github" autocomplete="off" /></label>' +
        '<div class="mcp-transport-toggle">' +
          '<label><input type="radio" name="mcp-' + scope + '-g-transport" value="stdio" checked /> 本機指令 (stdio)</label>' +
          '<label><input type="radio" name="mcp-' + scope + '-g-transport" value="http" /> 遠端服務 (HTTP)</label>' +
        '</div>' +
        '<div id="mcp-' + scope + '-g-stdio" class="mcp-transport-fields">' +
          '<label class="mcp-field"><span>指令</span><input id="mcp-' + scope + '-g-command" class="form-input mcp-json" placeholder="npx" autocomplete="off" /></label>' +
          '<label class="mcp-field"><span>參數（以逗號分隔）</span><input id="mcp-' + scope + '-g-args" class="form-input mcp-json" placeholder="-y, @modelcontextprotocol/server-github" autocomplete="off" /></label>' +
        '</div>' +
        '<div id="mcp-' + scope + '-g-http" class="mcp-transport-fields" style="display:none">' +
          '<label class="mcp-field"><span>URL</span><input id="mcp-' + scope + '-g-url" class="form-input mcp-json" placeholder="https://mcp.example.com/mcp" autocomplete="off" /></label>' +
        '</div>' +
        '<div class="mcp-kv-block">' +
          '<div class="mcp-kv-head"><span id="mcp-' + scope + '-g-kv-label">環境變數 (env)</span><button type="button" class="mcp-btn" data-mcp-kv-add="' + scope + '">+ 新增一列</button></div>' +
          '<div id="mcp-' + scope + '-g-kv" class="mcp-kv-rows"></div>' +
        '</div>' +
      '</div>';
    }

    function renderMcpKvRow() {
      return '<div class="mcp-kv-row">' +
        '<input class="form-input mcp-json" placeholder="KEY" data-kv-key autocomplete="off" />' +
        '<input class="form-input mcp-json" type="password" placeholder="value" data-kv-value autocomplete="off" />' +
        '<button type="button" class="mcp-btn mcp-btn-danger" data-mcp-kv-remove>移除</button>' +
      '</div>';
    }

    function addMcpGuidedRow(scope) {
      const container = document.getElementById('mcp-' + scope + '-g-kv');
      if (container) container.insertAdjacentHTML('beforeend', renderMcpKvRow());
    }

    function updateMcpGuidedTransport(scope) {
      const checked = document.querySelector('input[name="mcp-' + scope + '-g-transport"]:checked');
      const transport = checked ? checked.value : 'stdio';
      const stdioEl = document.getElementById('mcp-' + scope + '-g-stdio');
      const httpEl = document.getElementById('mcp-' + scope + '-g-http');
      const kvLabel = document.getElementById('mcp-' + scope + '-g-kv-label');
      if (stdioEl) stdioEl.style.display = transport === 'stdio' ? '' : 'none';
      if (httpEl) httpEl.style.display = transport === 'http' ? '' : 'none';
      if (kvLabel) kvLabel.textContent = transport === 'stdio' ? '環境變數 (env)' : 'HTTP Headers';
    }

    let pendingMcpCustomScope = null;

    function openMcpCustomDialog(scope) {
      pendingMcpCustomScope = scope;
      const content = document.getElementById('mcp-custom-dialog-content');
      content.innerHTML =
        '<div class="mcp-add-mode">' +
          '<button type="button" class="mcp-mode-btn active" data-mcp-mode="guided">引導式表單</button>' +
          '<button type="button" class="mcp-mode-btn" data-mcp-mode="json">貼上 JSON</button>' +
        '</div>' +
        '<div id="mcp-custom-guided-panel" class="mcp-panel">' + renderMcpGuidedForm('custom') + '</div>' +
        '<div id="mcp-custom-json-panel" class="mcp-panel" style="display:none">' +
          '<p class="mcp-manual-hint">貼上 MCP server 文件給的 <code>mcpServers</code> JSON，原樣保存到這個 scope。remote 走 Streamable HTTP，local 走 stdio。</p>' +
          '<textarea id="mcp-custom-json" class="form-input mcp-json" spellcheck="false" rows="9" placeholder="' + escAttr(MCP_JSON_PLACEHOLDER) + '"></textarea>' +
        '</div>';
      const dialogError = document.getElementById('mcp-custom-dialog-error');
      dialogError.style.display = 'none';
      dialogError.textContent = '';
      addMcpGuidedRow('custom');
      document.getElementById('mcp-custom-dialog').showModal();
    }

    function closeMcpCustomDialog() {
      pendingMcpCustomScope = null;
      document.getElementById('mcp-custom-dialog').close();
    }

    function switchMcpCustomMode(mode) {
      const guidedEl = document.getElementById('mcp-custom-guided-panel');
      const jsonEl = document.getElementById('mcp-custom-json-panel');
      if (guidedEl) guidedEl.style.display = mode === 'guided' ? '' : 'none';
      if (jsonEl) jsonEl.style.display = mode === 'json' ? '' : 'none';
      document.querySelectorAll('#mcp-custom-dialog-content [data-mcp-mode]').forEach((b) => {
        b.classList.toggle('active', b.dataset.mcpMode === mode);
      });
    }

    async function submitMcpCustomDialog(btn) {
      const scope = pendingMcpCustomScope;
      if (!scope) return;
      const dialogError = document.getElementById('mcp-custom-dialog-error');
      dialogError.style.display = 'none';
      dialogError.textContent = '';
      const jsonMode = document.getElementById('mcp-custom-json-panel').style.display !== 'none';
      let json;
      if (jsonMode) {
        const raw = document.getElementById('mcp-custom-json').value.trim();
        if (!raw) { dialogError.textContent = '請貼上 mcpServers JSON'; dialogError.style.display = 'block'; return; }
        json = raw;
      } else {
        const nameEl = document.getElementById('mcp-custom-g-name');
        const name = nameEl ? nameEl.value.trim() : '';
        if (!name) { dialogError.textContent = '請輸入 server 名稱'; dialogError.style.display = 'block'; return; }
        const checked = document.querySelector('input[name="mcp-custom-g-transport"]:checked');
        const transport = checked ? checked.value : 'stdio';
        const kv = {};
        document.querySelectorAll('#mcp-custom-g-kv .mcp-kv-row').forEach((row) => {
          const keyInput = row.querySelector('[data-kv-key]');
          const valueInput = row.querySelector('[data-kv-value]');
          const key = keyInput ? keyInput.value.trim() : '';
          if (key) kv[key] = valueInput ? valueInput.value : '';
        });
        let entry;
        if (transport === 'stdio') {
          const commandEl = document.getElementById('mcp-custom-g-command');
          const command = commandEl ? commandEl.value.trim() : '';
          if (!command) { dialogError.textContent = '請輸入指令'; dialogError.style.display = 'block'; return; }
          const argsEl = document.getElementById('mcp-custom-g-args');
          const argsRaw = argsEl ? argsEl.value.trim() : '';
          const args = argsRaw ? argsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
          entry = Object.assign({ command: command }, args.length ? { args: args } : {}, Object.keys(kv).length ? { env: kv } : {});
        } else {
          const urlEl = document.getElementById('mcp-custom-g-url');
          const url = urlEl ? urlEl.value.trim() : '';
          if (!url) { dialogError.textContent = '請輸入 URL'; dialogError.style.display = 'block'; return; }
          entry = Object.assign({ url: url }, Object.keys(kv).length ? { headers: kv } : {});
        }
        json = JSON.stringify({ mcpServers: { [name]: entry } });
      }
      btn.disabled = true;
      btn.textContent = '儲存中…';
      try {
        const data = await apiPost('/admin/api/mcp-servers/mutate', {
          action: 'import', scope: scope, json: json, ...scopeBody(),
        });
        const results = Array.isArray(data.results) ? data.results : [];
        const failed = results.filter((r) => r.error).length;
        closeMcpCustomDialog();
        mcpMessage(scope, failed ? '已儲存，但 ' + failed + ' 個 server 連線失敗，見上方選項維護。' : '已儲存並連線成功。', failed ? 'err' : 'ok');
        await loadMcpServers();
      } catch (err) {
        dialogError.textContent = err.message;
        dialogError.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.textContent = '新增並測試連線';
      }
    }

    const MCP_JSON_PLACEHOLDER = JSON.stringify({
      mcpServers: {
        browserless: {
          type: 'http',
          url: 'https://mcp.browserless.io/mcp',
          headers: { Authorization: 'Bearer YOUR_API_TOKEN' },
        },
      },
    }, null, 2);

    const loadMcpServers = () => loadScopePanels('mcp', 'mcp-servers', (data, convEl, globalEl) => {
      mcpPresets = Array.isArray(data.presets) ? data.presets : [];
      mcpServersByScope = { conversation: data.conversation || {}, global: data.global || {} };
      if (convEl) renderMcpScope(convEl, 'conversation', mcpServersByScope.conversation);
      if (globalEl) renderMcpScope(globalEl, 'global', mcpServersByScope.global);
    });

    async function mutateMcpServer(scope, action, name, extra) {
      mcpMessage(scope, action === 'test' ? '連線測試中…' : '儲存並測試連線中…', 'busy');
      try {
        const data = await apiPost('/admin/api/mcp-servers/mutate', {
          action: action,
          scope: scope,
          ...(name ? { name: name } : {}),
          ...(extra || {}),
          ...scopeBody(),
        });
        const results = Array.isArray(data.results) ? data.results : [];
        const failed = results.filter((r) => r.error).length;
        if (action === 'test') {
          mcpMessage(scope, failed ? '✗ ' + name + ': ' + results[0].error : '✓ ' + name + ': ' + results[0].tools + ' tool(s)', failed ? 'err' : 'ok');
          return;
        }
        if (action === 'remove' || action === 'toggle') {
          mcpMessage(scope, '完成。新設定在下一次回應生效。', 'ok');
        } else {
          mcpMessage(scope, failed ? '已儲存，但 ' + failed + ' 個 server 連線失敗，見下方錯誤。' : '已儲存並連線成功。', failed ? 'err' : 'ok');
        }
        await loadMcpServers();
      } catch (err) {
        mcpMessage(scope, err.message, 'err');
      }
    }

    function openMcpPreset(scope, presetId) {
      const preset = mcpPresets.find((item) => item.id === presetId);
      if (!preset) return;
      pendingMcpInstall = { scope: scope, preset: preset };
      const local = Boolean(preset.server.command);
      const installed = Boolean(mcpServersByScope[scope][preset.serverName]);
      const credentials = preset.credentials.map((credential, index) =>
        '<label class="mcp-credential"><span>' + escHtml(credential.label) + (credential.required ? ' *' : '') + '</span>' +
          '<input data-mcp-credential="' + index + '" type="' + (credential.secret ? 'password' : 'text') + '" autocomplete="off" />' +
          '<small>' + escHtml(credential.description) + '</small></label>'
      ).join('');
      document.getElementById('mcp-dialog-title').textContent = preset.name;
      const dialogError = document.getElementById('mcp-dialog-error');
      dialogError.style.display = 'none';
      dialogError.textContent = '';
      document.getElementById('mcp-dialog-content').innerHTML =
        '<p class="mcp-dialog-desc">' + escHtml(preset.description) + '</p>' +
        '<div class="mcp-install-preview"><span>' + (local ? 'Host command' : 'Remote endpoint') + '</span><code>' + escHtml(mcpTransport(preset.server)) + '</code></div>' +
        '<div class="mcp-security-note ' + (local ? 'local' : 'remote') + '">' +
          (local
            ? '<strong>Host code execution.</strong> This command runs outside the conversation sandbox with the mikan process user permissions.'
            : '<strong>External service.</strong> Tool calls and selected data will be sent to this remote origin.') +
        '</div>' +
        (installed ? '<div class="mcp-replace-note">Installing again replaces the existing <code>' + escHtml(preset.serverName) + '</code> entry in this scope.</div>' : '') +
        (credentials || '<p class="mcp-no-credentials">No credentials required.</p>') +
        '<p class="mcp-secret-note">These values are stored in host-private settings and are not shown to the model or sandbox.</p>' +
        '<a class="mcp-setup-link" href="' + escAttr(preset.setupUrl) + '" target="_blank" rel="noopener">Setup documentation ↗</a>';
      document.getElementById('mcp-install-dialog').showModal();
    }

    function closeMcpInstall() {
      pendingMcpInstall = null;
      document.getElementById('mcp-install-dialog').close();
    }

    async function installMcpPreset(btn) {
      if (!pendingMcpInstall) return;
      const { scope, preset } = pendingMcpInstall;
      const credentials = {};
      document.querySelectorAll('[data-mcp-credential]').forEach((input) => {
        const descriptor = preset.credentials[Number(input.dataset.mcpCredential)];
        if (descriptor) credentials[descriptor.key] = input.value;
      });
      btn.disabled = true;
      btn.textContent = 'Installing…';
      try {
        const data = await apiPost('/admin/api/mcp-servers/mutate', {
          action: 'install', scope: scope, presetId: preset.id, credentials: credentials, ...scopeBody(),
        });
        closeMcpInstall();
        const result = (Array.isArray(data.results) ? data.results : [])[0];
        if (result && result.error) mcpMessage(scope, '✗ ' + preset.name + ' saved but failed to connect: ' + result.error, 'err');
        else mcpMessage(scope, '✓ ' + preset.name + ' installed, ' + (result ? result.tools : 0) + ' tool(s).', 'ok');
        await loadMcpServers();
      } catch (err) {
        const dialogError = document.getElementById('mcp-dialog-error');
        dialogError.textContent = err.message;
        dialogError.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Install preset';
      }
    }

    document.addEventListener('click', (event) => {
      const modeBtn = event.target.closest('#mcp-custom-dialog-content [data-mcp-mode]');
      if (modeBtn) { switchMcpCustomMode(modeBtn.dataset.mcpMode); return; }
      const kvAddBtn = event.target.closest('[data-mcp-kv-add]');
      if (kvAddBtn) { addMcpGuidedRow(kvAddBtn.dataset.mcpKvAdd); return; }
      const kvRemoveBtn = event.target.closest('[data-mcp-kv-remove]');
      if (kvRemoveBtn) { kvRemoveBtn.closest('.mcp-kv-row').remove(); return; }
      const transportRadio = event.target.closest('input[name^="mcp-"][name$="-g-transport"]');
      if (transportRadio) {
        const match = /^mcp-(.+)-g-transport$/.exec(transportRadio.name);
        if (match) updateMcpGuidedTransport(match[1]);
        return;
      }
      const btn = event.target.closest('[data-mcp-action]');
      if (!btn) return;
      if (btn.dataset.mcpAction === 'open-custom') { openMcpCustomDialog(btn.dataset.mcpScope); return; }
      if (btn.dataset.mcpAction === 'preset') { openMcpPreset(btn.dataset.mcpScope, btn.dataset.mcpPreset); return; }
      void mutateMcpServer(btn.dataset.mcpScope, btn.dataset.mcpAction, btn.dataset.mcpName);
    });

    async function loadSkills() {
      const container = document.getElementById('skills-content');
      const previewEl = document.getElementById('skills-preview');
      container.innerHTML = '<div class="loading-msg">Loading…</div>';
      if (previewEl) previewEl.innerHTML = '<div class="placeholder-msg">Click a skill to preview SKILL.md</div>';
      try {
        const data = await apiGet('/admin/api/skills?' + scopeQuery());
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
        const data = await apiGet('/admin/api/skills/file?' + scopeQuery() + '&source=' + encodeURIComponent(source) + '&directory=' + encodeURIComponent(directory));
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

    const openLogin = (silent) => openPortalLink('vault', 'login', silent);
    const openSessionView = (silent) => openPortalLink('session', 'session', silent);

    // Generates a fresh one-time/short-lived link for the other portal and
    // opens it in a new tab — the login and session-view tokens are separate
    // capabilities from the admin token (see docs/portal-auth-model.md), so
    // this always mints a new link rather than reusing anything cached here.
    async function openPortalLink(resultId, kind, silent) {
      const result = document.getElementById(resultId + '-link-result');
      if (silent) { result.style.display = 'none'; return; }
      result.style.display = 'block'; result.className = 'link-result loading'; result.textContent = 'Generating link…';
      try {
        const data = await apiPost('/admin/api/conversations/' + kind + '-link', scopeBody());
        result.className = 'link-result ok';
        result.innerHTML =
          (kind === 'login' ? '<span class="link-vault">vault: <code>' + escHtml(data.vaultId) + '</code></span>' : '') +
          '<a href="' + escAttr(data.url) + '" target="_blank" rel="noopener">' + escHtml(data.url) + '</a>' +
          '<button class="copy-link-btn" data-admin-action="copy-link" data-copy-text="' + escAttr(data.url) + '">Copy</button>';
        window.open(data.url, '_blank', 'noopener');
      } catch (err) {
        result.className = 'link-result err'; result.textContent = err.message;
      }
    }

    // ── Events ───────────────────────────────────────────────────────────────────

    const loadConversationEvents = () => loadEventList(true);
    const loadEvents = () => loadEventList(false);

    async function loadEventList(conversation) {
      const container = document.getElementById(conversation ? 'events-content' : 'global-events-content');
      if (!container) return;
      container.innerHTML = '<div class="loading-msg">Loading…</div>';
      try {
        const data = await apiGet(conversation ? '/admin/api/conversations/events?' + scopeQuery() : '/admin/api/events');
        if (data.events.length === 0) {
          container.innerHTML = '<div class="empty-state">' + (conversation ? '沒有關聯此對話的 event' : 'No events scheduled') + '</div>';
          return;
        }
        container.innerHTML = '<div class="events-list">' +
          data.events.map((e) => renderEventRow(e, conversation)).join('') + '</div>';
      } catch (err) {
        container.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    function renderEventRow(e, allowDelete) {
      const meta = [e.type, e.platform, e.conversationId, e.schedule || e.at]
        .filter(Boolean).map(escHtml).join(' · ');
      const preview = e.text ? '<div class="event-text">' + escHtml(e.text.length > 240 ? e.text.slice(0, 237) + '…' : e.text) + '</div>' : '';
      const deleteBtn = allowDelete
        ? '<button class="event-delete-btn" data-admin-action="delete-event" data-event-name="' + escAttr(e.name) + '">Delete</button>'
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
          ...scopeBody(), name,
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
      loadTokenUsage();
      loadGlobalSettings();
      loadGlobalSkills();
      loadEvents();
      loadMcpServers();
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
          return '<button class="conv-row-btn" data-admin-action="select-conversation" data-conversation-id="' + escAttr(c.conversationId) + '">' +
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

    let timelineConvLoaded = false;
    let timelineData = null;
    let timelineFilter = null;
    async function ensureTimelineConvOptions() {
      if (timelineConvLoaded) return;
      const sel = document.getElementById('timeline-conv');
      const prev = sel.value;
      const data = await apiGet('/admin/api/conversations');
      if (!data.conversations.length) {
        sel.innerHTML = '<option value="">No conversations</option>';
        timelineConvLoaded = true;
        return;
      }
      const want = prev || defaultConversationKey;
      sel.innerHTML = data.conversations.map((c) => {
        const key = c.platform + ':' + c.conversationId;
        return '<option value="' + escAttr(key) + '"' +
          (key === want ? ' selected' : '') + '>' +
          escHtml(c.label || c.conversationId) + '</option>';
      }).join('');
      timelineConvLoaded = true;
    }

    // Shared refresh for the merged Token Usage section: reloads the session
    // ranking and re-fetches the conversation list (so new sessions appear),
    // preserving the currently selected conversation.
    async function loadTokenUsage() {
      loadSessionUsage();
      timelineConvLoaded = false;
      await loadUsageTimeline();
    }

    async function loadUsageTimeline() {
      const container = document.getElementById('usage-timeline-content');
      try {
        await ensureTimelineConvOptions();
        const conv = document.getElementById('timeline-conv').value;
        if (!conv) {
          container.innerHTML = '<div class="empty-state">No conversations found</div>';
          return;
        }
        container.innerHTML = '<div class="loading-msg">Loading…</div>';
        const convScope = scopeOf(conv);
        const data = await apiGet('/admin/api/conversation-usage?conversationId=' +
          encodeURIComponent(convScope.conversationId) +
          '&platform=' + encodeURIComponent(convScope.platform));
        timelineData = data;
        container.innerHTML = renderUsageTimeline(data);
      } catch (err) {
        container.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    function tlCard(label, value) {
      return '<div class="tl-card"><div class="tl-card-label">' + label +
        '</div><div class="tl-card-value">' + value + '</div></div>';
    }

    const TL_SERIES = [
      { key: 'cacheRead', seg: 'tl-cache-read', sw: 'sw-cache-read', label: 'Cache read' },
      { key: 'cacheWrite', seg: 'tl-cache-write', sw: 'sw-cache-write', label: 'Cache write' },
      { key: 'input', seg: 'tl-input', sw: 'sw-input', label: 'Input' },
      { key: 'output', seg: 'tl-output', sw: 'sw-output', label: 'Output' },
    ];

    // Click a legend item to show only that series; click it again for all.
    function toggleTimelineFilter(key) {
      timelineFilter = timelineFilter === key ? null : key;
      if (timelineData) {
        document.getElementById('usage-timeline-content').innerHTML = renderUsageTimeline(timelineData);
      }
    }

    function renderUsageTimeline(data) {
      const buckets = data.buckets || [];
      const totals = data.totals || { total: 0, cost: 0, cacheRead: 0 };
      const cacheHit = totals.total > 0 ? Math.round((totals.cacheRead / totals.total) * 100) : 0;
      const cards = '<div class="tl-cards">' +
        tlCard('Total cost', totals.cost > 0 ? '$' + Number(totals.cost).toFixed(4) : '—') +
        tlCard('Total tokens', fmtNum(totals.total)) +
        tlCard('Cache hit', cacheHit + '%') +
      '</div>';

      if (totals.total === 0) {
        const emptyNote = data.hasOlder
          ? '<div class="tl-note">No usage in the last 14 days · earlier activity exists</div>'
          : '<div class="empty-state">No token usage in the last 14 days</div>';
        return cards + emptyNote;
      }

      const active = TL_SERIES.find((s) => s.key === timelineFilter) || null;
      const valueOf = (b) => active ? (b[active.key] || 0) : b.total;
      const max = Math.max(1, ...buckets.map(valueOf));
      const px = (v) => Math.round((v / max) * 180);

      const legend = '<div class="tl-legend">' + TL_SERIES.map((s) => {
        const cls = 'tl-legend-item' +
          (active && active.key === s.key ? ' active' : (active ? ' dim' : ''));
        return '<span class="' + cls + '" data-admin-action="toggle-timeline-filter" data-filter-key="' + escAttr(s.key) + '">' +
          '<i class="sw ' + s.sw + '"></i>' + s.label + '</span>';
      }).join('') + '</div>';

      const bars = buckets.map((b) => {
        const val = valueOf(b);
        const tip = active
          ? b.date + ' · ' + active.label + ': ' + fmtNum(b[active.key] || 0) + ' tokens'
          : b.date + ' · ' + fmtNum(b.total) + ' tokens' +
            (b.cost > 0 ? ' · $' + Number(b.cost).toFixed(4) : '');
        let inner;
        if (val <= 0) {
          inner = '<span class="tl-empty"></span>';
        } else if (active) {
          inner = '<span class="tl-seg ' + active.seg + '" style="height:' + px(val) + 'px"></span>';
        } else {
          inner = '<span class="tl-seg tl-output" style="height:' + px(b.output) + 'px"></span>' +
            '<span class="tl-seg tl-input" style="height:' + px(b.input) + 'px"></span>' +
            '<span class="tl-seg tl-cache-write" style="height:' + px(b.cacheWrite) + 'px"></span>' +
            '<span class="tl-seg tl-cache-read" style="height:' + px(b.cacheRead) + 'px"></span>';
        }
        return '<div class="tl-bar">' +
          '<span class="tl-tip">' + escHtml(tip) + '</span>' +
          '<div class="tl-fill">' + inner + '</div>' +
        '</div>';
      }).join('');

      const axis = buckets.length
        ? '<div class="tl-axis"><span>' + escHtml(buckets[0].date.slice(5)) +
          '</span><span>' + escHtml(buckets[buckets.length - 1].date.slice(5)) + '</span></div>'
        : '';
      const note = data.hasOlder
        ? '<div class="tl-note">Showing last 14 days · earlier activity not shown</div>'
        : '<div class="tl-note">Showing last 14 days</div>';
      const peak = '<div class="tl-peak" style="bottom:180px"><span class="tl-peak-label">' +
        fmtNum(max) + ' tokens</span></div>';
      return cards + legend + '<div class="tl-chart">' + peak + bars + '</div>' + axis + note;
    }

    function renderGlobalSettings(data) {
      const thinkingOpts = renderThinkingOptions(data.thinkingLevel);
      const replyModeOpts = renderReplyOptions(data.slack);
      return [
        '<div class="config-grid">',
          renderConfigCard('Default model', [
            '<div class="config-row config-row-stack"><label>Model</label><select id="g-model-ref">' + renderModelOptions(data.provider, data.model) + '</select></div>',
            '<div class="config-row"><label>Thinking</label><select id="g-thinking">' + thinkingOpts + '</select></div>',
          ].join(''), 'saveGlobalModel', 'Save model', 'g-model-result'),
          renderConfigCard('Sandbox limits', [
            '<div class="config-row"><label>CPUs</label><input id="g-cpus" placeholder="0.5" value="' + escAttr(data.sandboxCpus || '') + '"></div>',
            '<div class="config-row"><label>Memory</label><input id="g-mem" placeholder="1g" value="' + escAttr(data.sandboxMemory || '') + '"></div>',
            '<div class="config-row"><label>Boost CPUs</label><input id="g-bcpus" placeholder="2" value="' + escAttr(data.sandboxBoostCpus || '') + '"></div>',
            '<div class="config-row"><label>Boost Mem</label><input id="g-bmem" placeholder="4g" value="' + escAttr(data.sandboxBoostMemory || '') + '"></div>',
          ].join(''), 'saveGlobalSandbox', 'Save sandbox', 'g-sandbox-result'),
          renderConfigCard('Slack', [
            '<div class="config-row"><label>Reply mode</label><select id="g-slack-reply-mode">' + replyModeOpts + '</select></div>',
          ].join(''), 'saveGlobalSlack', 'Save Slack', 'g-slack-result'),
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
      const result = document.getElementById('g-sandbox-result');
      await saveSetting(btn, result, 'settings/sandbox', { cpus, memory, boostCpus, boostMemory }, 'Save sandbox');
    }

    async function saveGlobalSlack(btn) {
      const replyMode = document.getElementById('g-slack-reply-mode').value;
      const result = document.getElementById('g-slack-result');
      await saveSetting(btn, result, 'settings/slack', { replyMode }, 'Save Slack');
    }

    async function loadGlobalSkills() {
      const container = document.getElementById('global-skills-content');
      container.innerHTML = '<div class="loading-msg">Loading…</div>';
      try {
        // Reuse skills endpoint scoped to a conversation that doesn't have any of its own; the global half is what we want.
        const data = await apiGet('/admin/api/skills?' + scopeQuery());
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

    // Sections load on demand (see initSections); loadSettingsPanel already
    // calls loadModels() itself the first time it's needed.
    initConvSwitcher();
    initSections();
  `;

function renderAdminPage(token: AdminToken): string {
  const userLabel = token.platformUserName ?? token.platformUserId;
  const script = `
    const adminToken = ${JSON.stringify(token.token)};
    // Conversation ids never contain ":" (session-key grammar), so
    // "platform:id" is a safe composite scope key for the UI.
    const defaultConversationKey = ${JSON.stringify(`${token.platform}:${token.conversationId}`)};
${adminViewScript}`;

  return renderPortalShell({
    activeView: "admin",
    pageTitle: "Admin",
    identity: { primary: token.platform, secondary: userLabel },
    conversationSwitcher: { currentId: token.conversationId },
    body: adminViewBody,
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

  /* Each section is a <details>; the card's own padding sits on the
     <summary>/<div class="sect-body"> instead of the <details> element so a
     collapsed section is just its header row. */
  details.sect { padding: 0; overflow: hidden; }
  details.sect > summary.sect-head {
    padding: 24px 28px; margin-bottom: 0; cursor: pointer; list-style: none;
  }
  details.sect > summary.sect-head::-webkit-details-marker { display: none; }
  details.sect > .sect-body { padding: 0 28px 24px; }

  .sect-head {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; flex-wrap: wrap;
  }
  .sect-head .card-title { margin-bottom: 0; }
  .sect-title { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
  .sect-caret {
    flex-shrink: 0; margin-top: 3px; color: var(--subtle);
    transition: transform 140ms; display: inline-block;
  }
  details.sect[open] > summary.sect-head .sect-caret { transform: rotate(90deg); }
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

  /* ── MCP marketplace ───────────────────────────────────────────────── */

  .form-input {
    flex: 1 1 240px; min-width: 0; padding: 8px 10px;
    border: 1px solid var(--border); border-radius: 8px; background: var(--card);
    font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.8rem; color: var(--text);
  }
  .status-msg {
    padding: 8px 12px; border-radius: 8px; margin-bottom: 12px;
    font-size: 0.82rem; line-height: 1.5; word-break: break-word;
  }
  .status-msg-ok { background: rgba(22,163,74,0.1); color: #15803d; }
  .status-msg-err { background: rgba(220,38,38,0.1); color: #b91c1c; }
  .status-msg-busy { background: rgba(0,0,0,0.05); color: var(--muted); }
  .mcp-btn {
    padding: 4px 10px; border: 1px solid var(--border); border-radius: 7px;
    background: var(--card); color: var(--text); font-size: 0.76rem; cursor: pointer;
  }
  .mcp-btn:hover { background: rgba(0,0,0,0.05); }
  .mcp-btn-danger { color: #b91c1c; }
  .mcp-badge {
    padding: 1px 8px; border-radius: 999px; font-size: 0.7rem;
    font-weight: 600; letter-spacing: 0.03em;
  }
  .mcp-badge-ok { background: rgba(22,163,74,0.1); color: #15803d; }
  .mcp-badge-warn { background: rgba(217,119,6,0.12); color: var(--accent); }

  .mcp-market-head {
    display: flex; align-items: end; justify-content: space-between; gap: 16px;
    margin-bottom: 12px;
  }
  .mcp-market-head h3 { margin: 0; font-size: 1rem; }
  .mcp-market-head p { margin: 3px 0 0; color: var(--muted); font-size: 0.8rem; }
  .mcp-market-head > span {
    color: var(--subtle); font: 500 0.72rem/1.2 'JetBrains Mono', ui-monospace, monospace;
  }
  .mcp-preset-grid {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px;
  }
  .mcp-preset {
    min-width: 0; padding: 14px; border: 1px solid var(--border); border-radius: 12px;
    background:
      linear-gradient(145deg, rgba(255,255,255,0.85), rgba(247,245,238,0.72)),
      var(--card);
    display: flex; flex-direction: column; min-height: 190px;
  }
  .mcp-preset-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .mcp-preset-category {
    color: var(--accent); font-size: 0.66rem; font-weight: 700;
    letter-spacing: 0.09em; text-transform: uppercase;
  }
  .mcp-preset h3 { margin: 14px 0 5px; font-size: 1.06rem; letter-spacing: -0.02em; }
  .mcp-preset p { margin: 0; color: var(--muted); font-size: 0.8rem; line-height: 1.5; }
  .mcp-preset-meta {
    margin-top: 12px; color: var(--subtle); font-size: 0.72rem;
  }
  .mcp-preset-meta code { color: var(--text); background: transparent; }
  .mcp-preset-actions {
    margin-top: auto; padding-top: 16px; display: flex; align-items: center;
    justify-content: space-between; gap: 10px;
  }
  .mcp-preset-actions a, .mcp-setup-link {
    color: var(--muted); font-size: 0.76rem; text-decoration: none;
  }
  .mcp-preset-actions a:hover, .mcp-setup-link:hover { color: var(--text); text-decoration: underline; }
  .mcp-preset-actions .primary-action-btn { padding: 6px 12px; }
  .mcp-installed {
    margin-top: 14px; border-top: 1px solid var(--border); padding-top: 12px;
  }
  .mcp-installed > summary {
    cursor: pointer; color: var(--muted); font-size: 0.8rem; font-weight: 600;
    margin-bottom: 10px;
  }
  .mcp-installed-card { min-height: 150px; }
  .mcp-installed-transport {
    font-family: 'JetBrains Mono', ui-monospace, monospace; word-break: break-all;
  }
  .mcp-add-card {
    min-width: 0; min-height: 190px; border: 1.5px dashed var(--border); border-radius: 12px;
    background: transparent; color: var(--muted); font-size: 0.86rem; font-weight: 600;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; cursor: pointer;
  }
  .mcp-add-card:hover { background: rgba(0,0,0,0.03); color: var(--text); border-color: var(--text); }
  .mcp-add-card-plus { font-size: 1.8rem; line-height: 1; font-weight: 400; }
  .mcp-manual-hint { color: var(--muted); font-size: 0.8rem; margin: 0 0 10px; line-height: 1.5; }
  .mcp-add-mode { display: flex; gap: 8px; margin: 0 0 12px; }
  .mcp-mode-btn {
    padding: 6px 12px; border: 1px solid var(--border); border-radius: 999px;
    background: var(--card); font-size: 0.8rem; cursor: pointer; color: var(--muted);
  }
  .mcp-mode-btn.active { background: var(--text); color: #fafafa; border-color: var(--text); }
  .mcp-guided-grid { display: grid; gap: 12px; }
  .mcp-field { display: grid; gap: 5px; }
  .mcp-field span { font-size: 0.78rem; font-weight: 650; color: var(--muted); }
  .mcp-transport-toggle { display: flex; gap: 16px; font-size: 0.85rem; align-items: center; }
  .mcp-transport-toggle label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .mcp-transport-fields { display: grid; gap: 12px; }
  .mcp-kv-block { display: grid; gap: 8px; }
  .mcp-kv-head { display: flex; align-items: center; justify-content: space-between; }
  .mcp-kv-head span { font-size: 0.78rem; font-weight: 650; color: var(--muted); }
  .mcp-kv-rows { display: grid; gap: 6px; }
  .mcp-kv-row { display: flex; gap: 8px; }
  .mcp-kv-row .form-input { flex: 1 1 auto; }
  .mcp-json {
    width: 100%; box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem; line-height: 1.45; resize: vertical;
  }
  .mcp-verify { margin-top: 10px; display: grid; gap: 6px; }
  .mcp-verify .inline-result { word-break: break-word; }

  .mcp-dialog {
    width: min(620px, calc(100vw - 28px)); max-height: calc(100vh - 40px);
    border: 1px solid var(--border); border-radius: 18px; padding: 22px;
    color: var(--text); background: #fbfaf6; box-shadow: 0 28px 90px rgba(18,18,16,0.24);
    /* The shell's global "* { margin: 0 }" reset overrides the UA stylesheet's
       dialog[open] { margin: auto } centering rule, so pin it back explicitly. */
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); margin: 0;
  }
  .mcp-dialog::backdrop { background: rgba(20,20,18,0.5); backdrop-filter: blur(3px); }
  .mcp-dialog-head {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 18px;
    padding-bottom: 14px; border-bottom: 1px solid var(--border);
  }
  .mcp-dialog-head .card-title { margin: 4px 0 0; }
  .mcp-dialog-close {
    border: 0; background: transparent; color: var(--muted); cursor: pointer;
    font-size: 1.6rem; line-height: 1; padding: 2px 5px;
  }
  .mcp-dialog-desc { color: var(--muted); line-height: 1.55; font-size: 0.88rem; }
  .mcp-install-preview {
    display: grid; gap: 6px; padding: 12px; border-radius: 10px;
    background: #1d211f; color: #f5f2e9;
  }
  .mcp-install-preview span {
    color: #aeb8b1; font-size: 0.66rem; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase;
  }
  .mcp-install-preview code {
    color: #f5f2e9; background: transparent; word-break: break-all; font-size: 0.78rem;
  }
  .mcp-security-note, .mcp-replace-note {
    margin-top: 12px; padding: 10px 12px; border-radius: 9px;
    font-size: 0.78rem; line-height: 1.5;
  }
  .mcp-security-note.local {
    background: rgba(220,38,38,0.08); border: 1px solid rgba(185,28,28,0.18); color: #991b1b;
  }
  .mcp-security-note.remote {
    background: rgba(59,130,246,0.08); border: 1px solid rgba(29,78,216,0.16); color: #1e40af;
  }
  .mcp-replace-note { background: rgba(217,119,6,0.1); color: #92400e; }
  .mcp-credential { display: grid; gap: 5px; margin-top: 14px; }
  .mcp-credential span { font-size: 0.78rem; font-weight: 650; }
  .mcp-credential input {
    width: 100%; padding: 9px 10px; border: 1px solid var(--border); border-radius: 8px;
    background: #fff; color: var(--text); font: 0.8rem/1.3 'JetBrains Mono', ui-monospace, monospace;
  }
  .mcp-credential small, .mcp-secret-note, .mcp-no-credentials {
    color: var(--subtle); font-size: 0.72rem; line-height: 1.45;
  }
  .mcp-secret-note { margin: 14px 0 8px; }
  .mcp-no-credentials { margin: 14px 0 0; }
  #mcp-dialog-error, #mcp-custom-dialog-error { margin-top: 14px; }
  .mcp-dialog-actions {
    display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px;
    padding-top: 14px; border-top: 1px solid var(--border);
  }

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

  .timeline-controls {
    display: flex; flex-wrap: wrap; gap: 18px; align-items: center; margin-bottom: 16px;
  }
  .timeline-controls label {
    display: flex; align-items: center; gap: 8px;
    font-size: 0.76rem; color: var(--muted);
  }
  .timeline-controls select {
    padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px;
    background: #fff; color: var(--text); font-size: 0.8rem; max-width: 240px;
  }
  .tl-note { margin-top: 8px; font-size: 0.72rem; color: var(--subtle); }
  .tl-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
  .tl-card { background: rgba(0,0,0,0.025); border-radius: 10px; padding: 10px 12px; }
  .tl-card-label { font-size: 0.73rem; color: var(--muted); margin-bottom: 4px; }
  .tl-card-value { font-size: 1.35rem; font-weight: 600; color: var(--text); }
  .tl-legend { display: flex; gap: 16px; font-size: 0.73rem; color: var(--muted); margin-bottom: 10px; }
  .tl-legend span { display: inline-flex; align-items: center; gap: 6px; }
  .tl-legend-item { cursor: pointer; transition: opacity 100ms; }
  .tl-legend-item:hover { text-decoration: underline; }
  .tl-legend-item.active { color: var(--text); font-weight: 600; text-decoration: underline; }
  .tl-legend-item.dim { opacity: 0.4; }
  .sw { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .sw-cache-read { background: rgba(0,0,0,0.18); }
  .sw-cache-write { background: #3b6fb0; }
  .sw-input { background: var(--accent); }
  .sw-output { background: var(--ok-text); }
  .tl-chart {
    position: relative;
    display: flex; align-items: flex-end; gap: 6px;
    height: 216px; border-bottom: 1px solid var(--border);
  }
  .tl-peak {
    position: absolute; left: 0; right: 0; height: 0;
    border-top: 1px dashed var(--accent); pointer-events: none;
  }
  .tl-peak-label {
    position: absolute; left: 0; top: -15px;
    font-size: 0.7rem; color: var(--accent); white-space: nowrap;
  }
  .tl-bar {
    position: relative; flex: 1; min-width: 0; height: 180px;
    display: flex; flex-direction: column; justify-content: flex-end;
    border-radius: 6px 6px 0 0; transition: background 80ms ease;
  }
  .tl-bar:hover { background: rgba(0,0,0,0.06); }
  .tl-bar:hover .tl-seg { opacity: 0.55; }
  .tl-fill {
    display: flex; flex-direction: column; justify-content: flex-end;
    border-radius: 3px 3px 0 0; overflow: hidden;
  }
  .tl-tip {
    position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%);
    margin-bottom: 6px; padding: 5px 9px; border-radius: 6px;
    background: var(--text); color: #fafafa; font-size: 0.7rem; line-height: 1.35;
    white-space: nowrap; opacity: 0; pointer-events: none; z-index: 5;
  }
  .tl-bar:hover .tl-tip { opacity: 1; }
  .tl-seg { display: block; width: 100%; }
  .tl-seg.tl-output { background: var(--ok-text); }
  .tl-seg.tl-input { background: var(--accent); }
  .tl-seg.tl-cache-write { background: #3b6fb0; }
  .tl-seg.tl-cache-read { background: rgba(0,0,0,0.18); }
  .tl-empty { display: block; width: 100%; height: 3px; background: var(--border); }
  .tl-axis { display: flex; justify-content: space-between; margin-top: 6px; font-size: 0.7rem; color: var(--subtle); }

  .status-pill {
    display: inline-flex; padding: 2px 9px; border-radius: 999px;
    font-size: 0.7rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  }
  .status-pill.running { background: var(--ok-bg); color: var(--ok-text); border: 1px solid var(--ok-border); }

  @media (max-width: 640px) {
    .tab-btn { padding: 9px 12px; font-size: 0.82rem; min-width: 60px; }
    .config-grid { grid-template-columns: 1fr; }
    .config-row { grid-template-columns: 1fr; gap: 4px; }
    .workspace-split { grid-template-columns: 1fr; }
    .workspace-tree, .workspace-preview { max-height: 260px; }
    .mcp-preset-grid { grid-template-columns: 1fr; }
    .mcp-dialog { padding: 18px; }
  }
`;
