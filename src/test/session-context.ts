import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MikanAgentSession } from "../harness/session.js";

export async function contextMessages(session: MikanAgentSession): Promise<AgentMessage[]> {
  return (await session.sessionStore.buildSessionContext()).messages;
}
