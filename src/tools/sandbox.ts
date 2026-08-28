import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { SandboxConfig } from "../sandbox/index.js";
import type { OfficeAddress, ResourceLimits, SandboxResourceController } from "../types.js";
import { runtimeResourceKey } from "../sandbox/identity.js";

const sandboxSchema = Type.Object({
  action: Type.Union([Type.Literal("status"), Type.Literal("set")], {
    description: "Use status to inspect current limits, or set to apply temporary limits.",
  }),
  cpus: Type.Optional(
    Type.String({
      description: "CPU limit for action=set, for example '0.5', '1', or '2'.",
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
  address: OfficeAddress;
}

interface SandboxToolController {
  sandbox: SandboxConfig;
  resourceController?: Pick<SandboxResourceController, "getLimitStatus" | "setLimits">;
}

export function createSandboxTool(controller: SandboxToolController): {
  tool: AgentTool<typeof sandboxSchema>;
  setSandboxContext: (context: SandboxToolContext) => void;
} {
  let sandboxContext: SandboxToolContext | null = null;

  const tool: AgentTool<typeof sandboxSchema> = {
    name: "sandbox",
    label: "sandbox",
    executionMode: "sequential",
    description:
      "Inspect or temporarily set CPU/memory limits for the current managed sandbox. Limits apply to this conversation's runtime and are cleared when it stops.",
    parameters: sandboxSchema,
    execute: async (_toolCallId: string, params: SandboxToolParams, signal?: AbortSignal) => {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      if (!sandboxContext) {
        throw new Error("Sandbox context not configured");
      }
      if (controller.sandbox.type !== "image" || !controller.resourceController) {
        throw new Error("The sandbox tool only supports image:* managed sandboxes");
      }

      const containerKey = runtimeResourceKey(controller.sandbox, {
        userId: sandboxContext.userId,
        address: sandboxContext.address,
      });

      if (params.action === "set") {
        const limits = normalizeLimits(params);
        const status = await controller.resourceController.setLimits(containerKey, limits);
        return textResult(
          `Updated sandbox limits for ${containerKey}: ${formatLimits(status.limits)}. These temporary limits are cleared when the sandbox runtime stops.`,
        );
      }

      const status = controller.resourceController.getLimitStatus(containerKey);
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
