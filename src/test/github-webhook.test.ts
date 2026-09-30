import { createHmac } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, test, vi } from "vitest";
import {
  createGithubWebhookHandler,
  GITHUB_WEBHOOK_PATH,
  verifyWebhookSignature,
} from "../adapters/github/webhook.js";

const SECRET = "hush";

function sign(body: string | Buffer, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

interface FakeResponse {
  res: ServerResponse;
  status: () => number | undefined;
  ended: () => boolean;
}

function makeRes(req: IncomingMessage): FakeResponse {
  const res = new ServerResponse(req);
  return {
    res,
    status: () => (res.headersSent ? res.statusCode : undefined),
    ended: () => res.writableEnded,
  };
}

function makeReq(options: {
  method?: string;
  body?: string | Buffer;
  signature?: string;
  event?: string;
  delivery?: string;
}): { req: IncomingMessage; url: URL } {
  const req = new IncomingMessage(new Socket());
  req.method = options.method ?? "POST";
  if (options.signature) req.headers["x-hub-signature-256"] = options.signature;
  if (options.event) req.headers["x-github-event"] = options.event;
  if (options.delivery) req.headers["x-github-delivery"] = options.delivery;
  req.push(Buffer.from(options.body ?? "{}"));
  req.push(null);
  return { req, url: new URL(`http://localhost${GITHUB_WEBHOOK_PATH}`) };
}

describe("verifyWebhookSignature", () => {
  test("accepts a valid signature", () => {
    const body = Buffer.from('{"zen":"ok"}');
    expect(verifyWebhookSignature(SECRET, body, sign(body))).toBe(true);
  });

  test("rejects a wrong secret", () => {
    const body = Buffer.from("{}");
    expect(verifyWebhookSignature(SECRET, body, sign(body, "other"))).toBe(false);
  });

  test("rejects missing, unprefixed, and length-mismatched signatures", () => {
    const body = Buffer.from("{}");
    expect(verifyWebhookSignature(SECRET, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(SECRET, body, "deadbeef")).toBe(false);
    expect(verifyWebhookSignature(SECRET, body, "sha256=abc")).toBe(false);
  });
});

describe("GitHub webhook handler", () => {
  function setup() {
    const onDelivery = vi.fn();
    const handle = createGithubWebhookHandler({ secret: SECRET, onDelivery });
    async function post(options: Parameters<typeof makeReq>[0], url?: URL) {
      const made = makeReq(options);
      const out = makeRes(made.req);
      const handled = await handle(made.req, out.res, url ?? made.url);
      return { handled, out };
    }
    return { onDelivery, post };
  }

  function signed(event: string, payload: unknown = { action: "created" }, delivery?: string) {
    const body = JSON.stringify(payload);
    return { body, signature: sign(body), event, delivery };
  }

  test("ignores other paths", async () => {
    const { post } = setup();
    const { handled, out } = await post({}, new URL("http://localhost/health"));
    expect(handled).toBe(false);
    expect(out.ended()).toBe(false);
  });

  test("rejects non-POST with 405", async () => {
    const { post } = setup();
    const { handled, out } = await post({ method: "GET" });
    expect(handled).toBe(true);
    expect(out.status()).toBe(405);
  });

  test("rejects a bad signature with 401 and forwards nothing", async () => {
    const { post, onDelivery } = setup();
    const { out } = await post({
      body: "{}",
      signature: sign("{}", "wrong"),
      event: "issue_comment",
    });
    expect(out.status()).toBe(401);
    expect(onDelivery).not.toHaveBeenCalled();
  });

  test("rejects oversized bodies with 413", async () => {
    const { post, onDelivery } = setup();
    const big = Buffer.alloc(1024 * 1024 + 1, 0x61);
    const { out } = await post({ body: big, signature: sign(big), event: "issue_comment" });
    expect(out.status()).toBe(413);
    expect(onDelivery).not.toHaveBeenCalled();
  });

  test("answers ping with 200 without forwarding", async () => {
    const { post, onDelivery } = setup();
    const { out } = await post(signed("ping"));
    expect(out.status()).toBe(200);
    expect(onDelivery).not.toHaveBeenCalled();
  });

  test("forwards activity events with their parsed payload after answering 202", async () => {
    for (const event of [
      "issues",
      "issue_comment",
      "pull_request",
      "pull_request_review_comment",
    ]) {
      const { post, onDelivery } = setup();
      const { out } = await post(signed(event, { action: "opened" }));
      expect(out.status()).toBe(202);
      expect(onDelivery).toHaveBeenCalledWith({ event, payload: { action: "opened" } });
    }
  });

  test("accepts but ignores other events and malformed bodies", async () => {
    const { post, onDelivery } = setup();
    expect((await post(signed("push"))).out.status()).toBe(202);
    const { out } = await post({ body: "not json", signature: sign("not json"), event: "issues" });
    expect(out.status()).toBe(202);
    expect(onDelivery).not.toHaveBeenCalled();
  });

  test("a redelivered GUID is acknowledged but forwarded only once", async () => {
    const { post, onDelivery } = setup();
    await post(signed("issue_comment", { action: "created" }, "guid-1"));
    const { out } = await post(signed("issue_comment", { action: "created" }, "guid-1"));
    await post(signed("issue_comment", { action: "created" }, "guid-2"));
    expect(out.status()).toBe(202);
    expect(onDelivery).toHaveBeenCalledTimes(2);
  });
});
