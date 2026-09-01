import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join, resolve as pathResolve, sep as pathSep } from "node:path";
import {
  MikanModels,
  parseFrontmatter,
  SessionStore,
  validateEventFilename,
} from "../../harness/index.js";
import type { EventStore } from "../../tools/types.js";
import type { PlatformName } from "../../adapter.js";
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
  loadConversationAutoReplyConfig,
  loadConversationWorkspaceOverride,
  loadGlobalSettings,
  loadScopeMcpServers,
  resolveConversationSettings,
  saveConversationAutoReplyConfig,
  type AgentConfig,
  type SandboxSettings,
  type WorkspacePolicyChoice,
} from "../../config.js";
import type { McpServerConfig } from "../../mcp/types.js";
import {
  applyConversationSettings,
  applyConversationWorkspacePolicy,
  applyGlobalSettings,
  applyGlobalWorkspacePolicy,
} from "../../settings-mutation.js";
import {
  addPackage,
  inspectConversationPackages,
  refreshPackage,
  removePackage,
} from "../../packages/index.js";
import {
  escapeHtml,
  jsonResponse as jsonRes,
  readJsonBody,
  renderPortalShell,
} from "../portal-shell.js";
import { resolveExistingSessionFile } from "../session-view/portal.js";
import { PRODUCT_NAME } from "../../platform-messages.js";
import { credentialAuthorizationKey } from "../../sandbox/identity.js";
import { resolveWorkspaceProjection } from "../../workspace-projection/index.js";
import { sharedVaultKey } from "../../vault/index.js";
import { modelKey, resolveAdminModelAccessStatuses } from "./provider-models.js";

export type { AdminRuntimeBridge, AdminServices, EventSummary } from "./types.js";
import type { AdminServices, EventSummary } from "./types.js";
import type { OfficeAddress } from "../../adapter.js";
import {
  assertPlatformName,
  createOfficeAddress,
  listRegisteredOffices,
  sameOffice,
  type Workspace,
} from "../../office/index.js";

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
    case "/admin/api/packages":
      return servePackagesList(res, url, services, token);
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
    case "/admin/api/conversations/sandbox":
      return serveConversationSandboxUpdate(res, body, services, token);
    case "/admin/api/conversations/auto-reply":
      return serveConversationAutoReplyUpdate(res, body, services, token);
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
    case "/admin/api/packages/mutate":
      return servePackageMutation(res, body, services, token);
    case "/admin/api/settings/model":
      return serveGlobalModelUpdate(res, body, services);
    case "/admin/api/settings/workspace":
      return serveGlobalWorkspaceUpdate(res, body, services);
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
  const globalWorkspaceSettings = globalConfig.sandbox?.workspace;
  const autoReply = loadConversationAutoReplyConfig(office.dir);

  jsonRes(res, 200, {
    conversationId,
    provider: conversationConfig.provider,
    model: conversationConfig.model,
    thinkingLevel: conversationConfig.thinkingLevel,
    globalProvider: globalConfig.provider,
    globalModel: globalConfig.model,
    globalThinkingLevel: globalConfig.thinkingLevel,
    workspaceDoorPolicy: conversationWorkspace.doorPolicy,
    workspaceLayout: conversationWorkspace.layout,
    workspaceVisibility: conversationWorkspace.visibility,
    workspaceOverride: doorPolicyChoiceKey(loadConversationWorkspaceOverride(office)),
    globalWorkspaceDoorPolicy: globalWorkspaceSettings?.doorPolicy ?? "isolated",
    globalWorkspaceLayout: globalWorkspaceSettings?.layout ?? "conversation",
    globalWorkspaceVisibility: globalWorkspaceSettings?.visibility ?? "public",
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
      sandboxCpus: config.sandbox?.cpus ?? null,
      sandboxMemory: config.sandbox?.memory ?? null,
      sandboxBoostCpus: config.sandbox?.boost?.cpus ?? null,
      sandboxBoostMemory: config.sandbox?.boost?.memory ?? null,
      workspaceDoorPolicy: config.sandbox?.workspace?.doorPolicy ?? null,
      workspaceLayout: config.sandbox?.workspace?.layout ?? null,
      workspaceVisibility: config.sandbox?.workspace?.visibility ?? null,
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
  const scope = resolveTargetConversation(body, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return;
  }
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;

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

/**
 * Wire values for a door-policy selection; "default" clears the office's
 * override. `trusted-shared-support` keeps the historical read-write shared
 * MEMORY.md; `trusted-shared-support-private` is the same layout with the
 * shared MEMORY.md mounted read-only (modeled on Claude Tag's private-
 * channel memory: read the shared pool, never write into it).
 */
function parseDoorPolicyChoice(
  value: unknown,
): { choice: WorkspacePolicyChoice | null } | undefined {
  switch (value) {
    case "default":
      return { choice: null };
    case "isolated":
      return { choice: { doorPolicy: "isolated" } };
    case "trusted-shared-support":
      return { choice: { doorPolicy: "trusted", layout: "shared-support", visibility: "public" } };
    case "trusted-shared-support-private":
      return {
        choice: { doorPolicy: "trusted", layout: "shared-support", visibility: "private" },
      };
    case "trusted-full":
      return { choice: { doorPolicy: "trusted", layout: "full" } };
    default:
      return undefined;
  }
}

function doorPolicyChoiceKey(choice: WorkspacePolicyChoice | null): string {
  if (!choice) return "default";
  if (choice.doorPolicy === "isolated") return "isolated";
  if (choice.layout === "full") return "trusted-full";
  return choice.visibility === "private"
    ? "trusted-shared-support-private"
    : "trusted-shared-support";
}

function serveConversationSandboxUpdate(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
  token: AdminToken,
): void {
  const parsed = parseDoorPolicyChoice(body.doorPolicy);
  if (!parsed) {
    jsonRes(res, 400, {
      error:
        "doorPolicy must be 'default', 'isolated', 'trusted-shared-support', 'trusted-shared-support-private', or 'trusted-full'",
    });
    return;
  }
  const scope = resolveTargetConversation(body, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return;
  }
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;
  try {
    const result = applyConversationWorkspacePolicy(
      services.runtime,
      workspace.office(scope.address),
      parsed.choice,
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

function serveGlobalWorkspaceUpdate(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
): void {
  const parsed = parseDoorPolicyChoice(body.doorPolicy);
  if (!parsed) {
    jsonRes(res, 400, {
      error:
        "doorPolicy must be 'default', 'isolated', 'trusted-shared-support', 'trusted-shared-support-private', or 'trusted-full'",
    });
    return;
  }
  try {
    const result = applyGlobalWorkspacePolicy(services.runtime, parsed.choice);
    jsonRes(res, 200, { ok: true, staleConversations: result.staleConversations.length });
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
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;
  try {
    applyConversationSettings(services.runtime, workspace.office(scope.address), {
      slack: { replyMode },
    });
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
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;
  const dir = workspace.office(scope.address).dir;
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
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;
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

  try {
    const result = applyGlobalSettings(services.runtime, {
      provider,
      model,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
    jsonRes(res, 200, {
      ok: true,
      staleConversations: result.staleConversations.map(
        (office) => `${office.platform}:${office.conversationId}`,
      ),
    });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
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

  try {
    applyGlobalSettings(services.runtime, { slack: { replyMode } });
    jsonRes(res, 200, { ok: true });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
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

  try {
    applyGlobalSettings(services.runtime, { sandbox: update });
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
  const first = segments[0];
  if (first === undefined) return true;
  if (segments.length === 1) {
    return WORKSPACE_TOP_DIRS.has(first) || WORKSPACE_TOP_FILES.has(first);
  }
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

/** Inventory of both scopes' declared packages for the selected conversation. */
async function servePackagesList(
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
  try {
    const inventory = await inspectConversationPackages({
      office: workspace.office(scope.address),
    });
    jsonRes(res, 200, { conversationId: scope.conversationId, ...inventory });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Add / remove / refresh, in one route because they share validation and all
 * three answer with the freshly re-read inventory: the panel never has to
 * guess what the write did.
 */
function servePackageMutation(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
  token: AdminToken,
): void {
  const action = body.action;
  if (action !== "add" && action !== "remove" && action !== "refresh") {
    jsonRes(res, 400, { error: "action must be 'add', 'remove', or 'refresh'" });
    return;
  }
  const packageScope = body.scope === "global" ? "global" : "conversation";
  const source = typeof body.source === "string" ? body.source.trim() : "";
  if (!source) {
    jsonRes(res, 400, { error: "source is required" });
    return;
  }
  const scope = resolveTargetConversation(body, token);
  if (scope.error) {
    jsonRes(res, 403, { error: scope.error });
    return;
  }
  const workspace = requireAdminWorkspace(res, services);
  if (!workspace) return;

  const context = {
    office: workspace.office(scope.address),
    runtime: services.runtime,
  };

  try {
    if (action === "add") {
      const result = addPackage(packageScope, source, context);
      jsonRes(res, 200, { ok: true, source: result.source, dir: result.dir });
      return;
    }
    if (action === "refresh") {
      const result = refreshPackage(packageScope, source, context);
      jsonRes(res, 200, { ok: true, source: result.source, dir: result.dir });
      return;
    }
    const removed = removePackage(packageScope, source, context);
    jsonRes(res, removed ? 200 : 404, removed ? { ok: true } : { error: "Not declared here." });
  } catch (err) {
    // Fetch/validation failures are the admin's problem to fix, not a server
    // fault: report them as a bad request with git's own message.
    jsonRes(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
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
        ...(config.url !== undefined ? { url: config.url } : {}),
        ...(config.disabled !== undefined ? { disabled: config.disabled } : {}),
        envKeys: Object.keys(config.env ?? {}),
        headerKeys: Object.keys(config.headers ?? {}),
      },
    ]),
  );
}

const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function mcpStringMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && k.trim()) out[k.trim()] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseMcpServerEntry(raw: unknown): { config?: McpServerConfig; error?: string } {
  if (typeof raw !== "object" || raw === null) return { error: "server entry must be an object" };
  const entry = raw as Record<string, unknown>;
  const command = typeof entry.command === "string" ? entry.command.trim() : "";
  const serverUrl = typeof entry.url === "string" ? entry.url.trim() : "";
  if (!command && !serverUrl) return { error: "set either command (stdio) or url (HTTP)" };
  if (command && serverUrl) return { error: "set only one of command / url" };
  if (serverUrl && !URL.canParse(serverUrl)) {
    return { error: "url is not a valid URL" };
  }
  const args = Array.isArray(entry.args)
    ? entry.args.filter((a): a is string => typeof a === "string")
    : undefined;
  const env = mcpStringMap(entry.env);
  const headers = mcpStringMap(entry.headers);
  return {
    config: {
      ...(command ? { command, ...(args && args.length > 0 ? { args } : {}) } : {}),
      ...(serverUrl ? { url: serverUrl } : {}),
      ...(env ? { env } : {}),
      ...(headers ? { headers } : {}),
      ...(entry.disabled === true ? { disabled: true } : {}),
    },
  };
}

/**
 * Set / remove / toggle one MCP server in one scope. Reads the scope's raw
 * map, applies the change, and writes the full map back (wholesale, like
 * packages — merge would make removal impossible). Runner caches refresh via
 * applyGlobalSettings/applyConversationSettings.
 */
function serveMcpServerMutation(
  res: ServerResponse,
  body: Record<string, unknown>,
  services: AdminServices,
  token: AdminToken,
): void {
  const action = body.action;
  if (action !== "set" && action !== "remove" && action !== "toggle") {
    jsonRes(res, 400, { error: "action must be 'set', 'remove', or 'toggle'" });
    return;
  }
  const mutationScope = body.scope === "global" ? "global" : "conversation";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    jsonRes(res, 400, {
      error: "invalid server name (letters, digits, '_' or '-', starting with a letter)",
    });
    return;
  }
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

  const next: Record<string, McpServerConfig> = { ...current };
  if (action === "set") {
    const parsed = parseMcpServerEntry(body.server);
    if (!parsed.config) {
      jsonRes(res, 400, { error: parsed.error ?? "invalid server entry" });
      return;
    }
    // Env/headers omitted in the payload keep their existing values, so the
    // panel can edit command/args without re-entering credentials.
    const existing = current[name];
    next[name] = {
      ...parsed.config,
      ...(parsed.config.env === undefined && existing?.env ? { env: existing.env } : {}),
      ...(parsed.config.headers === undefined && existing?.headers
        ? { headers: existing.headers }
        : {}),
    };
  } else if (action === "remove") {
    if (!(name in next)) {
      jsonRes(res, 404, { error: "Not declared here." });
      return;
    }
    delete next[name];
  } else {
    if (!(name in next)) {
      jsonRes(res, 404, { error: "Not declared here." });
      return;
    }
    const entry = next[name]!;
    next[name] = entry.disabled ? { ...entry, disabled: undefined } : { ...entry, disabled: true };
  }

  const result =
    mutationScope === "global"
      ? applyGlobalSettings(services.runtime, { mcpServers: next })
      : applyConversationSettings(services.runtime, office, { mcpServers: next });
  if (!result.ok) {
    jsonRes(res, 409, { error: "Conversation is busy; try again shortly." });
    return;
  }
  jsonRes(res, 200, { ok: true });
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
export async function listAllEvents(store: EventStore): Promise<EventSummary[]> {
  const entries = await store.list();
  return entries.map((entry) => {
    const payload = entry.payload;
    return {
      name: entry.filename,
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

function requireAdminEventStore(res: ServerResponse, services: AdminServices): EventStore | null {
  if (!services.eventStore) {
    jsonRes(res, 503, { error: "Working directory not available" });
    return null;
  }
  return services.eventStore;
}

async function serveEventsList(res: ServerResponse, services: AdminServices): Promise<void> {
  const store = requireAdminEventStore(res, services);
  if (!store) return;
  jsonRes(res, 200, { events: await listAllEvents(store) });
}

/** Per-conversation listing — filter all events by conversationId match. */
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
  const store = requireAdminEventStore(res, services);
  if (!store) return;
  const events = (await listAllEvents(store)).filter(
    (e) => e.conversationId === scope.conversationId,
  );
  jsonRes(res, 200, { conversationId: scope.conversationId, events });
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
  const store = requireAdminEventStore(res, services);
  if (!store) return;
  let payload: { conversationId?: string } | null;
  try {
    payload = (await store.read(name)).payload;
  } catch {
    jsonRes(res, 404, { error: "Event not found" });
    return;
  }
  // The store normalizes the legacy `channelId` alias into `conversationId`.
  if (payload?.conversationId !== scope.conversationId) {
    jsonRes(res, 403, { error: "Event does not belong to this conversation." });
    return;
  }
  try {
    await store.delete(name);
    jsonRes(res, 200, { ok: true });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
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

      <section class="card sect" id="sect-packages" data-section="packages">
        <header class="sect-head">
          <div>
            <p class="eyebrow">Skill Packages</p>
            <h2 class="card-title">此對話的 skill 套件</h2>
          </div>
          <button class="refresh-btn" onclick="loadPackages()">↻</button>
        </header>
        <div class="pkg-add">
          <input id="pkg-conv-url" class="pkg-input" type="text" spellcheck="false"
            placeholder="github:owner/repo 或 https://github.com/owner/repo.git" />
          <input id="pkg-conv-ref" class="pkg-input pkg-input-ref" type="text" spellcheck="false"
            placeholder="tag / branch / commit（可留空）" />
          <button class="primary-action-btn" onclick="addPackage('conversation')">Add</button>
        </div>
        <div id="pkg-conv-msg" class="pkg-msg" style="display:none"></div>
        <div id="pkg-conv-content"><div class="loading-msg">Loading…</div></div>
      </section>

      <section class="card sect" id="sect-mcp" data-section="mcp">
        <header class="sect-head">
          <div>
            <p class="eyebrow">MCP Servers</p>
            <h2 class="card-title">此對話的 MCP servers</h2>
          </div>
          <button class="refresh-btn" onclick="loadMcpServers()">↻</button>
        </header>
        <div id="mcp-conv-msg" class="pkg-msg" style="display:none"></div>
        <div id="mcp-conv-content"><div class="loading-msg">Loading…</div></div>
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
            <p class="eyebrow">Global Skill Packages</p>
            <h2 class="card-title">所有對話都會載入的 skill 套件</h2>
          </div>
          <button class="refresh-btn" onclick="loadPackages()">↻</button>
        </header>
        <div class="pkg-add">
          <input id="pkg-global-url" class="pkg-input" type="text" spellcheck="false"
            placeholder="github:owner/repo 或 https://github.com/owner/repo.git" />
          <input id="pkg-global-ref" class="pkg-input pkg-input-ref" type="text" spellcheck="false"
            placeholder="tag / branch / commit（可留空）" />
          <button class="primary-action-btn" onclick="addPackage('global')">Add</button>
        </div>
        <div id="pkg-global-msg" class="pkg-msg" style="display:none"></div>
        <div id="pkg-global-content"><div class="loading-msg">Loading…</div></div>
      </section>

      <section class="card sect">
        <header class="sect-head">
          <div>
            <p class="eyebrow">Global MCP Servers</p>
            <h2 class="card-title">所有對話都可用的 MCP servers</h2>
          </div>
          <button class="refresh-btn" onclick="loadMcpServers()">↻</button>
        </header>
        <div id="mcp-global-msg" class="pkg-msg" style="display:none"></div>
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
    </div>`;

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

    function setActiveConversation(key) {
      activeConversationKey = key;
      const sel = document.getElementById('conv-switcher');
      if (sel && sel.value !== key) sel.value = key;
      // Reset all conversation sections.
      loadSettings();
      loadWorkspace();
      loadSkills();
      loadPackages();
      loadMcpServers();
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
        const data = await apiGet('/admin/api/conversation-state?' + scopeQuery());
        container.innerHTML = renderSettings(data);
      } catch (err) {
        container.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    function renderSettings(data) {
      const thinking = ['off','minimal','low','medium','high','xhigh','max'];
      const thinkingOpts = thinking.map((t) =>
        '<option value="' + t + '"' + (data.thinkingLevel === t ? ' selected' : '') + '>' + t + '</option>'
      ).join('');
      const rulesText = (data.autoReplyRules || []).join('\\n');
      const replyModes = ['top-level','thread'];
      const replyModeOpts = replyModes.map((m) =>
        '<option value="' + m + '"' + (((data.slack && data.slack.replyMode) || 'top-level') === m ? ' selected' : '') + '>' + m + '</option>'
      ).join('');
      const globalReplyMode = (data.slack && data.slack.globalReplyMode) || 'top-level';
      const globalModel = [data.globalProvider, data.globalModel].filter(Boolean).join('/');
      const globalModelLabel = globalModel + (data.globalThinkingLevel ? ':' + data.globalThinkingLevel : '');
      const doorPolicyChoices = [
        ['default', 'Automatic — follows the platform channel (public shares, private reads only, DMs isolated)'],
        ['isolated', 'isolated — own office only'],
        ['trusted-shared-support', 'trusted / shared-support (public) — office + shared memory, skills, events — read-write'],
        ['trusted-shared-support-private', 'trusted / shared-support (private) — same, but shared MEMORY.md is read-only'],
        ['trusted-full', 'trusted / full — entire workspace'],
      ];
      const doorPolicyOpts = doorPolicyChoices.map(([value, label]) =>
        '<option value="' + value + '"' + ((data.workspaceOverride || 'default') === value ? ' selected' : '') + '>' + escHtml(label) + '</option>'
      ).join('');
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
            '<h3 class="card-subtitle">Office data policy</h3>',
            '<div class="config-row"><label>Door policy</label><select id="m-door-policy">' + doorPolicyOpts + '</select></div>',
            '<p class="muted-note">Effective: ' + escHtml(data.workspaceDoorPolicy + ' / ' + data.workspaceLayout + ' / ' + (data.workspaceVisibility || 'public')) + '</p>',
            '<p class="muted-note">Changing the policy rebuilds the office sandbox container with the new mounts on its next message; the container contents are preserved.</p>',
            '<button class="primary-action-btn" onclick="saveDoorPolicy(this)">Save door policy</button>',
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
          ...scopeBody(), provider, model, thinkingLevel,
        });
        result.style.display = 'block'; result.className = 'inline-result ok';
        result.textContent = 'Saved ✓';
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
          ...scopeBody(), enabled, rules,
        });
        result.style.display = 'block'; result.className = 'inline-result ok'; result.textContent = 'Saved ✓';
      } catch (err) {
        result.style.display = 'block'; result.className = 'inline-result err'; result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Save auto-reply';
      }
    }

    async function saveSlack(btn) {
      const replyMode = document.getElementById('m-slack-reply-mode').value;
      const result = document.getElementById('slack-save-result');
      btn.disabled = true; btn.textContent = 'Saving…'; result.style.display = 'none';
      try {
        await apiPost('/admin/api/conversations/slack', {
          ...scopeBody(), replyMode,
        });
        result.style.display = 'block'; result.className = 'inline-result ok'; result.textContent = 'Saved ✓';
      } catch (err) {
        result.style.display = 'block'; result.className = 'inline-result err'; result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Save Slack';
      }
    }

    async function saveDoorPolicy(btn) {
      const doorPolicy = document.getElementById('m-door-policy').value;
      const result = document.getElementById('mount-save-result');
      btn.disabled = true; btn.textContent = 'Saving…'; result.style.display = 'none';
      try {
        await apiPost('/admin/api/conversations/sandbox', {
          ...scopeBody(), doorPolicy,
        });
        result.style.display = 'block'; result.className = 'inline-result ok'; result.textContent = 'Saved ✓';
        loadSettings();
      } catch (err) {
        result.style.display = 'block'; result.className = 'inline-result err'; result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Save door policy';
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

    function packageMessage(scope, text, kind) {
      const el = document.getElementById(scope === 'global' ? 'pkg-global-msg' : 'pkg-conv-msg');
      if (!text) { el.style.display = 'none'; return; }
      el.className = 'pkg-msg pkg-msg-' + kind;
      el.textContent = text;
      el.style.display = 'block';
    }

    function renderPackageList(container, rows, scope) {
      if (rows.length === 0) {
        container.innerHTML = '<div class="empty-state">尚未加入任何套件</div>';
        return;
      }
      container.innerHTML = '<div class="pkg-list">' + rows.map((p) => {
        const provides = p.skills.map((s) => 'skill: ' + s);
        const status = p.error
          ? '<span class="pkg-badge pkg-badge-err">' + escHtml(p.error) + '</span>'
          : p.shadowed
            ? '<span class="pkg-badge pkg-badge-warn">被此對話的同名套件覆蓋，不會載入</span>'
            : '<span class="pkg-badge pkg-badge-ok">已下載</span>'
              + '<span class="pkg-badge pkg-badge-warn">需 /pi-new 才會載入</span>';
        return '<div class="pkg-row">' +
          '<div class="pkg-row-main">' +
            '<code class="pkg-source">' + escHtml(p.source) + '</code>' + status +
          '</div>' +
          (provides.length > 0
            ? '<div class="pkg-provides">' + provides.map((t) => '<span class="pkg-chip">' + escHtml(t) + '</span>').join('') + '</div>'
            : '<div class="pkg-provides pkg-provides-empty">此套件沒有提供 skill</div>') +
          '<div class="pkg-actions">' +
            '<button class="pkg-btn" data-pkg-action="refresh" data-pkg-scope="' + scope + '" data-pkg-source="' + escAttr(p.source) + '">Update</button>' +
            '<button class="pkg-btn pkg-btn-danger" data-pkg-action="remove" data-pkg-scope="' + scope + '" data-pkg-source="' + escAttr(p.source) + '">Remove</button>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
    }

    async function loadPackages() {
      const convEl = document.getElementById('pkg-conv-content');
      const globalEl = document.getElementById('pkg-global-content');
      if (convEl) convEl.innerHTML = '<div class="loading-msg">Loading…</div>';
      if (globalEl) globalEl.innerHTML = '<div class="loading-msg">Loading…</div>';
      try {
        const data = await apiGet('/admin/api/packages?' + scopeQuery());
        if (convEl) renderPackageList(convEl, data.conversation, 'conversation');
        if (globalEl) renderPackageList(globalEl, data.global, 'global');
      } catch (err) {
        if (convEl) convEl.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
        if (globalEl) globalEl.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    async function mutatePackage(scope, action, source) {
      packageMessage(scope, action === 'remove' ? '移除中…' : '取得中…', 'busy');
      try {
        const result = await apiPost('/admin/api/packages/mutate', {
          action: action,
          scope: scope,
          source: source,
          ...scopeBody(),
        });
        packageMessage(
          scope,
          action === 'remove'
            ? '已移除。對話輸入 /pi-new 生效。'
            : '完成：' + result.source + '（對話輸入 /pi-new 生效）',
          'ok',
        );
        await loadPackages();
      } catch (err) {
        // Fetch and validation failures land here, next to the input that
        // caused them, rather than turning into a silently missing feature.
        packageMessage(scope, err.message, 'err');
      }
    }

    async function addPackage(scope) {
      const urlEl = document.getElementById(scope === 'global' ? 'pkg-global-url' : 'pkg-conv-url');
      const refEl = document.getElementById(scope === 'global' ? 'pkg-global-ref' : 'pkg-conv-ref');
      const url = urlEl.value.trim();
      const ref = refEl.value.trim();
      if (!url) { packageMessage(scope, '請填入 git URL', 'err'); return; }
      // Assembled here so nobody has to hand-write the @ref form, whose
      // ambiguity with git@host:owner/repo is the one sharp edge in the syntax.
      await mutatePackage(scope, 'add', ref ? url + '@' + ref : url);
      urlEl.value = '';
      refEl.value = '';
    }

    document.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-pkg-action]');
      if (!btn) return;
      void mutatePackage(btn.dataset.pkgScope, btn.dataset.pkgAction, btn.dataset.pkgSource);
    });

    // ── MCP servers ───────────────────────────────────────────────────────────────────────

    function mcpMessage(scope, text, kind) {
      const el = document.getElementById(scope === 'global' ? 'mcp-global-msg' : 'mcp-conv-msg');
      if (!el) return;
      el.style.display = 'block';
      el.className = 'pkg-msg pkg-msg-' + kind;
      el.textContent = text;
    }

    function renderMcpServer(scope, name, server) {
      const transport = server.command
        ? 'stdio: ' + server.command + (server.args && server.args.length ? ' ' + server.args.join(' ') : '')
        : 'http: ' + (server.url || '');
      const keys = [];
      if (server.envKeys && server.envKeys.length) keys.push('env: ' + server.envKeys.join(', '));
      if (server.headerKeys && server.headerKeys.length) keys.push('headers: ' + server.headerKeys.join(', '));
      return '<div class="pkg-row">' +
        '<div class="pkg-row-main"><span class="pkg-source">' + escHtml(name) + '</span>' +
        (server.disabled ? '<span class="pkg-badge pkg-badge-warn">disabled</span>' : '<span class="pkg-badge pkg-badge-ok">enabled</span>') +
        '</div>' +
        '<div class="skill-desc">' + escHtml(transport) + (keys.length ? ' · ' + escHtml(keys.join(' · ')) : '') + '</div>' +
        '<div class="pkg-actions">' +
          '<button class="pkg-btn" data-mcp-action="toggle" data-mcp-scope="' + scope + '" data-mcp-name="' + escAttr(name) + '">' + (server.disabled ? 'Enable' : 'Disable') + '</button>' +
          '<button class="pkg-btn pkg-btn-danger" data-mcp-action="remove" data-mcp-scope="' + scope + '" data-mcp-name="' + escAttr(name) + '">Remove</button>' +
        '</div>' +
      '</div>';
    }

    function renderMcpScope(el, scope, servers) {
      const rows = Object.entries(servers).map(([name, server]) => renderMcpServer(scope, name, server)).join('');
      el.innerHTML =
        '<div class="pkg-list">' + (rows || '<div class="pkg-provides-empty">No MCP servers</div>') + '</div>' +
        '<div class="pkg-add" style="margin-top:10px">' +
          '<input id="mcp-' + scope + '-name" class="pkg-input pkg-input-ref" type="text" spellcheck="false" placeholder="name" />' +
          '<input id="mcp-' + scope + '-target" class="pkg-input" type="text" spellcheck="false" placeholder="npx -y @modelcontextprotocol/server-github 或 https://host/mcp" />' +
          '<input id="mcp-' + scope + '-env" class="pkg-input" type="text" spellcheck="false" placeholder="KEY=value KEY2=value2（可留空；HTTP 則為 header）" />' +
          '<button class="primary-action-btn" data-mcp-action="add" data-mcp-scope="' + scope + '">Add</button>' +
        '</div>';
    }

    async function loadMcpServers() {
      const convEl = document.getElementById('mcp-conv-content');
      const globalEl = document.getElementById('mcp-global-content');
      if (convEl) convEl.innerHTML = '<div class="loading-msg">Loading…</div>';
      if (globalEl) globalEl.innerHTML = '<div class="loading-msg">Loading…</div>';
      try {
        const data = await apiGet('/admin/api/mcp-servers?' + scopeQuery());
        if (convEl) renderMcpScope(convEl, 'conversation', data.conversation);
        if (globalEl) renderMcpScope(globalEl, 'global', data.global);
      } catch (err) {
        if (convEl) convEl.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
        if (globalEl) globalEl.innerHTML = '<div class="err-msg">' + escHtml(err.message) + '</div>';
      }
    }

    async function mutateMcpServer(scope, action, name, server) {
      mcpMessage(scope, '儲存中…', 'busy');
      try {
        await apiPost('/admin/api/mcp-servers/mutate', {
          action: action,
          scope: scope,
          name: name,
          ...(server ? { server: server } : {}),
          ...scopeBody(),
        });
        mcpMessage(scope, '完成。新設定在下一次回應生效。', 'ok');
        await loadMcpServers();
      } catch (err) {
        mcpMessage(scope, err.message, 'err');
      }
    }

    function addMcpServer(scope) {
      const name = document.getElementById('mcp-' + scope + '-name').value.trim();
      const target = document.getElementById('mcp-' + scope + '-target').value.trim();
      const envRaw = document.getElementById('mcp-' + scope + '-env').value.trim();
      if (!name || !target) { mcpMessage(scope, '請填入 name 與 command/URL', 'err'); return; }
      const server = {};
      const pairs = {};
      for (const token of envRaw ? envRaw.split(/\\s+/) : []) {
        const eq = token.indexOf('=');
        if (eq > 0) pairs[token.slice(0, eq)] = token.slice(eq + 1);
      }
      if (/^https?:[/][/]/.test(target)) {
        server.url = target;
        if (Object.keys(pairs).length) server.headers = pairs;
      } else {
        const parts = target.split(/\\s+/);
        server.command = parts[0];
        if (parts.length > 1) server.args = parts.slice(1);
        if (Object.keys(pairs).length) server.env = pairs;
      }
      void mutateMcpServer(scope, 'set', name, server);
    }

    document.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-mcp-action]');
      if (!btn) return;
      if (btn.dataset.mcpAction === 'add') { addMcpServer(btn.dataset.mcpScope); return; }
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

    async function openLogin(silent) {
      const result = document.getElementById('vault-link-result');
      const frame = document.getElementById('login-frame');
      if (silent) { frame.removeAttribute('src'); frame.style.display = 'none'; result.style.display = 'none'; return; }
      result.style.display = 'block'; result.className = 'link-result loading'; result.textContent = 'Generating link…';
      try {
        const data = await apiPost('/admin/api/conversations/login-link', scopeBody());
        result.className = 'link-result ok';
        result.innerHTML =
          '<span class="link-vault">vault: <code>' + escHtml(data.vaultId) + '</code></span>' +
          '<a href="' + escAttr(data.url) + '" target="_blank" rel="noopener">' + escHtml(data.url) + '</a>' +
          '<button class="copy-link-btn" data-admin-action="copy-link" data-copy-text="' + escAttr(data.url) + '">Copy</button>';
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
        const data = await apiPost('/admin/api/conversations/session-link', scopeBody());
        result.className = 'link-result ok';
        result.innerHTML =
          '<a href="' + escAttr(data.url) + '" target="_blank" rel="noopener">' + escHtml(data.url) + '</a>' +
          '<button class="copy-link-btn" data-admin-action="copy-link" data-copy-text="' + escAttr(data.url) + '">Copy</button>';
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
        const data = await apiGet('/admin/api/conversations/events?' + scopeQuery());
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
      const thinking = ['off','minimal','low','medium','high','xhigh','max'];
      const thinkingOpts = thinking.map((t) =>
        '<option value="' + t + '"' + (data.thinkingLevel === t ? ' selected' : '') + '>' + t + '</option>'
      ).join('');
      const replyModes = ['top-level','thread'];
      const replyModeOpts = replyModes.map((m) =>
        '<option value="' + m + '"' + (((data.slack && data.slack.replyMode) || 'top-level') === m ? ' selected' : '') + '>' + m + '</option>'
      ).join('');
      const gDoorKey = !data.workspaceDoorPolicy
        ? 'default'
        : (data.workspaceDoorPolicy === 'isolated'
          ? 'isolated'
          : (data.workspaceLayout === 'full'
            ? 'trusted-full'
            : ((data.workspaceVisibility || 'public') === 'private' ? 'trusted-shared-support-private' : 'trusted-shared-support')));
      const gDoorPolicyChoices = [
        ['default', 'Automatic — follows each platform channel (public shares, private reads only, DMs isolated)'],
        ['isolated', 'isolated — own office only'],
        ['trusted-shared-support', 'trusted / shared-support (public) — office + shared memory, skills, events — read-write'],
        ['trusted-shared-support-private', 'trusted / shared-support (private) — same, but shared MEMORY.md is read-only'],
        ['trusted-full', 'trusted / full — entire workspace'],
      ];
      const gDoorPolicyOpts = gDoorPolicyChoices.map(([value, label]) =>
        '<option value="' + value + '"' + (gDoorKey === value ? ' selected' : '') + '>' + escHtml(label) + '</option>'
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
            '<button class="primary-action-btn" onclick="saveGlobalSandbox(this)">Save sandbox</button>',
            '<div id="g-sandbox-result" class="inline-result" style="display:none"></div>',
          '</div>',
          '<div class="config-block">',
            '<h3 class="card-subtitle">Office door policy</h3>',
            '<div class="config-row"><label>Default</label><select id="g-door-policy">' + gDoorPolicyOpts + '</select></div>',
            '<p class="muted-note">Applies to offices without their own policy. Affected offices rebuild their sandbox container with the new mounts on the next message; container contents are preserved.</p>',
            '<button class="primary-action-btn" onclick="saveGlobalWorkspace(this)">Save door policy</button>',
            '<div id="g-workspace-result" class="inline-result" style="display:none"></div>',
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
      const result = document.getElementById('g-sandbox-result');
      btn.disabled = true; btn.textContent = 'Saving…'; result.style.display = 'none';
      try {
        await apiPost('/admin/api/settings/sandbox', { cpus, memory, boostCpus, boostMemory });
        result.style.display = 'block'; result.className = 'inline-result ok'; result.textContent = 'Saved ✓';
      } catch (err) {
        result.style.display = 'block'; result.className = 'inline-result err'; result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Save sandbox';
      }
    }

    async function saveGlobalWorkspace(btn) {
      const doorPolicy = document.getElementById('g-door-policy').value;
      const result = document.getElementById('g-workspace-result');
      btn.disabled = true; btn.textContent = 'Saving…'; result.style.display = 'none';
      try {
        const data = await apiPost('/admin/api/settings/workspace', { doorPolicy });
        result.style.display = 'block'; result.className = 'inline-result ok';
        result.textContent = data.staleConversations > 0
          ? 'Saved ✓ (' + data.staleConversations + ' busy conversation(s) refresh after their current run)'
          : 'Saved ✓';
      } catch (err) {
        result.style.display = 'block'; result.className = 'inline-result err'; result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Save door policy';
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

    initConvSwitcher();
    loadModels().finally(() => {
      loadSettings();
      loadWorkspace();
      loadSkills();
      loadPackages();
      loadMcpServers();
      loadConversationEvents();
    });
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

  /* ── Packages ───────────────────────────────────────────────────────── */

  .pkg-add { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
  .pkg-input {
    flex: 1 1 240px; min-width: 0; padding: 8px 10px;
    border: 1px solid var(--border); border-radius: 8px; background: var(--card);
    font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.8rem; color: var(--text);
  }
  .pkg-input-ref { flex: 0 1 200px; }
  .pkg-msg {
    padding: 8px 12px; border-radius: 8px; margin-bottom: 12px;
    font-size: 0.82rem; line-height: 1.5; word-break: break-word;
  }
  .pkg-msg-ok { background: rgba(22,163,74,0.1); color: #15803d; }
  .pkg-msg-err { background: rgba(220,38,38,0.1); color: #b91c1c; }
  .pkg-msg-busy { background: rgba(0,0,0,0.05); color: var(--muted); }
  .pkg-list { display: flex; flex-direction: column; gap: 8px; }
  .pkg-row {
    padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px;
    background: rgba(0,0,0,0.02);
  }
  .pkg-row-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pkg-source {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.78rem; color: var(--text); word-break: break-all;
  }
  .pkg-badge {
    padding: 1px 8px; border-radius: 999px; font-size: 0.7rem;
    font-weight: 600; letter-spacing: 0.03em;
  }
  .pkg-badge-ok { background: rgba(22,163,74,0.1); color: #15803d; }
  .pkg-badge-warn { background: rgba(217,119,6,0.12); color: var(--accent); }
  .pkg-badge-err { background: rgba(220,38,38,0.1); color: #b91c1c; }
  .pkg-provides { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
  .pkg-provides-empty { color: var(--subtle); font-size: 0.78rem; }
  .pkg-chip {
    padding: 1px 8px; border-radius: 6px; background: rgba(59,130,246,0.1);
    color: #1d4ed8; font-size: 0.72rem;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }
  .pkg-actions { margin-top: 8px; display: flex; gap: 8px; }
  .pkg-btn {
    padding: 4px 10px; border: 1px solid var(--border); border-radius: 7px;
    background: var(--card); color: var(--text); font-size: 0.76rem; cursor: pointer;
  }
  .pkg-btn:hover { background: rgba(0,0,0,0.05); }
  .pkg-btn-danger { color: #b91c1c; }
  .pkg-group { margin-bottom: 16px; }
  .pkg-group-head {
    display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
    font-size: 0.85rem;
  }
  .pkg-group-head .pkg-btn { margin-left: auto; }

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
    .portal-frame { min-height: 520px; }
    .workspace-split { grid-template-columns: 1fr; }
    .workspace-tree, .workspace-preview { max-height: 260px; }
  }
`;
