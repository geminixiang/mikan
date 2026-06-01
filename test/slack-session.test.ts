import { describe, expect, test } from "vitest";
import {
  formatSlackSessionKey,
  parseSlackSessionKey,
  planSlackAdapterSession,
  planSlackEventAnchorRun,
  resolveSlackResponseRootTs,
} from "../src/adapters/slack/session.js";

describe("Slack session planning", () => {
  test("top-level user turns use the persistent channel session", () => {
    expect(
      planSlackAdapterSession({
        conversationId: "C123",
        ts: "1000.0001",
      }),
    ).toMatchObject({
      sessionKey: "C123",
      rootTs: "1000.0001",
      isThreaded: false,
    });
  });

  test("thread turns use the thread root as the thread session key", () => {
    expect(
      planSlackAdapterSession({
        conversationId: "C123",
        ts: "1000.0002",
        thread_ts: "1000.0001",
      }),
    ).toMatchObject({
      sessionKey: "C123:1000.0001",
      rootTs: "1000.0001",
      isThreaded: true,
    });
  });

  test("anchored events use the anchor session", () => {
    expect(
      planSlackAdapterSession(
        {
          conversationId: "C123",
          ts: "event:deploy-reminder",
          sessionKey: "C123:2000.0001",
        },
        { initialMessageTs: "2000.0001" },
      ),
    ).toMatchObject({
      sessionKey: "C123:2000.0001",
      rootTs: "2000.0001",
      initialMessageTs: "2000.0001",
    });
  });

  test("session refs make channel and thread keys explicit", () => {
    expect(parseSlackSessionKey("C123")).toEqual({ kind: "channel", channelId: "C123" });
    expect(parseSlackSessionKey("C123:2000.0001")).toEqual({
      kind: "thread",
      channelId: "C123",
      threadTs: "2000.0001",
    });
    expect(
      formatSlackSessionKey({ kind: "thread", channelId: "C123", threadTs: "2000.0001" }),
    ).toBe("C123:2000.0001");
  });

  test("event anchor planning binds top-level events to the Slack anchor", () => {
    const planned = planSlackEventAnchorRun(
      {
        conversationId: "C123",
        ts: "event:deploy-reminder",
      },
      "2000.0001",
    );

    expect(planned.initialMessageTs).toBe("2000.0001");
    expect(planned.event.sessionKey).toBe("C123:2000.0001");
  });

  test("event anchor planning leaves explicit thread events alone", () => {
    const event = {
      conversationId: "C123",
      ts: "event:deploy-reminder",
      thread_ts: "1000.0001",
    };

    expect(planSlackEventAnchorRun(event, "2000.0001")).toEqual({ event });
  });

  test("non-Slack timestamps do not produce response roots", () => {
    expect(resolveSlackResponseRootTs({ ts: "event:deploy-reminder" })).toBeUndefined();
  });
});
