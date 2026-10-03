import { basename, dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MikanAgentSession } from "../harness/session.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office } from "../office/types.js";
import { SessionStore } from "../sessions/session-store.js";
import type { SessionInspection } from "../sessions/types.js";

export async function contextMessages(session: MikanAgentSession): Promise<AgentMessage[]> {
  return (await session.sessionStore.buildSessionContext()).messages;
}

function officeAt(path: string): Office {
  const name = basename(path)
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase();
  return createWorkspace({
    root: join(dirname(path), "workspace"),
    stateDir: join(dirname(path), "state"),
  }).office(createOfficeAddress("slack", `C${name}`));
}

export async function openSessionAt(path: string): Promise<SessionStore> {
  const office = officeAt(path);
  return SessionStore.open(office, office.address.conversationId);
}

export async function inspectSessionAt(path: string): Promise<SessionInspection> {
  const office = officeAt(path);
  const inspection = await SessionStore.inspect(office, office.address.conversationId);
  if (!inspection) throw new Error(`No session at ${path}`);
  return inspection;
}

export async function inspectExecutionAt(path: string) {
  const office = officeAt(path);
  return SessionStore.inspectExecution(office, office.address.conversationId);
}
