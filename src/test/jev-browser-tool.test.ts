import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Executor } from "../sandbox/types.js";

const execMock = vi.fn<Executor["exec"]>();
const executor: Executor = {
  exec: execMock,
  getSandboxConfig: () => ({ type: "container", container: "browser-test" }),
  readFile: vi.fn(),
  readFileBase64: vi.fn(),
  writeFile: vi.fn(),
  getWorkspacePath: vi.fn(),
  getPathContext: vi.fn(),
};

const {
  buildQuestionPlan,
  categorizeRefs,
  createJevBrowserTool,
  describeContinuity,
  resolveTarget,
  truncate,
} = await import("../harness/tools/jev-browser.js");

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
  execMock.mockImplementation(async () => {
    const response = responses[Math.min(call, responses.length - 1)];
    call++;
    return { stdout: JSON.stringify(response), stderr: "", code: 0 };
  });
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
    execMock.mockReset();
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

    const tool = createJevBrowserTool(executor);
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

    const tool = createJevBrowserTool(executor);
    const result = await tool.execute(
      "call-1",
      { label: "test", url: "https://example.com", goal: "anything" },
      undefined,
    );

    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text) as { status: string; message: string };
    expect(parsed.status).toBe("blocked");
    expect(parsed.message).toContain("Snapshot failed");
    const closeCall = execMock.mock.calls.find((call) => call[0].includes("'close'"));
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

    const tool = createJevBrowserTool(executor);
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
    const harCall = execMock.mock.calls.find((call) => call[0].includes("'har'"));
    expect(harCall).toEqual([
      expect.stringMatching(
        /^'agent-browser' '--session' 'mikan-jb-[^']+' 'network' 'har' 'start' '--json'$/,
      ),
      { timeout: 90, signal: undefined },
    ]);
  });

  test("runs commands-only with no goal, and skips the goal loop entirely", async () => {
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" }, error: null }, // open
      { success: true, data: { path: "/tmp/shot.png" }, error: null }, // screenshot
      { success: true, data: { closed: true }, error: null }, // close
    ]);

    const tool = createJevBrowserTool(executor);
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

    const tool = createJevBrowserTool(executor);
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
    const closeCall = execMock.mock.calls.find((call) => call[0].includes("'close'"));
    expect(closeCall).toBeUndefined();

    // A later call reuses the same session and omits url — no "open" this time.
    execMock.mockReset();
    mockAgentBrowser([
      { success: true, data: { path: "/tmp/demo.webm", frames: 12 } }, // record stop
      { success: true, data: { closed: true } }, // close
    ]);
    const result2 = await tool.execute(
      "call-2",
      { label: "test", session: "my-recording", commands: [["record", "stop"]], close: true },
      undefined,
    );
    const openCall = execMock.mock.calls.find((call) => call[0].includes("'open'"));
    expect(openCall).toBeUndefined();
    const parsed2 = JSON.parse((result2.content[0] as { text: string }).text) as {
      commandResults: Array<{ data: unknown }>;
    };
    expect(parsed2.commandResults[0]?.data).toEqual({ path: "/tmp/demo.webm", frames: 12 });
    // close: true on the final call does close it.
    const finalCloseCall = execMock.mock.calls.find((call) => call[0].includes("'close'"));
    expect(finalCloseCall).toBeDefined();
  });

  test("a one-off call (no session) still closes automatically, matching the original single-call ergonomics", async () => {
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } }, // open
      { success: true, data: { path: "/tmp/shot.png" } }, // screenshot
    ]);

    const tool = createJevBrowserTool(executor);
    await tool.execute(
      "call-1",
      { label: "test", url: "https://example.com", commands: [["screenshot", "/tmp/shot.png"]] },
      undefined,
    );

    const closeCall = execMock.mock.calls.find((call) => call[0].includes("'close'"));
    expect(closeCall).toBeDefined();
  });

  test("an explicit close: false keeps even a one-off session open", async () => {
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } }, // open
      { success: true, data: { path: "/tmp/shot.png" } }, // screenshot
    ]);

    const tool = createJevBrowserTool(executor);
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

    const closeCall = execMock.mock.calls.find((call) => call[0].includes("'close'"));
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

    const tool = createJevBrowserTool(executor);
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

    const tool = createJevBrowserTool(executor);
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

  test("quotes session, URL, and eval argv literally, including shell substitutions", async () => {
    mockAgentBrowser([{ success: true, data: null, error: null }]);
    const signal = new AbortController().signal;
    await createJevBrowserTool(executor).execute(
      "quoting",
      {
        label: "test",
        session: "user's $(echo session); `echo name`",
        url: "https://example.com/a'b?q=$(echo url)&x=`echo query`",
        commands: [
          ["eval", "document.title = '$(echo eval)'; `echo script`"],
          ["eval", ""],
        ],
        close: true,
      },
      signal,
    );

    // Expected strings are deliberately independent of production shellEscape.
    const prefix = "'agent-browser' '--session' 'user'\\''s $(echo session); `echo name`'";
    expect(execMock.mock.calls).toEqual([
      [
        `${prefix} 'open' 'https://example.com/a'\\''b?q=$(echo url)&x=\`echo query\`' '--json'`,
        { timeout: 90, signal },
      ],
      [
        `${prefix} 'eval' 'document.title = '\\''$(echo eval)'\\''; \`echo script\`' '--json'`,
        { timeout: 90, signal },
      ],
      [`${prefix} 'eval' '' '--json'`, { timeout: 90, signal }],
      [`${prefix} 'close' '--json'`, { timeout: 90, signal: undefined }],
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("forwards the signal to goal-loop snapshots and actions through the same executor", async () => {
    mockAgentBrowser([
      { success: true, data: { snapshot: "A page", refs: {} } },
      { success: true, data: null },
      { success: true, data: { snapshot: "Ready", refs: {} } },
      { success: true, data: { closed: true } },
    ]);
    for (const choice of ["WAIT", "DONE"]) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          model: "typesafe/jev-1.0",
          answers: { operation: { type: "choice", choice, probabilities: { [choice]: 1 } } },
        }),
      );
    }
    const signal = new AbortController().signal;
    const result = await createJevBrowserTool(executor).execute(
      "goal",
      { label: "test", session: "goal", goal: "Wait until ready", close: true },
      signal,
    );
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      status: "done",
      steps: 1,
      lastPageSnapshot: "Ready",
    });
    expect(execMock.mock.calls).toEqual([
      ["'agent-browser' '--session' 'goal' 'snapshot' '-i' '--json'", { timeout: 90, signal }],
      ["'agent-browser' '--session' 'goal' 'wait' '1000' '--json'", { timeout: 90, signal }],
      ["'agent-browser' '--session' 'goal' 'snapshot' '-i' '--json'", { timeout: 90, signal }],
      ["'agent-browser' '--session' 'goal' 'close' '--json'", { timeout: 90, signal: undefined }],
    ]);
  });

  test("cleans up through the executor without the aborted signal after execution rejects", async () => {
    const controller = new AbortController();
    const failure = new Error("Browser command aborted");
    execMock
      .mockImplementationOnce(async () => {
        controller.abort();
        throw failure;
      })
      .mockResolvedValueOnce({ stdout: '{"success":true}', stderr: "", code: 0 });

    await expect(
      createJevBrowserTool(executor).execute(
        "abort",
        { label: "test", session: "abort", commands: [["eval", "1"]], close: true },
        controller.signal,
      ),
    ).rejects.toBe(failure);
    expect(controller.signal.aborted).toBe(true);
    expect(execMock.mock.calls).toEqual([
      [
        "'agent-browser' '--session' 'abort' 'eval' '1' '--json'",
        { timeout: 90, signal: controller.signal },
      ],
      ["'agent-browser' '--session' 'abort' 'close' '--json'", { timeout: 90, signal: undefined }],
    ]);
  });

  test("does not execute or clean up when the signal is already aborted", async () => {
    await expect(
      createJevBrowserTool(executor).execute(
        "aborted",
        { label: "test", session: "abort", commands: [["snapshot"]], close: true },
        AbortSignal.abort(),
      ),
    ).rejects.toThrow(/aborted/i);
    expect(execMock).not.toHaveBeenCalled();
  });

  test("preserves structured JSON errors from nonzero exits and continues raw commands", async () => {
    execMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ success: false, data: null, error: "No matching element" }),
        stderr: "command failed",
        code: 1,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ success: true, data: { title: "Example" }, error: null }),
        stderr: "",
        code: 0,
      });
    const result = await createJevBrowserTool(executor).execute(
      "nonzero",
      {
        label: "test",
        session: "errors",
        commands: [
          ["click", "@e1"],
          ["get", "title"],
        ],
      },
      undefined,
    );
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      status: "no-goal",
      commandResults: [
        { command: ["click", "@e1"], success: false, data: null, error: "No matching element" },
        { command: ["get", "title"], success: true, data: { title: "Example" }, error: null },
      ],
    });
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  test("missing CLI reports provisioning in the selected sandbox without installing anything", async () => {
    execMock.mockResolvedValue({
      stdout: "",
      stderr: "sh: agent-browser: command not found",
      code: 127,
    });
    const execution = createJevBrowserTool(executor).execute(
      "missing",
      { label: "test", session: "missing", commands: [["snapshot"]] },
      undefined,
    );
    await expect(execution).rejects.toThrow(/agent-browser/i);
    await expect(execution).rejects.toThrow(/container/i);
    await expect(execution).rejects.toThrow(/install|provision/i);
    expect(execMock.mock.calls).toEqual([
      [
        "'agent-browser' '--session' 'missing' 'snapshot' '--json'",
        { timeout: 90, signal: undefined },
      ],
    ]);
  });

  test("tools with different executors never cross-run even with the same session name", async () => {
    mockAgentBrowser([{ success: true, data: { owner: "first" }, error: null }]);
    const otherExec = vi.fn<Executor["exec"]>().mockResolvedValue({
      stdout: JSON.stringify({ success: true, data: { owner: "second" }, error: null }),
      stderr: "",
      code: 0,
    });
    const otherExecutor = { ...executor, exec: otherExec } as Executor;
    const first = createJevBrowserTool(executor);
    const second = createJevBrowserTool(otherExecutor);
    const args = { label: "test", session: "shared", commands: [["get", "title"]], close: true };
    for (const [tool, owner] of [
      [first, "first"],
      [second, "second"],
      [first, "first"],
    ] as const) {
      const result = await tool.execute(owner, args, undefined);
      expect(JSON.parse((result.content[0] as { text: string }).text).commandResults).toEqual([
        { command: ["get", "title"], success: true, data: { owner }, error: null },
      ]);
    }
    const calls = [
      [
        "'agent-browser' '--session' 'shared' 'get' 'title' '--json'",
        { timeout: 90, signal: undefined },
      ],
      ["'agent-browser' '--session' 'shared' 'close' '--json'", { timeout: 90, signal: undefined }],
    ];
    expect(execMock.mock.calls).toEqual([...calls, ...calls]);
    expect(otherExec.mock.calls).toEqual(calls);
  });

  test("rejects a call with neither url nor session", async () => {
    const tool = createJevBrowserTool(executor);
    await expect(
      tool.execute("call-1", { label: "test", goal: "anything" }, undefined),
    ).rejects.toThrow(/Provide url .* or session/);
    expect(execMock).not.toHaveBeenCalled();
  });

  test("rejects a call with neither goal nor commands", async () => {
    const tool = createJevBrowserTool(executor);
    await expect(
      tool.execute("call-1", { label: "test", url: "https://example.com" }, undefined),
    ).rejects.toThrow(/Provide goal, commands, or both/);
    expect(execMock).not.toHaveBeenCalled();
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
