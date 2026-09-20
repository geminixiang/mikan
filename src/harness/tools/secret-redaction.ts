/**
 * Redacts secret env var values out of tool output before it reaches the
 * model or gets persisted in the session transcript.
 *
 * mikan does not sandbox-isolate environment variables in host sandbox mode
 * (`docs/testing/slack-e2e.md`, `AGENTS.md`: host sandbox is trusted, not OS
 * isolation), so a tool that runs a shell command or reads a file can expose
 * any secret value the mikan process itself holds — `echo $OPENROUTER_API_KEY`
 * or `cat .env` return it in plain text. Without this pass, that plain text
 * flows straight into the model's context and the durable session JSONL; the
 * only remaining defense was the model choosing not to repeat it, which is
 * not a defense the model can be trusted to hold up. This is defense in
 * depth, not the sole one: authorized tools should still avoid emitting
 * secrets in the first place.
 *
 * `ENV_MANIFEST` is mikan's own inventory of every env var it reads, with
 * `secret: true` already curated (used today by `mikan env`'s report). This
 * module is the second consumer of that same authority, not a parallel list
 * that could drift from it.
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { ENV_MANIFEST, readEnv } from "../../env-manifest.js";
import type { MikanHarnessTool } from "../types.js";

/** Values shorter than this are not redacted: too likely to false-positive
 *  on ordinary short strings (e.g. a placeholder, a short flag value). */
const MIN_SECRET_LENGTH = 8;

interface SecretEntry {
  /** `[SECRET:<label>]` placeholder shown in place of the value. */
  label: string;
  value: string;
}

/**
 * Read every `secret: true` env var's current value from the process
 * environment (via `readEnv`, so a `MIKAN_`-prefixed alias counts too).
 * Recomputed per call — cheap, and correctness matters more than caching a
 * snapshot that could go stale relative to `process.env`.
 */
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
  // Longest value first: if one secret's value is a substring of another's
  // (unlikely but not impossible), replace the longer match first so the
  // shorter one does not leave a partial secret behind.
  return entries.toSorted((a, b) => b.value.length - a.value.length);
}

/**
 * Replace every occurrence of a known secret env var's value in `text` with
 * `[SECRET:<VAR_NAME>]`. Safe to call on arbitrary tool output; a no-op when
 * no configured secret value appears in it.
 */
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

/**
 * Wrap a harness tool so every text part of its result passes through
 * {@link redactSecrets} before the model or the session ever sees it. Applied
 * uniformly to every tool at assembly time (`tools/index.ts`) rather than
 * only `bash`: `read` can return a secret file's contents just as easily,
 * and a platform or MCP tool could too.
 *
 * Mutates `tool.execute` in place rather than spreading into a new object.
 * `pi-tools.ts`'s `isHarnessTool` marks a tool with a non-enumerable symbol
 * property (`Object.defineProperty`, default `enumerable: false`), and a
 * platform pack's `bindRun` closure can hold the exact tool object it wired
 * up (`host-fn-tool.ts`'s `setFn`). A `{ ...tool }` spread drops that
 * marker and detaches the copy from the pack's binding — which is exactly
 * what happened here first: every platform/task/subagent tool silently
 * stopped running because the session's `isHarnessTool` check saw an
 * unmarked object and re-adapted an already-harness tool, scrambling its
 * call signature. In-place mutation keeps identity, markers, and bound
 * state intact; only `execute`'s behavior changes.
 */
export function withSecretRedaction(tool: MikanHarnessTool): MikanHarnessTool {
  const original = tool.execute.bind(tool);
  tool.execute = async (...args: Parameters<MikanHarnessTool["execute"]>) => {
    const result = await original(...args);
    const secrets = collectSecretEntries();
    if (secrets.length === 0) return result;
    return {
      ...result,
      content: result.content.map((part): TextContent | ImageContent =>
        part.type === "text" ? { ...part, text: redactSecrets(part.text, secrets) } : part,
      ),
    };
  };
  return tool;
}
