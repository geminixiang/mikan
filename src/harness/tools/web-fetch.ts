import { lookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { htmlToMarkdown } from "@mdream/js";
import { withMinimalPreset } from "@mdream/js/preset/minimal";
import { Agent, buildConnector, fetch } from "undici";
import { Type } from "typebox";
import { guardMcpToolResult } from "../mcp-result.js";
import { errorMessage, isRecord } from "../../unknown-values.js";
import { LABEL_PARAMETER } from "./host-fn-tool.js";
import { tagHarnessTool, type MikanHarnessTool } from "./pi-tools.js";
import type { WebFetchToolOptions } from "./types.js";

export const WEB_FETCH_TOOL = "web_fetch";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const USER_AGENT = "Mozilla/5.0 (compatible; mikan-web-fetch)";
const TEXT_CONTENT_TYPE = /^text\/|[/+](json|xml|javascript)\b/;

function nonPublicAddresses(): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["224.0.0.0", 3],
  ] as const) {
    list.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of [
    ["::", 127],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const) {
    list.addSubnet(network, prefix, "ipv6");
  }
  return list;
}

const NON_PUBLIC = nonPublicAddresses();

export function isNonPublicAddress(address: string): boolean {
  return isBlocked(NON_PUBLIC, address);
}

function isBlocked(blocked: BlockList, address: string): boolean {
  const family = isIP(address);
  return family === 0 || blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

function refusal(address: string, host: string): Error {
  return new Error(`web_fetch refuses non-public address ${address} for ${host}`);
}

function publicOnlyLookup(blocked: BlockList): LookupFunction {
  return (hostname, options, callback) =>
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, "", 0);
      const refused = addresses.find(({ address }) => isBlocked(blocked, address));
      if (refused) return callback(refusal(refused.address, hostname), "", 0);
      if (options.all) return callback(null, addresses);
      return callback(null, addresses[0]!.address, addresses[0]!.family);
    });
}

function publicOnlyDispatcher(blocked: BlockList): Agent {
  const connect = buildConnector({ lookup: publicOnlyLookup(blocked) });
  return new Agent({
    maxResponseSize: MAX_RESPONSE_BYTES,
    connect: (options, callback) => {
      const host = options.hostname.replace(/^\[|\]$/g, "");
      if (isIP(host) && isBlocked(blocked, host)) return callback(refusal(host, host), null);
      return connect(options, callback);
    },
  });
}

const webFetchSchema = Type.Object({
  label: LABEL_PARAMETER,
  url: Type.String({ description: "Absolute http or https URL of a public page or API" }),
});

function requestedUrl(args: unknown): URL {
  const raw = isRecord(args) && typeof args.url === "string" ? args.url : "";
  if (!URL.canParse(raw)) throw new Error(`web_fetch needs an absolute http or https URL: ${raw}`);
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`web_fetch supports only http and https URLs, not ${url.protocol}`);
  }
  return url;
}

export function createWebFetchTool(options: WebFetchToolOptions = {}): MikanHarnessTool {
  let dispatcher: Agent | undefined;
  return tagHarnessTool({
    name: WEB_FETCH_TOOL,
    description: [
      "Read a public web page or API URL from the mikan host. HTML is returned as Markdown with navigation and other page chrome removed; JSON and plain text are returned as they are.",
      "Use it to verify current facts such as versions, releases, and dates against the official page, registry, or API, and cite the URL.",
      "Private, loopback, and link-local addresses are refused.",
    ].join(" "),
    parameters: webFetchSchema,
    execute: async (args, api, context) => {
      const url = requestedUrl(args);
      dispatcher ??= publicOnlyDispatcher(options.blocked ?? NON_PUBLIC);
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const response = await fetch(url, {
        dispatcher,
        signal: context.abortSignal ? AbortSignal.any([context.abortSignal, timeout]) : timeout,
        headers: { "user-agent": USER_AGENT },
      }).catch((error: unknown) => {
        const reason = error instanceof Error && error.cause instanceof Error ? error.cause : error;
        throw new Error(`web_fetch failed for ${url.href}: ${errorMessage(reason)}`, {
          cause: error,
        });
      });
      const finalUrl = response.url || url.href;
      if (!response.ok) throw new Error(`web_fetch got HTTP ${response.status} for ${finalUrl}`);
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (contentType && !TEXT_CONTENT_TYPE.test(contentType)) {
        await response.body?.cancel();
        throw new Error(`Unsupported content type ${contentType.split(";")[0]} for ${finalUrl}`);
      }
      const body = await response.text();
      const text = contentType.includes("html")
        ? htmlToMarkdown(body, withMinimalPreset({ origin: new URL(finalUrl).origin }))
        : body;
      return guardMcpToolResult(
        {
          content: [
            {
              type: "text",
              text: finalUrl === url.href ? text : `Redirected to ${finalUrl}\n\n${text}`,
            },
          ],
        },
        api.env,
        context,
      );
    },
  });
}
