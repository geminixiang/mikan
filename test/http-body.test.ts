import { type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import { readRawBody } from "../packages/mikan/src/utils/http-body.js";

function makeReq(chunks: string[]): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage;
  // Simulate async chunk delivery after the caller registers listeners
  setImmediate(() => {
    for (const chunk of chunks) {
      emitter.emit("data", Buffer.from(chunk));
    }
    emitter.emit("end");
  });
  return emitter;
}

function makeRes(): {
  res: ServerResponse;
  status: number | null;
  ended: boolean;
  destroyed: boolean;
} {
  const state = { status: null as number | null, ended: false, destroyed: false };
  const res = {
    writeHead(code: number) {
      state.status = code;
    },
    end() {
      state.ended = true;
    },
  } as unknown as ServerResponse;
  return {
    res,
    ...state,
    get status() {
      return state.status;
    },
    get ended() {
      return state.ended;
    },
  };
}

describe("readRawBody", () => {
  test("resolves with concatenated chunks", async () => {
    const req = makeReq(["hel", "lo"]);
    const { res } = makeRes();
    const result = await readRawBody(req, res, 1024);
    expect(result).toBe("hello");
  });

  test("resolves with empty string for empty body", async () => {
    const req = makeReq([]);
    const { res } = makeRes();
    const result = await readRawBody(req, res, 1024);
    expect(result).toBe("");
  });

  test("returns null and sends 413 when body exceeds maxBytes", async () => {
    const req = makeReq(["a".repeat(100)]) as IncomingMessage & { destroy(): void };
    let destroyed = false;
    req.destroy = () => {
      destroyed = true;
    };

    const state = { status: null as number | null, ended: false };
    const res = {
      writeHead(code: number) {
        state.status = code;
      },
      end() {
        state.ended = true;
      },
    } as unknown as ServerResponse;

    const result = await readRawBody(req, res, 50);

    expect(result).toBeNull();
    expect(state.status).toBe(413);
    expect(state.ended).toBe(true);
    expect(destroyed).toBe(true);
  });

  test("resolves on 'error' event without throwing", async () => {
    const emitter = new EventEmitter() as IncomingMessage;
    setImmediate(() => {
      emitter.emit("data", Buffer.from("partial"));
      emitter.emit("error", new Error("socket hang up"));
    });
    const { res } = makeRes();
    const result = await readRawBody(emitter, res, 1024);
    expect(result).toBe("partial");
  });
});
