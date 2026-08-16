import { describe, expect, test } from "vitest";
import { WebEventHub } from "../web/harness/hub.js";
import type { WebStreamFrame } from "../web/harness/protocol.js";

describe("WebEventHub", () => {
  test("captures an initial snapshot and buffers live frames through bootstrap", () => {
    const hub = new WebEventHub();
    hub.publish("workspace-1", {
      type: "queue.snapshot",
      items: [
        {
          requestId: "queued-request",
          clientRequestId: "queued-client",
          mode: "followUp",
          text: "Later",
        },
      ],
    });

    const sent: WebStreamFrame[] = [];
    const subscription = hub.subscribe("workspace-1", (frame) => sent.push(frame));
    hub.publish("workspace-1", {
      type: "run.snapshot",
      run: {
        id: "run-1",
        requestId: "request-1",
        status: "running",
        responseText: "",
      },
    });

    expect(subscription.initial.queue).toHaveLength(1);
    expect(subscription.initial.run).toBeNull();
    expect(sent).toEqual([]);

    subscription.flush([
      {
        type: "stream.ready",
        generation: hub.generation,
        workspaceId: "workspace-1",
      },
      { type: "run.snapshot", run: subscription.initial.run },
    ]);

    expect(sent.map((frame) => frame.type)).toEqual([
      "stream.ready",
      "run.snapshot",
      "run.snapshot",
    ]);
    expect(sent.at(-1)).toMatchObject({
      type: "run.snapshot",
      run: { id: "run-1" },
    });
  });
});
