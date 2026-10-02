import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { ENV_MANIFEST, readEnv } from "../../env-manifest.js";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { MikanHarnessTool } from "../types.js";

const MIN_SECRET_LENGTH = 8;

interface SecretEntry {
  label: string;
  value: string;
}

function collectSecretEntries(): SecretEntry[] {
  const entries: SecretEntry[] = [];
  for (const group of ENV_MANIFEST) {
    for (const spec of group.vars) {
      if (!spec.secret) continue;
      const value = readEnv(spec.name);
      if (!value || value.length < MIN_SECRET_LENGTH) continue;
      entries.push({ label: spec.name, value });
    }
  }
  return entries.toSorted((a, b) => b.value.length - a.value.length);
}

export function redactSecrets(
  text: string,
  secrets: SecretEntry[] = collectSecretEntries(),
): string {
  if (!text || secrets.length === 0) return text;
  let result = text;
  for (const { label, value } of secrets) {
    if (!result.includes(value)) continue;
    result = result.split(value).join(`[SECRET:${label}]`);
  }
  return result;
}

export type { SecretEntry };

function redactingApi(
  api: ToolExecutionApi,
  secrets: SecretEntry[],
): { api: ToolExecutionApi; flush: () => void } {
  const keep = Math.max(...secrets.map((secret) => secret.value.length)) - 1;
  const decoder = new TextDecoder();
  let pending = "";
  return {
    api: {
      ...api,
      output: (chunk) => {
        pending = redactSecrets(
          pending + (typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })),
          secrets,
        );
        const cut = pending.length - keep;
        if (cut <= 0) return;
        api.output(pending.slice(0, cut));
        pending = pending.slice(cut);
      },
      diagnostic: (diagnostic) => {
        api.diagnostic({ ...diagnostic, message: redactSecrets(diagnostic.message, secrets) });
      },
    },
    flush: () => {
      const rest = redactSecrets(pending + decoder.decode(), secrets);
      pending = "";
      if (rest) api.output(rest);
    },
  };
}

export function withSecretRedaction(tool: MikanHarnessTool): MikanHarnessTool {
  const original = tool.execute.bind(tool);
  tool.execute = async (args, api, context) => {
    const secrets = collectSecretEntries();
    if (secrets.length === 0) return original(args, api, context);
    const redacting = redactingApi(api, secrets);
    let result: Awaited<ReturnType<MikanHarnessTool["execute"]>>;
    try {
      result = await original(args, redacting.api, context);
    } catch (error) {
      if (error instanceof Error) {
        error.message = redactSecrets(error.message, secrets);
        if (error.stack) error.stack = redactSecrets(error.stack, secrets);
      }
      throw error;
    } finally {
      redacting.flush();
    }
    if (result.content === undefined) return result;
    return {
      ...result,
      content: result.content.map((part): TextContent | ImageContent =>
        part.type === "text"
          ? Object.assign({}, part, { text: redactSecrets(part.text, secrets) })
          : part,
      ),
    };
  };
  return tool;
}
