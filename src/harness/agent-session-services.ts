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
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { type Api, type Model } from "@earendil-works/pi-ai";
import { AuthStorage } from "./auth-storage.js";
import { getAuthPath } from "./config.js";
import { ModelRegistry } from "./model-registry.js";
import { SessionManager } from "./session-manager.js";

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
}

/** Result of creating an agent. */
export interface CreateMikanAgentResult {
  agent: Agent;
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

  const error = modelRegistry.getError();
  if (error) {
    diagnostics.push({ type: "warning", message: `Model registry: ${error}` });
  }

  return { authStorage, modelRegistry, diagnostics };
}

/**
 * Create an Agent from previously created services.
 */
export async function createMikanAgent(
  options: CreateMikanAgentOptions,
): Promise<CreateMikanAgentResult> {
  const { services, sessionManager, systemPrompt, model, thinkingLevel, tools } = options;

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

  return { agent };
}
