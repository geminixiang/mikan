import type { McpServerConfig } from "./types.js";

/** Server names become tool-name segments (`mcp__<server>__<tool>`); keep them
 *  to a safe charset so a settings typo cannot produce an unparseable or
 *  provider-rejected tool name. Shared by the loader and the portal. */
const SERVER_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export function isValidMcpServerName(name: string): boolean {
  return SERVER_NAME_RE.test(name);
}

export type StandardMcpParseResult =
  | { servers: Record<string, McpServerConfig>; error?: undefined }
  | { servers?: undefined; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept the `mcpServers` JSON every MCP server's setup page hands out
 * (`{ "mcpServers": { name: entry } }`, or the bare `{ name: entry }` map).
 * Entries are stored as pasted — `command`/`args`/`env` or `url`/`headers`,
 * values untouched — and the official SDK client does the rest at connect
 * time. mikan only keeps the config and its enabled state per scope.
 */
export function parseStandardMcpServers(text: string): StandardMcpParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isRecord(parsed)) return { error: "expected a JSON object at the top level" };
  const map = "mcpServers" in parsed ? parsed.mcpServers : parsed;
  if (!isRecord(map)) return { error: '"mcpServers" must be an object keyed by server name' };
  if (Object.keys(map).length === 0) return { error: "no servers found in the pasted JSON" };
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(map)) {
    if (!isValidMcpServerName(name)) {
      return {
        error: `invalid server name "${name}" (letters, digits, '_' or '-', starting with a letter)`,
      };
    }
    if (!isRecord(entry)) return { error: `"${name}" must be an object` };
    const hasCommand = typeof entry.command === "string" && entry.command.trim() !== "";
    const hasUrl = typeof entry.url === "string";
    // A broken url is named before the transport count, so a paste carrying
    // both keys and a bad URL reports the URL rather than the ambiguity.
    if (hasUrl && !URL.canParse(entry.url as string)) {
      return { error: `"${name}": url is not a valid URL` };
    }
    // Exactly one transport: equal flags mean both were set, or neither was.
    if (hasCommand === hasUrl) {
      const detail = hasCommand
        ? "set only one of command / url"
        : "set either command (stdio) or url (HTTP)";
      return { error: `"${name}": ${detail}` };
    }
    servers[name] = {
      ...(hasCommand ? { command: entry.command as string } : {}),
      ...(Array.isArray(entry.args) ? { args: entry.args.map(String) } : {}),
      ...(isRecord(entry.env) ? { env: stringValues(entry.env) } : {}),
      ...(hasUrl ? { url: entry.url as string } : {}),
      ...(isRecord(entry.headers) ? { headers: stringValues(entry.headers) } : {}),
      ...(entry.disabled === true ? { disabled: true } : {}),
    };
  }
  return { servers };
}

function stringValues(map: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, String(v)]));
}

/**
 * Hide query-string values: `?token=…` is a legitimate MCP auth channel
 * (browserless, Claude.ai connectors), so a URL is a credential carrier and
 * must never be echoed to a browser or a log line verbatim.
 */
export function redactMcpUrl(url: string): string {
  if (!URL.canParse(url)) return url.replace(/([?&][^=&]+=)[^&]*/g, "$1<redacted>");
  const parsed = new URL(url);
  if (!parsed.search) return url;
  const keys = new Set(parsed.searchParams.keys());
  for (const key of keys) parsed.searchParams.set(key, "<redacted>");
  return parsed.toString().replace(/%3Credacted%3E/g, "<redacted>");
}
