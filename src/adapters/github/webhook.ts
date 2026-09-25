import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as log from "../../log.js";
import type { GithubWebhookOptions } from "./types.js";

export const GITHUB_WEBHOOK_PATH = "/github/webhook";

const POKE_EVENTS = new Set(["issues", "issue_comment", "pull_request_review_comment"]);

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function verifyWebhookSignature(
  secret: string,
  body: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received, "utf-8"), Buffer.from(expected, "utf-8"));
}

export async function handleGithubWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: GithubWebhookOptions,
): Promise<boolean> {
  if (url.pathname !== GITHUB_WEBHOOK_PATH) return false;
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return true;
  }
  const body = await readBody(req, MAX_BODY_BYTES);
  if (body === null) {
    res.writeHead(413).end();
    return true;
  }
  const signature = req.headers["x-hub-signature-256"];
  if (
    !verifyWebhookSignature(
      options.secret,
      body,
      typeof signature === "string" ? signature : undefined,
    )
  ) {
    log.logWarning("GitHub webhook: rejected delivery with bad or missing signature");
    res.writeHead(401).end();
    return true;
  }

  const event = req.headers["x-github-event"];
  if (event === "ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  res.writeHead(202).end();
  if (typeof event === "string" && POKE_EVENTS.has(event)) {
    options.onPoke();
  }
  return true;
}
