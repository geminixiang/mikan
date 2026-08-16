import type { WebStreamFrame } from "../../src/web/harness/protocol.js";
import { describe, expect, test } from "vitest";
import { initialLiveState, liveReducer, readWorkspaceRoute, workspaceRoute } from "./state.js";

function frame(value: WebStreamFrame) {
  return { type: "frame" as const, frame: value };
}

describe("liveReducer", () => {
  test("clears transient state when the stream generation changes", () => {
    const populated = {
      ...initialLiveState,
      generation: "before",
      queue: [
        {
          requestId: "req_queue",
          clientRequestId: "client_queue",
          mode: "followUp" as const,
          text: "next",
        },
      ],
      run: {
        id: "run_before",
        requestId: "req_before",
        status: "running" as const,
        responseText: "old",
      },
      tools: {
        tool_before: {
          id: "tool_before",
          runId: "run_before",
          name: "read",
          status: "running" as const,
        },
      },
    };

    expect(
      liveReducer(
        populated,
        frame({ type: "stream.ready", generation: "after", workspaceId: "wsp_one" }),
      ),
    ).toMatchObject({
      generation: "after",
      connection: "open",
      run: null,
      queue: [],
      tools: {},
    });
  });

  test("replaces snapshots and ignores stale run events", () => {
    const running = liveReducer(
      initialLiveState,
      frame({
        type: "run.snapshot",
        run: {
          id: "run_current",
          requestId: "req_current",
          status: "running",
          responseText: "Hello",
        },
      }),
    );
    const stale = liveReducer(
      running,
      frame({ type: "response.delta", runId: "run_old", text: " ignored" }),
    );
    expect(stale).toBe(running);

    const staleTool = liveReducer(
      running,
      frame({
        type: "tool.started",
        runId: "run_old",
        tool: {
          id: "tool_old",
          runId: "run_old",
          name: "read",
          status: "running",
        },
      }),
    );
    expect(staleTool).toBe(running);

    const updated = liveReducer(
      running,
      frame({ type: "response.delta", runId: "run_current", text: " world" }),
    );
    expect(updated.run?.responseText).toBe("Hello world");

    const firstQueue = liveReducer(
      updated,
      frame({
        type: "queue.snapshot",
        items: [
          {
            requestId: "req_one",
            clientRequestId: "client_one",
            mode: "followUp",
            text: "one",
          },
        ],
      }),
    );
    const replacedQueue = liveReducer(
      firstQueue,
      frame({
        type: "queue.snapshot",
        items: [
          {
            requestId: "req_two",
            clientRequestId: "client_two",
            mode: "steer",
            text: "two",
          },
        ],
      }),
    );
    expect(replacedQueue.queue.map((item) => item.requestId)).toEqual(["req_two"]);
  });

  test("clears old tools when the authoritative run changes", () => {
    const state = {
      ...initialLiveState,
      run: {
        id: "run_one",
        requestId: "req_one",
        status: "running" as const,
        responseText: "",
      },
      tools: {
        tool_one: {
          id: "tool_one",
          runId: "run_one",
          name: "bash",
          status: "done" as const,
        },
      },
    };
    const next = liveReducer(
      state,
      frame({
        type: "run.snapshot",
        run: {
          id: "run_two",
          requestId: "req_two",
          status: "running",
          responseText: "",
        },
      }),
    );
    expect(next.tools).toEqual({});
  });
});

describe("workspace routes", () => {
  test("round trips opaque workspace ids and rejects separators", () => {
    expect(workspaceRoute("wsp opaque")).toBe("/w/wsp%20opaque");
    expect(readWorkspaceRoute("/w/wsp%20opaque")).toBe("wsp opaque");
    expect(readWorkspaceRoute("/w/a%2Fb")).toBeNull();
    expect(readWorkspaceRoute("/w/a%5Cb")).toBeNull();
    expect(readWorkspaceRoute("/other/wsp")).toBeNull();
  });
});
