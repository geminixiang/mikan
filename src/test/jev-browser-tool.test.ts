import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({ execFile: (...args: unknown[]) => execFileMock(...args) }));

const {
  buildQuestionPlan,
  categorizeRefs,
  createJevBrowserTool,
  describeContinuity,
  resolveTarget,
  truncate,
} = await import("../harness/tools/jev-browser.js");

/** Adapts `execFileMock`'s node-style callback to `promisify(execFile)`'s call shape. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockAgentBrowser(
  responses: Array<{ success: boolean; data?: unknown; error?: string | null }>,
) {
  let call = 0;
  execFileMock.mockImplementation(
    (_bin: string, _args: string[], _opts: unknown, callback: (...cbArgs: unknown[]) => void) => {
      const response = responses[Math.min(call, responses.length - 1)];
      call++;
      callback(null, { stdout: JSON.stringify(response), stderr: "" });
    },
  );
}

describe("categorizeRefs", () => {
  test("buckets refs by role: click accepts everything, type/select are role-filtered", () => {
    const refs = {
      e1: { role: "button", name: "Submit" },
      e2: { role: "textbox", name: "Email" },
      e3: { role: "combobox", name: "Country" },
      e4: { role: "link", name: "Home" },
    };
    const { click, type, select } = categorizeRefs(refs);
    expect(click.map(([id]) => id)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(type.map(([id]) => id)).toEqual(["e2"]);
    expect(select.map(([id]) => id)).toEqual(["e3"]);
  });

  test("caps the number of candidate refs so a huge page cannot blow up the request", () => {
    const refs: Record<string, { role: string; name: string }> = {};
    for (let i = 0; i < 500; i++) refs[`e${i}`] = { role: "button", name: `Button ${i}` };
    const { click } = categorizeRefs(refs);
    expect(click.length).toBeLessThanOrEqual(200);
  });
});

describe("buildQuestionPlan", () => {
  test("always asks the operation question, with DONE/BLOCKED/WAIT always offered", () => {
    const { questions } = buildQuestionPlan({}, false, false);
    const operation = questions.operation;
    expect(operation?.type).toBe("choice");
    expect(operation?.type === "choice" ? Object.keys(operation.criteria) : []).toEqual([
      "WAIT",
      "DONE",
      "BLOCKED",
    ]);
  });

  test("adds a scroll option only when the caller reports it is possible", () => {
    const { questions } = buildQuestionPlan({}, true, true);
    const operation = questions.operation;
    const keys = operation?.type === "choice" ? Object.keys(operation.criteria) : [];
    expect(keys).toContain("SCROLL_DOWN");
    expect(keys).toContain("SCROLL_UP");
  });

  test("a single candidate for an operation resolves directly without a target question", () => {
    const refs = { e1: { role: "button", name: "Submit" } };
    const { questions, singles } = buildQuestionPlan(refs, false, false);
    expect(singles.CLICK).toBe("e1");
    expect(questions.click_target).toBeUndefined();
    expect(
      questions.operation?.type === "choice" ? questions.operation.criteria.CLICK : undefined,
    ).toBeDefined();
  });

  test("two or more candidates for an operation add a target choice question instead", () => {
    const refs = {
      e1: { role: "button", name: "Submit" },
      e2: { role: "button", name: "Cancel" },
    };
    const { questions, singles } = buildQuestionPlan(refs, false, false);
    expect(singles.CLICK).toBeUndefined();
    expect(questions.click_target?.type).toBe("choice");
    const criteria =
      questions.click_target?.type === "choice" ? questions.click_target.criteria : {};
    expect(Object.keys(criteria)).toEqual(["e1", "e2"]);
  });

  test("no click/type/select candidates omit those operations from the criteria", () => {
    const { questions } = buildQuestionPlan({}, false, false);
    const criteria = questions.operation?.type === "choice" ? questions.operation.criteria : {};
    expect(criteria.CLICK).toBeUndefined();
    expect(criteria.TYPE_TEXT).toBeUndefined();
    expect(criteria.SELECT).toBeUndefined();
  });
});

describe("resolveTarget", () => {
  test("returns the single candidate directly when no target question was asked", () => {
    const target = resolveTarget("CLICK", {}, { CLICK: "e1" });
    expect(target).toBe("e1");
  });

  test("reads the ref id from the matching *_target answer", () => {
    const target = resolveTarget("CLICK", { click_target: { choice: "e2" } }, {});
    expect(target).toBe("e2");
  });

  test("returns undefined when neither a single candidate nor a target answer exists", () => {
    expect(resolveTarget("SELECT", {}, {})).toBeUndefined();
  });
});

describe("truncate", () => {
  test("passes short text through unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  test("cuts long text and marks the cut with an ellipsis", () => {
    const result = truncate("x".repeat(20), 5);
    expect(result).toBe("xxxxx…");
  });
});

describe("jev_browser tool", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalFetch = global.fetch;
  const fetchMock = vi.fn();

  beforeEach(() => {
    execFileMock.mockReset();
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env.OPENROUTER_API_KEY = "test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    global.fetch = originalFetch;
  });

  test("reports the last page snapshot even when DONE is reached on the first observation", async () => {
    // Regression: a run that reaches DONE before any action has an empty
    // history, so without lastPageSnapshot the caller gets no page content
    // at all — reproduced live against https://example.com, where the model
    // fell back to an unrelated `bash curl` call to answer the same goal
    // this tool had already seen.
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } }, // open
      {
        success: true,
        data: {
          origin: "https://example.com/",
          refs: {},
          snapshot: '- heading "Example Domain" [ref=e1]\n- link "More information..." [ref=e2]',
        },
      }, // snapshot
      { success: true, data: { closed: true } }, // close
    ]);
    fetchMock.mockResolvedValue(
      jsonResponse({
        model: "typesafe/jev-1.0",
        answers: { operation: { type: "choice", choice: "DONE", probabilities: { DONE: 0.9 } } },
      }),
    );

    const tool = createJevBrowserTool();
    const result = await tool.execute(
      "call-1",
      { label: "test", url: "https://example.com", goal: "Find the page's main heading text." },
      undefined,
    );

    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text) as { status: string; steps: number; lastPageSnapshot: string };
    expect(parsed.status).toBe("done");
    expect(parsed.steps).toBe(0);
    expect(parsed.lastPageSnapshot).toContain("Example Domain");
  });

  test("always closes the agent-browser session, even after a mid-loop failure", async () => {
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } }, // open
      { success: false, error: "boom" }, // snapshot fails
      { success: true, data: { closed: true } }, // close
    ]);

    const tool = createJevBrowserTool();
    const result = await tool.execute(
      "call-1",
      { label: "test", url: "https://example.com", goal: "anything" },
      undefined,
    );

    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text) as { status: string; message: string };
    expect(parsed.status).toBe("blocked");
    expect(parsed.message).toContain("Snapshot failed");
    const closeCall = execFileMock.mock.calls.find((call) =>
      (call[1] as string[]).includes("close"),
    );
    expect(closeCall).toBeDefined();
  });

  test("runs raw commands before the goal loop and reports their own results", async () => {
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" }, error: null }, // open
      { success: true, data: { started: true }, error: null }, // network har start
      {
        success: true,
        data: {
          origin: "https://example.com/",
          refs: {},
          snapshot: '- heading "Example Domain" [ref=e1]',
        },
        error: null,
      }, // snapshot
      { success: true, data: { closed: true }, error: null }, // close
    ]);
    fetchMock.mockResolvedValue(
      jsonResponse({
        model: "typesafe/jev-1.0",
        answers: { operation: { type: "choice", choice: "DONE", probabilities: { DONE: 0.9 } } },
      }),
    );

    const tool = createJevBrowserTool();
    const result = await tool.execute(
      "call-1",
      {
        label: "test",
        url: "https://example.com",
        commands: [["network", "har", "start"]],
        goal: "Find the page's main heading text.",
      },
      undefined,
    );

    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text) as {
      status: string;
      commandResults: Array<{ command: string[]; success: boolean; data: unknown }>;
    };
    expect(parsed.status).toBe("done");
    expect(parsed.commandResults).toEqual([
      { command: ["network", "har", "start"], success: true, data: { started: true }, error: null },
    ]);
    const harCall = execFileMock.mock.calls.find((call) => (call[1] as string[]).includes("har"));
    expect(harCall?.[1]).toEqual([
      "--session",
      expect.any(String),
      "network",
      "har",
      "start",
      "--json",
    ]);
  });

  test("runs commands-only with no goal, and skips the goal loop entirely", async () => {
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" }, error: null }, // open
      { success: true, data: { path: "/tmp/shot.png" }, error: null }, // screenshot
      { success: true, data: { closed: true }, error: null }, // close
    ]);

    const tool = createJevBrowserTool();
    const result = await tool.execute(
      "call-1",
      { label: "test", url: "https://example.com", commands: [["screenshot", "/tmp/shot.png"]] },
      undefined,
    );

    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text) as {
      status: string;
      commandResults: Array<{ data: unknown }>;
    };
    expect(parsed.status).toBe("no-goal");
    expect(parsed.commandResults).toEqual([
      {
        command: ["screenshot", "/tmp/shot.png"],
        success: true,
        data: { path: "/tmp/shot.png" },
        error: null,
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a named session stays open by default — no close flag needed on the calls in between", async () => {
    // Regression: an earlier version required the caller to remember
    // `keepOpen: true` on every single call reusing a session, or the
    // browser silently closed and reopened, discarding any in-progress
    // recording/HAR capture while every individual call still reported
    // success. Naming a session must be enough on its own.
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } }, // open
      { success: true, data: { started: true } }, // record start
    ]);

    const tool = createJevBrowserTool();
    const result = await tool.execute(
      "call-1",
      {
        label: "test",
        url: "https://example.com",
        session: "my-recording",
        commands: [["record", "start", "/tmp/demo.webm"]],
      },
      undefined,
    );

    const parsed = JSON.parse((result.content[0] as { text: string }).text) as { session: string };
    expect(parsed.session).toBe("my-recording");
    const closeCall = execFileMock.mock.calls.find((call) =>
      (call[1] as string[]).includes("close"),
    );
    expect(closeCall).toBeUndefined();

    // A later call reuses the same session and omits url — no "open" this time.
    execFileMock.mockReset();
    mockAgentBrowser([
      { success: true, data: { path: "/tmp/demo.webm", frames: 12 } }, // record stop
      { success: true, data: { closed: true } }, // close
    ]);
    const result2 = await tool.execute(
      "call-2",
      { label: "test", session: "my-recording", commands: [["record", "stop"]], close: true },
      undefined,
    );
    const openCall = execFileMock.mock.calls.find((call) => (call[1] as string[]).includes("open"));
    expect(openCall).toBeUndefined();
    const parsed2 = JSON.parse((result2.content[0] as { text: string }).text) as {
      commandResults: Array<{ data: unknown }>;
    };
    expect(parsed2.commandResults[0]?.data).toEqual({ path: "/tmp/demo.webm", frames: 12 });
    // close: true on the final call does close it.
    const finalCloseCall = execFileMock.mock.calls.find((call) =>
      (call[1] as string[]).includes("close"),
    );
    expect(finalCloseCall).toBeDefined();
  });

  test("a one-off call (no session) still closes automatically, matching the original single-call ergonomics", async () => {
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } }, // open
      { success: true, data: { path: "/tmp/shot.png" } }, // screenshot
    ]);

    const tool = createJevBrowserTool();
    await tool.execute(
      "call-1",
      { label: "test", url: "https://example.com", commands: [["screenshot", "/tmp/shot.png"]] },
      undefined,
    );

    const closeCall = execFileMock.mock.calls.find((call) =>
      (call[1] as string[]).includes("close"),
    );
    expect(closeCall).toBeDefined();
  });

  test("an explicit close: false keeps even a one-off session open", async () => {
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } }, // open
      { success: true, data: { path: "/tmp/shot.png" } }, // screenshot
    ]);

    const tool = createJevBrowserTool();
    await tool.execute(
      "call-1",
      {
        label: "test",
        url: "https://example.com",
        commands: [["screenshot", "/tmp/shot.png"]],
        close: false,
      },
      undefined,
    );

    const closeCall = execFileMock.mock.calls.find((call) =>
      (call[1] as string[]).includes("close"),
    );
    expect(closeCall).toBeUndefined();
  });

  test("reports browserContinuity so a caller can tell the browser was NOT reused, without digging through raw lifecycle fields", async () => {
    mockAgentBrowser([
      {
        success: true,
        data: {
          targetId: "t1",
          lifecycle: { reused: false, relaunchedBrowser: true, launched: true },
        },
      }, // open — a fresh/relaunched browser, not a continuation
      { success: true, data: { started: true, lifecycle: { reused: true } } }, // record start
    ]);

    const tool = createJevBrowserTool();
    const result = await tool.execute(
      "call-1",
      {
        label: "test",
        url: "https://example.com",
        session: "my-recording",
        commands: [["record", "start", "/tmp/demo.webm"]],
      },
      undefined,
    );

    const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
      browserContinuity: string;
    };
    expect(parsed.browserContinuity).toMatch(/NOT continuous/);
  });

  test("reports browserContinuity as continuous when the session actually was reused", async () => {
    mockAgentBrowser([
      { success: true, data: { path: "/tmp/demo.webm", lifecycle: { reused: true } } }, // record stop
    ]);

    const tool = createJevBrowserTool();
    const result = await tool.execute(
      "call-2",
      { label: "test", session: "my-recording", commands: [["record", "stop"]] },
      undefined,
    );

    const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
      browserContinuity: string;
    };
    expect(parsed.browserContinuity).toMatch(/^continuous:/);
  });

  test("rejects a call with neither url nor session", async () => {
    const tool = createJevBrowserTool();
    await expect(
      tool.execute("call-1", { label: "test", goal: "anything" }, undefined),
    ).rejects.toThrow(/Provide url .* or session/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("rejects a call with neither goal nor commands", async () => {
    const tool = createJevBrowserTool();
    await expect(
      tool.execute("call-1", { label: "test", url: "https://example.com" }, undefined),
    ).rejects.toThrow(/Provide goal, commands, or both/);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe("describeContinuity", () => {
  test("reports unknown when no agent-browser command completed", () => {
    expect(describeContinuity(true, undefined)).toMatch(/^unknown:/);
  });

  test("reports one-off for a call with no session name, regardless of lifecycle", () => {
    expect(describeContinuity(false, { reused: false })).toMatch(/^one-off session:/);
  });

  test("reports continuous when a named session's browser was reused", () => {
    expect(describeContinuity(true, { reused: true })).toMatch(/^continuous:/);
  });

  test("reports NOT continuous when a named session's browser was not reused", () => {
    expect(describeContinuity(true, { reused: false })).toMatch(/^NOT continuous:/);
  });
});
