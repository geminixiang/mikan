import { validateEventFilename } from "../../../events/index.js";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join, resolve as pathResolve, sep as pathSep } from "node:path";
import { atomicWritePrivateFile } from "../../../file-guards.js";
import { MikanModels, parseFrontmatter, validateSkill } from "../../../harness/index.js";
import { SessionStore } from "../../../sessions/session-store.js";
import type { EventStore } from "../../../events/index.js";
import type { PlatformName } from "../../index.js";
import { InMemoryTokenStore } from "../token-store.js";
import type { AdminToken } from "./types.js";
import {
  adminViewFunctionsScript,
  adminViewStartupScript,
  adminViewStyles,
} from "./client-assets.js";
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
      platformUserName: args.platformUserName || undefined,
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
} from "../../../settings/index.js";
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
} from "../../../settings/apply.js";
import {
  escapeHtml,
  jsonResponse as jsonRes,
  readJsonBody,
  renderPortalShell,
} from "../portal-shell.js";
import { resolveExistingSessionFile } from "../session-view/portal.js";
import { PRODUCT_NAME } from "../../messages.js";
import { credentialAuthorizationKey } from "../../../sandbox/identity.js";
import { resolveWorkspaceProjection } from "../../../office/projection.js";
import { sharedVaultKey } from "../../../vault/index.js";
import { modelKey, resolveAdminModelAccessStatuses } from "./provider-models.js";

export type { AdminRuntimeBridge, AdminServices, EventSummary } from "./types.js";
import type { AdminServices, EventSummary } from "./types.js";
import type { OfficeAddress } from "../../index.js";
import {
  assertPlatformName,
  createOfficeAddress,
  listRegisteredOffices,
  sameOffice,
  type Office,
  type Workspace,
} from "../../../office/index.js";

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
  const bodyLimit = url.pathname === "/admin/api/skills/mutate" ? 256 * 1024 : 32 * 1024;
  const body = await readJsonBody(req, res, bodyLimit);
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
    case "/admin/api/skills/mutate":
      return serveSkillMutation(res, body, services, token);
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

interface AdminConversationScope {
  address: OfficeAddress;
  conversationId: string;
  error?: string;
}

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
      } catch {}
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
  } catch {}

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
  } catch {}
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
      thinkingLevel,
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
      thinkingLevel,
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

const WORKSPACE_TREE_MAX_DEPTH = 4;
const WORKSPACE_TREE_MAX_ENTRIES = 800;
const PREVIEW_FILE_MAX_BYTES = 256 * 1024;

const WORKSPACE_TOP_DIRS = new Set(["scratch"]);

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
      truncated: truncated ? true : undefined,
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

interface SkillEntry {
  name: string;
  description: string;
  source: "global" | "conversation";
  path: string;
  directory: string;
}

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
        command: config.command,
        args: config.args,
        url: config.url !== undefined ? redactMcpUrl(config.url) : undefined,
        disabled: config.disabled,
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

const SKILL_DIRECTORY_PATTERN = /^[a-z0-9-]+$/;

function resolveSkillsRoot(
  workspace: Workspace,
  scope: AdminConversationScope,
  source: unknown,
): { root: string; source: "global" | "conversation" } | { error: string } {
  if (source !== "global" && source !== "conversation") {
    return { error: "Invalid skill source" };
  }
  return {
    root: source === "global" ? workspace.skillsDir : workspace.office(scope.address).skillsDir,
    source,
  };
}

async function serveSkillMutation(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
  token: AdminToken,
): Promise<void> {
  const action = body.action;
  if (action !== "save" && action !== "delete") {
    jsonRes(res, 400, { error: "action must be 'save' or 'delete'" });
    return;
  }
  const scope = resolveTargetConversation(body, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return;
  }
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;
  const resolved = resolveSkillsRoot(workspace, scope, body.source);
  if ("error" in resolved) {
    jsonRes(res, 400, { error: resolved.error });
    return;
  }

  const directory = typeof body.directory === "string" ? body.directory.trim() : "";
  if (!directory || !SKILL_DIRECTORY_PATTERN.test(directory)) {
    jsonRes(res, 400, {
      error: "directory must be lowercase a-z, 0-9 and hyphens",
    });
    return;
  }
  const safe = safeJoinUnderRoot(resolved.root, directory);
  if (safe.error) {
    jsonRes(res, 400, { error: safe.error });
    return;
  }

  if (action === "delete") {
    if (!existsSync(join(safe.absolute, "SKILL.md"))) {
      jsonRes(res, 404, { error: "Skill not found" });
      return;
    }
    try {
      rmSync(safe.absolute, { recursive: true, force: true });
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    jsonRes(res, 200, { ok: true });
    return;
  }

  const name = typeof body.name === "string" ? body.name.trim() : directory;
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";
  if (!description) {
    jsonRes(res, 400, { error: "description is required" });
    return;
  }
  const errors = validateSkill(name, description);
  if (errors.length > 0) {
    jsonRes(res, 400, { error: errors.join("; ") });
    return;
  }

  try {
    if (existsSync(safe.absolute) && lstatSync(safe.absolute).isSymbolicLink()) {
      throw new Error("Refusing to write through a symlinked skill directory");
    }
    mkdirSync(safe.absolute, { recursive: true });
    const frontmatter = ["---", `name: ${name}`, `description: ${description}`, "---", ""].join(
      "\n",
    );
    atomicWritePrivateFile(join(safe.absolute, "SKILL.md"), frontmatter + content.trim() + "\n");
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  jsonRes(res, 200, { ok: true, name, directory, source: resolved.source });
}

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
  try {
    await store.delete(name);
    jsonRes(res, 200, { ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    jsonRes(res, /not found/.test(message) ? 404 : 500, { error: message });
  }
}

const esc = escapeHtml;

type RailIconKey =
  | "settings"
  | "workspace"
  | "skills"
  | "mcp"
  | "vault"
  | "events"
  | "session"
  | "overview"
  | "usage";

const ICONS: Record<RailIconKey, string> = {
  settings: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  workspace: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>`,
  skills: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5V5a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v14"/><path d="M6 17h13v4H6.5A2.5 2.5 0 0 1 4 18.5v0A2.5 2.5 0 0 1 6.5 16H20"/></svg>`,
  mcp: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><circle cx="7" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="7" cy="16.5" r="1" fill="currentColor" stroke="none"/></svg>`,
  vault: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  events: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`,
  session: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`,
  overview: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="11" width="8" height="10" rx="1.5"/><rect x="3" y="14" width="8" height="7" rx="1.5"/></svg>`,
  usage: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21V3"/><path d="M3 21h18"/><path d="M7 17V11M12 17V7M17 17v-4"/></svg>`,
};

function railLink(id: string, label: string, icon: RailIconKey, active = false): string {
  const svg = ICONS[icon];
  return `<button class="rail-link${active ? " active" : ""}" type="button" data-pane="${id}" aria-current="${active ? "page" : "false"}" aria-label="${esc(label)}" title="${esc(label)}">${svg}<span>${esc(label)}</span></button>`;
}

function settingsPane(
  id: string,
  title: string,
  description: string,
  actions: string,
  body: string,
): string {
  return `<section class="pane" id="pane-${id}" data-pane="${id}">
    <header class="pane-head">
      <div><h2 class="pane-title">${esc(title)}</h2><p class="pane-desc">${esc(description)}</p></div>
      <div class="pane-actions">${actions}</div>
    </header>
    <div class="pane-body">${body}</div>
  </section>`;
}

const adminViewBody = `<div class="settings-shell">
      <aside class="settings-rail" aria-label="Admin sections">
        <div class="rail-scope" role="tablist" aria-label="Scope">
          <button class="rail-scope-btn active" role="tab" aria-selected="true" aria-controls="panel-conversation" data-tab="conversation">This conversation</button>
          <button class="rail-scope-btn" role="tab" aria-selected="false" aria-controls="panel-global" data-tab="global">Workspace</button>
        </div>
        <nav class="rail-nav" id="rail-nav-conversation" data-scope="conversation">
          ${railLink("settings", "Settings", "settings", true)}
          ${railLink("workspace", "Workspace", "workspace")}
          ${railLink("skills", "Skills", "skills")}
          ${railLink("mcp", "MCP servers", "mcp")}
          ${railLink("vault", "Vault", "vault")}
          ${railLink("events", "Events", "events")}
          ${railLink("session", "Session view", "session")}
        </nav>
        <nav class="rail-nav" id="rail-nav-global" data-scope="global" hidden>
          ${railLink("g-overview", "All conversations", "overview", true)}
          ${railLink("g-usage", "Token usage", "usage")}
          ${railLink("g-settings", "Defaults", "settings")}
          ${railLink("g-mcp", "MCP servers", "mcp")}
          ${railLink("g-skills", "Skills", "skills")}
          ${railLink("g-events", "Events", "events")}
        </nav>
      </aside>

      <div class="settings-panels">
        <div class="tab-panel active" id="panel-conversation">
          ${settingsPane("settings", "Settings", "Model, thinking level, auto-reply, and workspace visibility for this conversation.", '<button class="refresh-btn" type="button" aria-label="Refresh" title="Refresh" onclick="loadSettings()">↻</button>', '<div id="settings-content"><div class="loading-msg">Loading…</div></div>')}

          ${settingsPane("workspace", "Workspace", "Read-only browser for this conversation's files on disk.", '<button class="refresh-btn" type="button" aria-label="Refresh" title="Refresh" onclick="loadWorkspace()">↻</button>', '<div class="workspace-split"><div id="workspace-tree" class="workspace-tree"><div class="loading-msg">Loading…</div></div><div id="workspace-preview" class="workspace-preview"><div class="placeholder-msg">Click a file to preview</div></div></div>')}

          ${settingsPane("skills", "Skills", "Instructions the agent can load for specific tasks in this conversation.", '<button class="primary-action-btn" onclick="openSkillDialog(\'conversation\')">+ New skill</button><button class="refresh-btn" type="button" aria-label="Refresh" title="Refresh" onclick="loadSkills()">↻</button>', '<div class="workspace-split"><div id="skills-content" class="workspace-tree"><div class="loading-msg">Loading…</div></div><div id="skills-preview" class="workspace-preview"><div class="placeholder-msg">Click a skill to preview SKILL.md</div></div></div>')}

          ${settingsPane("mcp", "MCP servers", "External tools this conversation can call during a run.", '<button class="refresh-btn" type="button" aria-label="Refresh" title="Refresh" onclick="loadMcpServers()">↻</button>', '<div id="mcp-conv-msg" class="status-msg" style="display:none"></div><div id="mcp-conv-content"><div class="loading-msg">Loading…</div></div>')}

          ${settingsPane("vault", "Vault", "Credentials scoped to this conversation.", '<button class="primary-action-btn" onclick="openLogin()">Open in new tab ↗</button>', '<div id="vault-link-result" class="link-result" style="display:none"></div><p class="card-desc">Opens the one-time credential form for this conversation\'s vault in a new tab.</p>')}

          ${settingsPane("events", "Events", "Scheduled and one-shot events tied to this conversation.", '<button class="refresh-btn" type="button" aria-label="Refresh" title="Refresh" onclick="loadConversationEvents()">↻</button>', '<div id="events-content"><div class="loading-msg">Loading…</div></div>')}

          ${settingsPane("session", "Session view", "The full message and tool-call timeline for this conversation.", '<button class="primary-action-btn" onclick="openSessionView()">Open in new tab ↗</button>', '<div id="session-link-result" class="link-result" style="display:none"></div><p class="card-desc">Opens the session timeline for this conversation in a new tab.</p>')}
        </div>

        <div class="tab-panel" id="panel-global">
          ${settingsPane("g-overview", "All conversations", "Every registered conversation across every platform.", '<button class="refresh-btn" type="button" aria-label="Refresh" title="Refresh" onclick="loadAllConversations()">↻</button>', '<div id="all-conv-content"><div class="loading-msg">Loading…</div></div>')}

          ${settingsPane("g-usage", "Token usage", "Spend and volume across every conversation.", '<button class="refresh-btn" type="button" aria-label="Refresh" title="Refresh" onclick="loadTokenUsage()">↻</button>', '<h3 class="card-subtitle">Top 20 sessions</h3><div id="session-usage-content"><div class="loading-msg">Loading…</div></div><h3 class="card-subtitle" style="margin-top:24px">Usage timeline</h3><div class="timeline-controls"><label>Conversation<select id="timeline-conv" onchange="loadUsageTimeline()"></select></label></div><div id="usage-timeline-content"><div class="loading-msg">Loading…</div></div>')}

          ${settingsPane("g-settings", "Workspace defaults", "The fallback model, sandbox limits, and Slack behavior every conversation inherits.", '<button class="refresh-btn" type="button" aria-label="Refresh" title="Refresh" onclick="loadGlobalSettings()">↻</button>', '<div id="global-settings-content"><div class="loading-msg">Loading…</div></div>')}

          ${settingsPane("g-mcp", "MCP servers", "External tools available to every conversation in this workspace.", '<button class="refresh-btn" type="button" aria-label="Refresh" title="Refresh" onclick="loadMcpServers()">↻</button>', '<div id="mcp-global-msg" class="status-msg" style="display:none"></div><div id="mcp-global-content"><div class="loading-msg">Loading…</div></div>')}

          ${settingsPane("g-skills", "Skills", "Shared instructions available to every conversation in this workspace.", '<button class="primary-action-btn" onclick="openSkillDialog(\'global\')">+ New global skill</button><button class="refresh-btn" type="button" aria-label="Refresh" title="Refresh" onclick="loadGlobalSkills()">↻</button>', '<div class="workspace-split"><div id="global-skills-content" class="workspace-tree"><div class="loading-msg">Loading…</div></div><div id="global-skills-preview" class="workspace-preview"><div class="placeholder-msg">Click a skill to preview SKILL.md</div></div></div>')}

          ${settingsPane("g-events", "Global events", "Every scheduled event across the whole workspace.", '<button class="refresh-btn" type="button" aria-label="Refresh" title="Refresh" onclick="loadEvents()">↻</button>', '<div id="global-events-content"><div class="loading-msg">Loading…</div></div>')}
        </div>
      </div>
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
    </dialog>

    <dialog id="skill-dialog" class="mcp-dialog" aria-labelledby="skill-dialog-title">
      <div class="mcp-dialog-head">
        <div>
          <p class="eyebrow" id="skill-dialog-eyebrow">Skill</p>
          <h2 id="skill-dialog-title" class="card-title">New skill</h2>
        </div>
        <button class="mcp-dialog-close" type="button" aria-label="Close" onclick="closeSkillDialog()">×</button>
      </div>
      <div class="mcp-field">
        <span>Directory</span>
        <input id="skill-dialog-directory" class="form-input mcp-json" placeholder="my-skill" autocomplete="off" />
        <small class="mcp-secret-note">Lowercase letters, digits, hyphens. Cannot be changed after creation.</small>
      </div>
      <div class="mcp-field">
        <span>Name</span>
        <input id="skill-dialog-name" class="form-input mcp-json" placeholder="my-skill" autocomplete="off" />
      </div>
      <div class="mcp-field">
        <span>Description</span>
        <input id="skill-dialog-description" class="form-input mcp-json" placeholder="Use when …" autocomplete="off" />
      </div>
      <div class="mcp-field">
        <span>Instructions (SKILL.md body)</span>
        <textarea id="skill-dialog-content" class="form-input mcp-json" spellcheck="false" rows="12" placeholder="# My skill&#10;&#10;Instructions here."></textarea>
      </div>
      <div id="skill-dialog-error" class="inline-result err" style="display:none"></div>
      <div class="mcp-dialog-actions">
        <button class="mcp-btn" type="button" onclick="closeSkillDialog()">Cancel</button>
        <button id="skill-dialog-submit" class="primary-action-btn" type="button" onclick="submitSkillDialog(this)">Save</button>
      </div>
    </dialog>`;

function renderAdminPage(token: AdminToken): string {
  const userLabel = token.platformUserName ?? token.platformUserId;
  const script = `
    const adminToken = ${JSON.stringify(token.token)};
    const defaultConversationKey = ${JSON.stringify(`${token.platform}:${token.conversationId}`)};
${adminViewFunctionsScript}
${adminViewStartupScript}`;

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
