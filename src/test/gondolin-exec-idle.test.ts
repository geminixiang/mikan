import { describe, expect, test, vi } from "vitest";
import {
  execOverSessionConnect,
  type SessionClient,
  type SessionClientCallbacks,
} from "../sandbox/gondolin.js";

function stdoutFrame(text: string): Buffer {
  const data = Buffer.from(text);
  const frame = Buffer.alloc(5 + data.length);
  frame.writeUInt8(1, 0);
  data.copy(frame, 5);
  return frame;
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
