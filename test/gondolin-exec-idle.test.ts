import { describe, expect, test, vi } from "vitest";
import {
  execOverSessionConnect,
  type SessionClient,
  type SessionClientCallbacks,
} from "../src/sandbox/gondolin-worker-client.js";

function stdoutDataFrame(data: Buffer): Buffer {
  const frame = Buffer.alloc(5 + data.length);
  frame.writeUInt8(1, 0);
  frame.writeUInt32BE(1, 1);
  data.copy(frame, 5);
  return frame;
}

function stdoutFrame(text: string): Buffer {
  return stdoutDataFrame(Buffer.from(text));
}

describe("execOverSessionConnect idle deadline", () => {
  test("a session with no activity at all is killed with an actionable error", async () => {
    // the incident shape: exec dispatched onto a runtime whose workspace sits
    // on a dead NFS mount — no response, no output, no close, ever
    const client: SessionClient = { send: vi.fn(), close: vi.fn() };
    const promise = execOverSessionConnect(() => client, "pwd && ls -la", { idleTimeoutMs: 50 });

    await expect(promise).rejects.toThrow(/no session activity .* workspace health/s);
    expect(client.close).toHaveBeenCalled();
  });

  test("steady output keeps resetting the deadline until completion", async () => {
    let callbacks!: SessionClientCallbacks;
    const client: SessionClient = { send: vi.fn(), close: vi.fn() };
    const promise = execOverSessionConnect(
      (created) => {
        callbacks = created;
        return client;
      },
      "slow-but-alive",
      { idleTimeoutMs: 200 },
    );

    // three ticks of 120ms: total runtime 360ms exceeds the 200ms deadline,
    // but each tick arrives inside it
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      callbacks.onBinary(stdoutFrame(`tick-${i}\n`));
    }
    callbacks.onJson({ type: "exec_response", id: 1, exit_code: 0 });

    await expect(promise).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("tick-2"),
    });
  });

  test("rejects output for an unexpected command id", async () => {
    let callbacks!: SessionClientCallbacks;
    const client: SessionClient = { send: vi.fn(), close: vi.fn() };
    const promise = execOverSessionConnect((created) => {
      callbacks = created;
      return client;
    }, "pwd");
    const frame = stdoutFrame("wrong");
    frame.writeUInt32BE(2, 1);

    callbacks.onBinary(frame);

    await expect(promise).rejects.toThrow("unexpected session output id 2");
    expect(client.close).toHaveBeenCalledOnce();
  });

  test("preserves UTF-8 characters split across output frames", async () => {
    let callbacks!: SessionClientCallbacks;
    const client: SessionClient = { send: vi.fn(), close: vi.fn() };
    const promise = execOverSessionConnect((created) => {
      callbacks = created;
      return client;
    }, "printf 你好");
    const encoded = Buffer.from("你好");

    callbacks.onBinary(stdoutDataFrame(encoded.subarray(0, 2)));
    callbacks.onBinary(stdoutDataFrame(encoded.subarray(2, 4)));
    callbacks.onBinary(stdoutDataFrame(encoded.subarray(4)));
    callbacks.onJson({ type: "exec_response", id: 1, exit_code: 0 });

    await expect(promise).resolves.toMatchObject({ stdout: "你好" });
  });

  test("kills a command before unbounded output can exhaust host memory", async () => {
    let callbacks!: SessionClientCallbacks;
    const client: SessionClient = { send: vi.fn(), close: vi.fn() };
    const promise = execOverSessionConnect(
      (created) => {
        callbacks = created;
        return client;
      },
      "yes",
      { idleTimeoutMs: 0, outputLimitBytes: 5 },
    );

    callbacks.onBinary(stdoutFrame("1234"));
    callbacks.onBinary(stdoutFrame("56"));

    await expect(promise).rejects.toThrow("session output exceeded 5 bytes");
    expect(client.close).toHaveBeenCalledOnce();
  });

  test("idleTimeoutMs: 0 disables the deadline", async () => {
    let callbacks!: SessionClientCallbacks;
    const client: SessionClient = { send: vi.fn(), close: vi.fn() };
    const promise = execOverSessionConnect(
      (created) => {
        callbacks = created;
        return client;
      },
      "unbounded",
      { idleTimeoutMs: 0 },
    );

    await new Promise((resolve) => setTimeout(resolve, 60));
    callbacks.onJson({ type: "exec_response", id: 1, exit_code: 0 });
    await expect(promise).resolves.toMatchObject({ code: 0 });
  });
});
