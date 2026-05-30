import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { DockerContainerManager, ResourceLimits } from "../provisioner.js";
import type { SandboxConfig } from "../sandbox/index.js";
import { resolveActorVaultKey } from "../vault-routing.js";

const sandboxSchema = Type.Object({
  action: Type.Union([Type.Literal("status"), Type.Literal("set")], {
    description: "Use status to inspect current limits, or set to apply temporary limits.",
  }),
  cpus: Type.Optional(
    Type.String({
      description: "Docker CPU limit for action=set, for example '0.5', '1', or '2'.",
    }),
  ),
  memory: Type.Optional(
    Type.String({
      description: "Docker memory limit for action=set, for example '512m', '1g', or '4g'.",
    }),
  ),
});

type SandboxToolParams = {
  action: "status" | "set";
  cpus?: string;
  memory?: string;
};

interface SandboxToolContext {
  userId: string;
  conversationId: string;
}

interface SandboxToolController {
  sandbox: SandboxConfig;
  provisioner?: Pick<DockerContainerManager, "getLimitStatus" | "setLimits">;
}

export function createSandboxTool(controller: SandboxToolController): {
  tool: AgentTool<typeof sandboxSchema>;
  setSandboxContext: (context: SandboxToolContext) => void;
} {
  let sandboxContext: SandboxToolContext | null = null;

  const tool: AgentTool<typeof sandboxSchema> = {
    name: "sandbox",
    label: "sandbox",
    description:
      "Inspect or temporarily set CPU/memory limits for the current managed image sandbox. Limits apply to this conversation's sandbox container and are cleared when the container stops.",
    parameters: sandboxSchema,
    execute: async (_toolCallId: string, params: SandboxToolParams, signal?: AbortSignal) => {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      if (!sandboxContext) {
        throw new Error("Sandbox context not configured");
      }
      if (controller.sandbox.type !== "image" || !controller.provisioner) {
        throw new Error("The sandbox tool only supports image:* managed sandboxes");
      }

      const containerKey = resolveActorVaultKey(
        controller.sandbox,
        sandboxContext.userId,
        sandboxContext.conversationId,
      );

      if (params.action === "set") {
        const limits = normalizeLimits(params);
        const status = await controller.provisioner.setLimits(containerKey, limits);
        return textResult(
          `Updated sandbox limits for ${containerKey}: ${formatLimits(status.limits)}. These temporary limits are cleared when the sandbox container stops.`,
        );
      }

      const status = controller.provisioner.getLimitStatus(containerKey);
      return textResult(
        `Sandbox limits for ${containerKey}: ${formatLimits(status.limits)}${status.boosted ? " (boosted)" : ""}.`,
      );
    },
  };

  return {
    tool,
    setSandboxContext: (context: SandboxToolContext) => {
      sandboxContext = context;
    },
  };
}

function normalizeLimits(params: SandboxToolParams): ResourceLimits {
  const cpus = normalizeLimitValue("cpus", params.cpus);
  const memory = normalizeLimitValue("memory", params.memory);
  if (!cpus && !memory) {
    throw new Error("action=set requires cpus and/or memory");
  }
  return { ...(cpus ? { cpus } : {}), ...(memory ? { memory } : {}) };
}

function normalizeLimitValue(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new Error(`${name} must not contain whitespace or shell metacharacters`);
  }
  return trimmed;
}

function formatLimits(limits: ResourceLimits | undefined): string {
  return `CPU ${limits?.cpus ?? "unlimited"} / Memory ${limits?.memory ?? "unlimited"}`;
}

function textResult(text: string): {
  content: Array<{ type: "text"; text: string }>;
  details: undefined;
} {
  return { content: [{ type: "text", text }], details: undefined };
}
