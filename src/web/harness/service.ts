import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Office, Workspace } from "../../office/index.js";
import { createOfficeAddress } from "../../office/index.js";
import { SessionStore } from "../../harness/index.js";
import { loadSessionViewModel } from "../session-view/service.js";
import type { WebAuthRegistry } from "../auth/registry.js";
import type { WebAccount, WebWorkspaceRecord } from "../auth/types.js";
import type { WebSessionHistory, WebSessionRelation, WebSessionSummary } from "./protocol.js";

export type { WebSessionHistory, WebSessionSummary } from "./protocol.js";

/** Authorized domain operations for Web workspaces and their durable sessions. */
export class WebHarnessService {
  constructor(
    private readonly registry: WebAuthRegistry,
    private readonly workspace: Workspace,
  ) {}

  listWorkspaces(account: WebAccount): readonly WebWorkspaceRecord[] {
    return this.registry.listWorkspaces(account.id);
  }

  createWorkspace(account: WebAccount, name: string): WebWorkspaceRecord {
    const record = this.registry.createWorkspace(account.id, name);
    this.office(record).ensure();
    return record;
  }

  renameWorkspace(
    account: WebAccount,
    workspaceId: string,
    name: string,
  ): WebWorkspaceRecord | null {
    return this.registry.renameWorkspace(account.id, workspaceId, name);
  }

  getOwnedWorkspace(account: WebAccount, workspaceId: string): WebWorkspaceRecord | null {
    return this.registry.getOwnedWorkspace(account.id, workspaceId);
  }

  async listSessions(
    account: WebAccount,
    workspaceId: string,
  ): Promise<readonly WebSessionSummary[] | null> {
    const owned = this.getOwnedWorkspace(account, workspaceId);
    if (!owned) return null;
    const office = this.office(owned);
    if (!existsSync(office.sessionsDir)) return [];

    const currentFileName = readCurrentFileName(office);
    const summaries: WebSessionSummary[] = [];
    for (const fileName of readdirSync(office.sessionsDir)) {
      if (!fileName.endsWith(".jsonl")) continue;
      const sessionFile = join(office.sessionsDir, fileName);
      if (!isRegularFile(sessionFile)) continue;
      const summary = await readSessionSummary(sessionFile, fileName === currentFileName);
      if (summary) summaries.push(summary);
    }
    return summaries.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async loadHistory(
    account: WebAccount,
    workspaceId: string,
    sessionId?: string,
  ): Promise<WebSessionHistory | null> {
    const owned = this.getOwnedWorkspace(account, workspaceId);
    if (!owned) return null;
    const office = this.office(owned);
    const sessionFile = findSessionByOpaqueId(office, sessionId);
    if (!sessionFile) return null;
    const view = await loadSessionViewModel(sessionFile);
    return {
      sessionId: view.sessionId,
      title: view.title,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
      entryCount: view.entryCount,
      items: view.items.map((item) => ({
        ...item,
        ...(item.threads ? { threads: item.threads.map(publicRelation) } : {}),
      })),
      ...(view.parent ? { parent: publicRelation(view.parent) } : {}),
      threads: view.threads.map(publicRelation),
    };
  }

  private office(record: WebWorkspaceRecord): Office {
    return this.workspace.office(createOfficeAddress("web", record.id));
  }
}

async function readSessionSummary(
  sessionFile: string,
  current: boolean,
): Promise<WebSessionSummary | null> {
  try {
    const store = await SessionStore.open(sessionFile);
    const header = store.getHeader();
    const entries = await store.getEntries();
    const lastTimestamp = entries.at(-1)?.timestamp;
    return {
      id: header.id,
      title: (await store.getSessionName()) || `Session ${header.id.slice(0, 8)}`,
      createdAt: header.timestamp,
      updatedAt:
        typeof lastTimestamp === "number" && Number.isFinite(lastTimestamp)
          ? new Date(lastTimestamp).toISOString()
          : header.timestamp,
      entryCount: entries.length,
      current,
    };
  } catch {
    return null;
  }
}

function findSessionByOpaqueId(office: Office, sessionId?: string): string | null {
  if (!existsSync(office.sessionsDir)) return null;
  const requestedId = sessionId?.trim();
  if (!requestedId) {
    const currentFileName = readCurrentFileName(office);
    if (!currentFileName) return null;
    const current = join(office.sessionsDir, currentFileName);
    return isRegularFile(current) ? current : null;
  }

  for (const fileName of readdirSync(office.sessionsDir)) {
    if (!fileName.endsWith(".jsonl")) continue;
    const candidate = join(office.sessionsDir, fileName);
    if (!isRegularFile(candidate)) continue;
    try {
      if (SessionStore.readHeader(candidate)?.id === requestedId) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function readCurrentFileName(office: Office): string | null {
  try {
    const fileName = readFileSync(join(office.sessionsDir, "current"), "utf8").trim();
    return fileName && fileName === fileName.split(/[\\/]/).at(-1) && fileName.endsWith(".jsonl")
      ? fileName
      : null;
  } catch {
    return null;
  }
}

function publicRelation(relation: {
  kind: "parent" | "thread";
  sessionId: string;
  title: string;
  updatedAt: string;
  entryCount: number;
  summary?: string;
  anchorEntryId?: string;
}): WebSessionRelation {
  return {
    kind: relation.kind,
    sessionId: relation.sessionId,
    title: relation.title,
    updatedAt: relation.updatedAt,
    entryCount: relation.entryCount,
    ...(relation.summary !== undefined ? { summary: relation.summary } : {}),
    ...(relation.anchorEntryId !== undefined ? { anchorEntryId: relation.anchorEntryId } : {}),
  };
}

function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
