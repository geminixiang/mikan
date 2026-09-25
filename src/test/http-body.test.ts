import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, test } from "vitest";
import { readRawBody } from "../adapters/web/portal-shell.js";

function makeReq(chunks: string[]): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  setImmediate(() => {
    for (const chunk of chunks) {
      req.push(Buffer.from(chunk));
    }
    req.push(null);
  });
  return req;
}

function makeRes(req: IncomingMessage): ServerResponse {
  return new ServerResponse(req);
}

describe("readRawBody", () => {
  test("resolves with concatenated chunks", async () => {
    const req = makeReq(["hel", "lo"]);
    const result = await readRawBody(req, makeRes(req), 1024);
    expect(result).toBe("hello");
  });

  test("resolves with empty string for empty body", async () => {
    const req = makeReq([]);
    const result = await readRawBody(req, makeRes(req), 1024);
    expect(result).toBe("");
  });

  test("returns null and sends 413 when body exceeds maxBytes", async () => {
    const req = makeReq(["a".repeat(100)]);
    const res = makeRes(req);

    const result = await readRawBody(req, res, 50);

    expect(result).toBeNull();
    expect(res.statusCode).toBe(413);
    expect(res.headersSent).toBe(true);
    expect(res.writableEnded).toBe(true);
    expect(req.destroyed).toBe(true);
  });

  test("resolves on 'error' event without throwing", async () => {
    const req = new IncomingMessage(new Socket());
    setImmediate(() => {
      req.push(Buffer.from("partial"));
      setImmediate(() => req.destroy(new Error("socket hang up")));
    });
    const result = await readRawBody(req, makeRes(req), 1024);
    expect(result).toBe("partial");
  });
});
