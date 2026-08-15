import { afterEach, describe, expect, test, vi } from "vitest";
import { HttpHarnessHostPort } from "../../packages/web-client/src/transport.js";

const command = {
  kind: "create-conversation" as const,
  commandId: "retry-safe-command",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HttpHarnessHostPort", () => {
  test("retries a command once after a transport failure with the same command id", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "conversation-created",
            conversation: {
              officeKey: "office",
              title: "New conversation",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              sessionId: "session",
              model: { provider: "test", model: "model", thinkingLevel: "off" },
              transcript: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(new HttpHarnessHostPort().execute(command)).resolves.toMatchObject({
      kind: "conversation-created",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => init?.body)).toEqual([
      JSON.stringify(command),
      JSON.stringify(command),
    ]);
  });

  test("does not retry an authoritative HTTP error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "conflict", message: "Already running" } }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(new HttpHarnessHostPort().execute(command)).rejects.toMatchObject({
      status: 409,
      message: "Already running",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
