/**
 * Agent session services - creates and manages cwd-bound runtime services.
 *
 * Following pi-coding-agent's pattern of separating service creation from
 * session agent creation, but adapted for mikan's platform-driven lifecycle.
 */
import {
  Agent,
  convertToLlm,
  type AgentTool,
  type CompactionSettings,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  type Api,
  type Credential,
  type CredentialStore,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { getAuthPath } from "./config.js";
import { ModelRegistry } from "./model-registry.js";
import type { RetrySettings } from "./retry-policy.js";
import { SessionManager } from "./session-manager.js";

/**
 * Adapts mikan's file-backed `AuthStorage` to pi-ai's `CredentialStore`
 * contract, so pi-agent-core's compaction helper (which needs a full
 * `Models` collection) resolves API keys the same way the rest of mikan
 * does. mikan has no credential-removal flow today, so `delete` is a no-op.
 */
class MikanCredentialStore implements CredentialStore {
  constructor(private readonly authStorage: AuthStorage) {}

  async read(providerId: string): Promise<Credential | undefined> {
    const key = this.authStorage.getApiKey(providerId);
    return key ? { type: "api_key", key } : undefined;
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const next = await fn(await this.read(providerId));
    if (next?.type === "api_key" && next.key) {
      this.authStorage.setApiKey(providerId, next.key);
    }
    return next;
  }

  async delete(): Promise<void> {}
}

/**
 * Non-fatal issues collected while creating services or sessions.
 *
 * @internal
 */
interface AgentSessionRuntimeDiagnostic {
  type: "info" | "warning" | "error";
  message: string;
}

/** Coherent cwd-bound runtime services. */
export interface MikanAgentSessionServices {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  models: Models;
  diagnostics: AgentSessionRuntimeDiagnostic[];
}

/** Inputs for creating an Agent from services. */
export interface CreateMikanAgentOptions {
  services: MikanAgentSessionServices;
  sessionManager: SessionManager;
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool[];
  conversationId: string;
  compactionSettings?: CompactionSettings;
  retrySettings?: RetrySettings;
}

/** Result of creating an agent. */
export interface CreateMikanAgentResult {
  agent: Agent;
  session: AgentSession;
}

/**
 * Create cwd-bound runtime services.
 *
 * Returns services plus diagnostics. Does not create an Agent — that is
 * done separately via {@link createMikanAgent}.
 */
export function createMikanSessionServices(): MikanAgentSessionServices {
  const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
  const authStorage = AuthStorage.create(getAuthPath());
  const modelRegistry = ModelRegistry.create(authStorage);
  const models = builtinModels({ credentials: new MikanCredentialStore(authStorage) });

  const authError = authStorage.getError();
  if (authError) {
    diagnostics.push({ type: "warning", message: `Auth storage: ${authError}` });
  }

  const error = modelRegistry.getError();
  if (error) {
    diagnostics.push({ type: "warning", message: `Model registry: ${error}` });
  }

  return { authStorage, modelRegistry, models, diagnostics };
}

/**
 * Create an Agent (and its resilience-owning AgentSession) from previously
 * created services.
 */
export async function createMikanAgent(
  options: CreateMikanAgentOptions,
): Promise<CreateMikanAgentResult> {
  const {
    services,
    sessionManager,
    systemPrompt,
    model,
    thinkingLevel,
    tools,
    compactionSettings,
    retrySettings,
  } = options;

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel,
      tools,
    },
    convertToLlm,
    getApiKey: async (provider: string) => {
      const key = await services.modelRegistry.getApiKeyForProvider(provider);
      if (!key) {
        throw new Error(
          `No API key for provider "${provider}". Set the appropriate environment variable or configure via auth.json`,
        );
      }
      return key;
    },
  });

  const loadedSession = sessionManager.buildSessionContext();
  if (loadedSession.messages.length > 0) {
    agent.state.messages = loadedSession.messages;
  }

  const session = new AgentSession(agent, sessionManager, {
    models: services.models,
    compactionSettings,
    retrySettings,
  });

  return { agent, session };
}
