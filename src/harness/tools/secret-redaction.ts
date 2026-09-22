import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { ENV_MANIFEST, readEnv } from "../../env-manifest.js";
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

export function withSecretRedaction(tool: MikanHarnessTool): MikanHarnessTool {
  const original = tool.execute.bind(tool);
  tool.execute = async (...args: Parameters<MikanHarnessTool["execute"]>) => {
    const result = await original(...args);
    const secrets = collectSecretEntries();
    if (secrets.length === 0) return result;
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
