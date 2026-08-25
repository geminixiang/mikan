import type {
  HarnessBootstrap,
  HarnessCommand,
  HarnessCommandResult,
  HarnessEventEnvelope,
} from "@geminixiang/mikan-harness-web-contract";
import { describe, expect, test, vi } from "vitest";
import { HarnessClient } from "../../packages/web-client/src/client.js";
import type {
  HarnessConnectionStatus,
  HarnessHostPort,
} from "../../packages/web-client/src/types.js";

describe("HarnessClient", () => {
  test("folds ordered run events into one browser projection", async () => {
    const fixture = createPort();
    const client = new HarnessClient(fixture.port);
    await client.open("office-1");
    expect(client.getSnapshot()).toMatchObject({ status: "ready", connection: "connected" });

    await client.prompt("Hello");
    const prompt = fixture.commands.find((command) => command.kind === "prompt");
    if (!prompt || prompt.kind !== "prompt") throw new Error("Prompt was not sent");
    expect(client.getSnapshot().conversation?.transcript.at(-1)).toMatchObject({
      id: prompt.commandId,
      role: "user",
      text: "Hello",
    });

    fixture.emit(
      envelope(1, {
        kind: "run.started",
        officeKey: "office-1",
        sessionId: "session-1",
        run: { id: "run-1", status: "running", startedAt: new Date().toISOString() },
        userItem: {
          id: prompt.commandId,
          role: "user",
          title: "You",
          text: "Hello",
          timestamp: new Date().toISOString(),
        },
      }),
    );
    fixture.emit(
      envelope(2, {
        kind: "response.delta",
        officeKey: "office-1",
        sessionId: "session-1",
        runId: "run-1",
        delta: "Hi",
      }),
    );
    fixture.emit(
      envelope(3, {
        kind: "response.delta",
        officeKey: "office-1",
        sessionId: "session-1",
        runId: "run-1",
        delta: " there",
      }),
    );

    expect(client.getSnapshot().conversation).toMatchObject({
      run: { id: "run-1", status: "running" },
      transcript: expect.arrayContaining([
        expect.objectContaining({ id: "live-run-1", role: "assistant", text: "Hi there" }),
      ]),
    });
    client.dispose();
  });

  test("does not resurrect a run that settles before cancel acknowledgement", async () => {
    const fixture = createPort();
    const client = new HarnessClient(fixture.port);
    await client.open("office-1");
    fixture.emit(
      envelope(1, {
        kind: "run.started",
        officeKey: "office-1",
        sessionId: "session-1",
        run: { id: "run-1", status: "running", startedAt: new Date().toISOString() },
        userItem: {
          id: "user-1",
          role: "user",
          title: "You",
          text: "Hello",
          timestamp: new Date().toISOString(),
        },
      }),
    );
    fixture.settleDuringCancel();

    await client.cancel();
    await vi.waitFor(() => expect(client.getSnapshot().conversation?.run).toBeUndefined());
    client.dispose();
  });

  test("resnapshots when the ordered event sequence has a gap", async () => {
    const fixture = createPort();
    const client = new HarnessClient(fixture.port);
    await client.open("office-1");
    fixture.emit(
      envelope(2, {
        kind: "diagnostic",
        officeKey: "office-1",
        sessionId: "session-1",
        runId: "run-1",
        text: "gap",
        tone: "muted",
      }),
    );

    await vi.waitFor(() => expect(fixture.bootstrap).toHaveBeenCalledTimes(2));
    client.dispose();
  });
});

function createPort() {
  const commands: HarnessCommand[] = [];
  let onEvent: ((event: HarnessEventEnvelope) => void) | undefined;
  let settleDuringCancel = false;
  const bootstrap = vi.fn().mockResolvedValue(bootstrapFixture());
  const port: HarnessHostPort = {
    bootstrap,
    async execute(command): Promise<HarnessCommandResult> {
      commands.push(command);
      if (command.kind === "prompt") return { kind: "prompt-accepted", runId: "run-1" };
      if (command.kind === "cancel-run") {
        if (settleDuringCancel) {
          onEvent?.(
            envelope(2, {
              kind: "run.finished",
              officeKey: command.officeKey,
              sessionId: command.sessionId,
              runId: command.runId,
              outcome: "cancelled",
            }),
          );
        }
        return { kind: "run-cancelled", runId: command.runId };
      }
      throw new Error(`Unexpected command: ${command.kind}`);
    },
    subscribe(
      _cursor,
      eventListener,
      _onReset,
      onConnection: (status: HarnessConnectionStatus) => void,
    ) {
      onEvent = eventListener;
      onConnection("connected");
      return () => {};
    },
    async logout() {},
  };
  return {
    port,
    commands,
    bootstrap,
    emit(event: HarnessEventEnvelope) {
      onEvent?.(event);
    },
    settleDuringCancel() {
      settleDuringCancel = true;
    },
  };
}

function bootstrapFixture(): HarnessBootstrap {
  const conversation = {
    officeKey: "office-1",
    title: "Conversation",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sessionId: "session-1",
    model: { provider: "test", model: "model", thinkingLevel: "off" as const },
    transcript: [],
  };
  return {
    principal: { id: "github:1", displayName: "octo" },
    conversations: [conversation],
    conversation,
    models: [],
    cursor: { epoch: "epoch", sequence: 0 },
  };
}

function envelope(sequence: number, event: HarnessEventEnvelope["event"]): HarnessEventEnvelope {
  return { cursor: { epoch: "epoch", sequence }, event };
}
