import type { AgentTool } from "@earendil-works/pi-agent-core";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { Type } from "typebox";
import { errorMessage } from "../../unknown-values.js";
import { LABEL_PARAMETER } from "./host-fn-tool.js";
import type {
  WebFetchAddress,
  WebFetchLookup,
  WebFetchRequest,
  WebFetchResponse,
  WebFetchToolOptions,
} from "./types.js";

export const WEB_FETCH_TOOL = "web_fetch";

const WINDOW_CHARS = 12_000;
const FIND_CONTEXT_CHARS = 200;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20_000;
const USER_AGENT = "Mozilla/5.0 (compatible; mikan-web-fetch)";

const webFetchSchema = Type.Object({
  label: LABEL_PARAMETER,
  url: Type.String({ description: "Absolute http or https URL of a public page or API" }),
  offset: Type.Optional(
    Type.Integer({ minimum: 0, description: "Character offset to start reading from" }),
  ),
  find: Type.Optional(
    Type.String({ description: "Start reading just before the first match of this text" }),
  ),
});

function ipv4Kind(address: string): string | undefined {
  const [a = 0, b = 0] = address.split(".").map(Number);
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a === 0 || a === 10 || a >= 224) return "private";
  if ((a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  return undefined;
}

function addressKind(address: string): string | undefined {
  if (isIP(address) === 4) return ipv4Kind(address);
  const lower = address.toLowerCase();
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return ipv4Kind(dotted[1]!);
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1]!, 16);
    const low = parseInt(hex[2]!, 16);
    return ipv4Kind(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  if (lower === "::1") return "loopback";
  if (/^fe[89ab]/.test(lower)) return "link-local";
  if (lower === "::" || /^f[cd]/.test(lower) || lower.startsWith("ff")) return "private";
  return undefined;
}

function assertPublicAddresses(host: string, addresses: readonly WebFetchAddress[]): void {
  if (addresses.length === 0) throw new Error(`web_fetch could not resolve ${host}`);
  for (const { address } of addresses) {
    const kind = addressKind(address);
    if (kind) throw new Error(`web_fetch refuses ${kind} address ${address} for ${host}`);
  }
}

function resolveAll(hostname: string): Promise<WebFetchAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (error, addresses: LookupAddress[]) =>
      error ? reject(error) : resolve(addresses),
    );
  });
}

async function assertPublicUrl(raw: string, lookup: WebFetchLookup): Promise<URL> {
  if (!URL.canParse(raw)) throw new Error(`web_fetch needs an absolute http or https URL: ${raw}`);
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`web_fetch supports only http and https URLs, not ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  assertPublicAddresses(
    host,
    isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host),
  );
  return url;
}

type ConnectLookupCallback = (
  error: Error | null,
  address: string | WebFetchAddress[],
  family?: number,
) => void;

function publicOnlyConnectLookup(
  hostname: string,
  options: { all?: boolean },
  callback: ConnectLookupCallback,
): void {
  resolveAll(hostname).then(
    (addresses) => {
      try {
        assertPublicAddresses(hostname, addresses);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)), "");
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    },
    (error: Error) => callback(error, ""),
  );
}

function createPublicOnlyFetch(): WebFetchRequest {
  const dispatcher = new Agent({ connect: { lookup: publicOnlyConnectLookup } });
  return (url, init) => undiciFetch(url, { ...init, dispatcher });
}

function isTextContentType(contentType: string): boolean {
  if (!contentType) return true;
  return /^text\/|[/+](json|xml|javascript|ecmascript)\b|^application\/x-ndjson/.test(contentType);
}

async function readText(response: WebFetchResponse, contentType: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error(`web_fetch response is larger than ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const charset = contentType.match(/charset=([\w-]+)/i)?.[1] ?? "utf-8";
  const decoder = (() => {
    try {
      return new TextDecoder(charset);
    } catch {
      return new TextDecoder("utf-8");
    }
  })();
  return decoder.decode(Buffer.concat(chunks));
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => {
    if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? match;
    const code =
      entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function htmlToText(html: string, base: string): { title: string; text: string } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "");
  const body =
    html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html;
  const text = body
    .replace(
      /<(script|style|noscript|svg|nav|footer|header|form|iframe|template)\b[\s\S]*?<\/\1>/gi,
      "",
    )
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_, href, inner) => {
        const label = String(inner)
          .replace(/<[^>]+>/g, "")
          .trim();
        const target = decodeEntities(String(href));
        if (!label) return "";
        return URL.canParse(target, base) ? `[${label}](${new URL(target, base).href})` : label;
      },
    )
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<(br|\/p|\/div|\/tr|\/h[1-6]|\/li|\/table|\/section|\/article|\/pre)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return {
    title,
    text: decodeEntities(text)
      .split("\n")
      .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
      .filter(Boolean)
      .join("\n"),
  };
}

function windowOf(text: string, offset: number, find: string | undefined) {
  if (find === undefined) return { start: Math.min(offset, text.length), missing: false };
  const at = text.toLowerCase().indexOf(find.toLowerCase(), offset);
  if (at < 0) return { start: offset, missing: true };
  return { start: Math.max(0, at - FIND_CONTEXT_CHARS), missing: false };
}

async function fetchFollowingRedirects(
  raw: string,
  fetch: WebFetchRequest,
  lookup: WebFetchLookup,
  signal: AbortSignal,
): Promise<{ url: URL; response: WebFetchResponse }> {
  let url = await assertPublicUrl(raw, lookup);
  for (let hop = 0; ; hop++) {
    const response = await fetch(url.href, {
      redirect: "manual",
      signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5",
      },
    }).catch((error: unknown) => {
      const reason = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      throw new Error(`web_fetch failed for ${url.href}: ${errorMessage(reason)}`, {
        cause: error,
      });
    });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return { url, response };
    if (hop >= MAX_REDIRECTS) throw new Error(`web_fetch stopped after ${MAX_REDIRECTS} redirects`);
    url = await assertPublicUrl(new URL(location, url).href, lookup);
  }
}

export function createWebFetchTool(
  options: WebFetchToolOptions = {},
): AgentTool<typeof webFetchSchema> {
  const lookup = options.lookup ?? resolveAll;
  let fetch = options.fetch;
  return {
    name: WEB_FETCH_TOOL,
    label: WEB_FETCH_TOOL,
    description: [
      "Read a public web page or API URL from the mikan host and return its readable text: HTML becomes text with links kept, JSON and plain text are returned raw.",
      "Use it to verify current facts such as versions, releases, and dates against the official page, registry, or API, and cite the URL.",
      `Long content comes in ${WINDOW_CHARS}-character windows; the result tells you the offset to continue from, and find jumps to a keyword.`,
      "Private, loopback, and link-local addresses are refused.",
    ].join(" "),
    parameters: webFetchSchema,
    execute: async (_toolCallId, args, signal) => {
      fetch ??= createPublicOnlyFetch();
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const { url, response } = await fetchFollowingRedirects(
        args.url,
        fetch,
        lookup,
        signal ? AbortSignal.any([signal, timeout]) : timeout,
      );
      if (!response.ok) throw new Error(`web_fetch got HTTP ${response.status} for ${url.href}`);
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!isTextContentType(contentType)) {
        await response.body?.cancel();
        throw new Error(`Unsupported content type ${contentType.split(";")[0]} for ${url.href}`);
      }
      const raw = await readText(response, contentType);
      const { title, text } = contentType.includes("html")
        ? htmlToText(raw, url.href)
        : { title: "", text: raw };
      const { start, missing } = windowOf(text, args.offset ?? 0, args.find);
      const end = Math.min(text.length, start + WINDOW_CHARS);
      const header = [
        `URL: ${url.href}`,
        title ? `Title: ${title}` : "",
        `Fetched: ${new Date().toISOString()}`,
      ];
      if (missing) {
        header.push(`"${args.find}" was not found after character ${start} of ${text.length}.`);
      } else if (text.length > WINDOW_CHARS || start > 0) {
        const more =
          end < text.length
            ? ` Call again with offset=${end} to continue, or pass find to jump to a keyword.`
            : "";
        header.push(`Showing characters ${start}-${end} of ${text.length}.${more}`);
      }
      const content = missing ? "" : `\n\n${text.slice(start, end)}`;
      return {
        content: [
          { type: "text" as const, text: `${header.filter(Boolean).join("\n")}${content}` },
        ],
        details: undefined,
      };
    },
  };
}
