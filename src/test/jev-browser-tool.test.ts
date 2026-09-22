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

  test("duplicate labels include current checked state and neighboring item text", () => {
    const snapshot =
      '- listitem\n  - checkbox "Toggle Todo" [checked=true, ref=e1]\n  - LabelText\n    - StaticText "QA Alpha"\n- listitem\n  - checkbox "Toggle Todo" [checked=false, ref=e2]\n  - LabelText\n    - StaticText "QA Beta"';
    const { questions } = buildQuestionPlan(
      {
        e1: { role: "checkbox", name: "Toggle Todo" },
        e2: { role: "checkbox", name: "Toggle Todo" },
      },
      false,
      false,
      snapshot,
    );
    const q = questions.click_target;
    expect(q?.type).toBe("choice");
    if (q?.type !== "choice") throw new Error("Missing choice");
    expect(q.criteria.e1).toContain("QA Alpha");
    expect(q.criteria.e1).toContain("checked=true");
    expect(q.criteria.e2).toContain("QA Beta");
    expect(q.criteria.e2).toContain("checked=false");
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

  function answerOperation(choice: string) {
    return jsonResponse({
      model: "typesafe/jev-1.0",
      answers: { operation: { type: "choice", choice, probabilities: { [choice]: 1 } } },
    });
  }

  test.each([
    { command: [], error: /commands cannot be empty/ },
    ...["press", "key"].flatMap((operation) =>
      ["e1", "@e23"].map((ref) => ({
        command: [operation, ref, "Enter"],
        error: /press takes a key, not a target ref/,
      })),
    ),
  ])("rejects invalid argv $command before any browser side effect", async ({ command, error }) => {
    await expect(
      createJevBrowserTool(executor).execute(
        "invalid",
        {
          label: "test",
          session: "preflight",
          url: "https://example.com",
          frame: "#form",
          commands: [["click", "@e1"], command],
          goal: "Submit",
          close: true,
        },
        undefined,
      ),
    ).rejects.toThrow(error);
    expect(execMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    ["press", "Enter"],
    ["key", "Enter"],
  ])("forwards valid %s %s argv", async (operation, key) => {
    mockAgentBrowser([{ success: true, data: null, error: null }]);
    const result = await createJevBrowserTool(executor).execute(
      "key",
      {
        label: "test",
        session: "keys",
        commands: [[operation, key]],
      },
      undefined,
    );
    expect(execMock.mock.calls[0]?.[0]).toBe(
      "'agent-browser' '--session' 'keys' '" + operation + "' 'Enter' '--json'",
    );
    expect(JSON.parse((result.content[0] as { text: string }).text).status).toBe("no-goal");
  });

  test.each([
    { command: ["--help"] },
    { command: ["press", "--help"] },
    { command: ["skills", "get", "core", "--full"] },
  ])("returns native plain-text help for $command", async ({ command }) => {
    const help = "Usage: agent-browser\n  press <key>\n";
    execMock.mockResolvedValue({ stdout: help, stderr: "", code: 0 });
    const result = await createJevBrowserTool(executor).execute(
      "help",
      {
        label: "Help",
        session: "help",
        commands: [command],
      },
      undefined,
    );
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      status: "no-goal",
      commandResults: [{ command, success: true, data: { help }, error: null }],
    });
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a raw protocol failure stops the batch and goal evaluation but still closes", async () => {
    mockAgentBrowser([
      { success: true, data: { title: "Form" }, error: null },
      { success: false, data: null, error: "No matching element" },
      { success: true, data: null },
    ]);
    const result = await createJevBrowserTool(executor).execute(
      "batch",
      {
        label: "test",
        session: "batch",
        close: true,
        goal: "Submit",
        commands: [
          ["get", "title"],
          ["click", "@e1"],
          ["press", "Enter"],
        ],
      },
      undefined,
    );
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      status: "blocked",
      message: "Browser command failed: click: No matching element",
      commandResults: [
        { command: ["get", "title"], success: true, data: { title: "Form" }, error: null },
        { command: ["click", "@e1"], success: false, data: null, error: "No matching element" },
      ],
    });
    expect(execMock.mock.calls.map(([command]) => command)).toEqual([
      "'agent-browser' '--session' 'batch' 'get' 'title' '--json'",
      "'agent-browser' '--session' 'batch' 'click' '@e1' '--json'",
      "'agent-browser' '--session' 'batch' 'close' '--json'",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([11999, 12000, 12001])("bounds goal page evidence at %s characters", async (length) => {
    const snapshot = "x".repeat(length);
    mockAgentBrowser([
      { success: true, data: { snapshot, origin: "https://example.com/active", refs: {} } },
    ]);
    fetchMock.mockResolvedValueOnce(answerOperation("DONE"));
    await createJevBrowserTool(executor).execute(
      "page",
      {
        label: "test",
        session: "page",
        goal: "Read page",
      },
      undefined,
    );
    const request = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(request.state).toMatchObject({
      page: length > 12000 ? "x".repeat(12000) + "…" : snapshot,
      pageTruncated: length > 12000,
      url: "https://example.com/active",
      history: [],
    });
  });

  test("completion decisions receive successful history and current evidence for filtered-away items", async () => {
    mockAgentBrowser([
      {
        success: true,
        data: {
          snapshot: '- checkbox "Task"',
          refs: { e1: { role: "checkbox", name: "Task" } },
          origin: "https://example.com/",
        },
      },
      { success: true, data: null },
      {
        success: true,
        data: {
          snapshot: "Active: 0 items left",
          refs: {},
          origin: "https://example.com/#/active",
        },
      },
    ]);
    fetchMock
      .mockResolvedValueOnce(answerOperation("CLICK"))
      .mockResolvedValueOnce(answerOperation("DONE"));
    const result = await createJevBrowserTool(executor).execute(
      "filtered",
      {
        label: "test",
        session: "filtered",
        goal: "Complete Task and verify Active has no remaining items",
      },
      undefined,
    );
    const request = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(request.state).toMatchObject({
      page: "Active: 0 items left",
      url: "https://example.com/#/active",
      history: [{ step: 1, operation: "CLICK", target: "e1", label: "Task" }],
    });
    expect(request.questions.operation.instructions).toContain(
      "History records attempted actions, NOT confirmed effects",
    );
    expect(request.questions.operation.instructions).toContain("filtered-away completed item");
    expect(request.questions.operation.instructions).toContain(
      "A successful command alone is not proof",
    );
    expect(request.questions.operation.instructions).toContain("resulting URL");
    expect(request.questions.operation.instructions).toContain(
      "If content is truncated, do not infer missing evidence",
    );
    expect(request.questions.operation.criteria.DONE).toContain(
      "attempted actions in history are not proof",
    );
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      status: "done",
      steps: 1,
    });
  });

  test.each(["WAIT", "DONE", "BLOCKED"])(
    "three unchanged post-action observations allow %s before the progress guard",
    async (lastChoice) => {
      const snapshot = {
        success: true,
        data: { snapshot: "Unchanged", refs: {}, origin: "https://example.com/" },
      };
      mockAgentBrowser([
        snapshot,
        { success: true },
        snapshot,
        { success: true },
        snapshot,
        { success: true },
        snapshot,
      ]);
      for (const choice of ["WAIT", "WAIT", "WAIT", lastChoice])
        fetchMock.mockResolvedValueOnce(answerOperation(choice));
      const result = await createJevBrowserTool(executor).execute(
        "progress",
        {
          label: "test",
          session: "progress",
          goal: "Wait for completion",
          maxSteps: 10,
        },
        undefined,
      );
      expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
        status: lastChoice === "DONE" ? "done" : "blocked",
        steps: 3,
        message:
          lastChoice === "DONE"
            ? "Goal reported complete."
            : lastChoice === "BLOCKED"
              ? "No further progress possible."
              : expect.stringContaining("No observable page change after 3 actions"),
        history: [1, 2, 3].map((step) => ({ step, operation: "WAIT" })),
      });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(execMock).toHaveBeenCalledTimes(7);
    },
  );

  test("alternating page states hand control back instead of toggling forever", async () => {
    mockAgentBrowser(
      ["unchecked", "checked", "unchecked", "checked", "unchecked"].flatMap((state, index) => {
        const snapshot = {
          success: true,
          data: { snapshot: state, refs: { e1: { role: "checkbox", name: "Toggle Todo" } } },
        };
        return index < 4 ? [snapshot, { success: true }] : [snapshot];
      }),
    );
    fetchMock.mockImplementation(async () => answerOperation("CLICK"));
    const result = await createJevBrowserTool(executor).execute(
      "cycle",
      { label: "test", session: "cycle", goal: "Complete an item", maxSteps: 10 },
      undefined,
    );
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      status: "blocked",
      steps: 4,
      message: expect.stringContaining("actions are cycling"),
    });
    expect(execMock.mock.calls.filter(([command]) => command.includes("'click'"))).toHaveLength(4);
  });

  test.each(["url", "page"])("a changed %s resets the no-progress count", async (changed) => {
    const observations = Array.from({ length: 7 }, (_, index) => ({
      success: true,
      data: {
        snapshot: changed === "page" && index >= 3 ? "Changed" : "Initial",
        origin:
          changed === "url" && index >= 3 ? "https://example.com/new" : "https://example.com/",
        refs: {},
      },
    }));
    mockAgentBrowser(
      observations.flatMap((snapshot, index) =>
        index < 6 ? [snapshot, { success: true }] : [snapshot],
      ),
    );
    fetchMock.mockImplementation(async () => answerOperation("WAIT"));
    const result = await createJevBrowserTool(executor).execute(
      "reset",
      {
        label: "test",
        session: "reset",
        goal: "Wait until ready",
        maxSteps: 10,
      },
      undefined,
    );
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      status: "blocked",
      steps: 6,
      message: expect.stringContaining("No observable page change after 3 actions"),
    });
    expect(execMock).toHaveBeenCalledTimes(13);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  test.each(["WAIT", "SCROLL_DOWN", "SCROLL_UP"])(
    "failed %s blocks without adding unsuccessful history",
    async (operation) => {
      mockAgentBrowser([
        { success: true, data: { snapshot: "scroll_up", refs: {} } },
        { success: false, error: "Browser disconnected" },
      ]);
      fetchMock.mockResolvedValueOnce(answerOperation(operation));
      const result = await createJevBrowserTool(executor).execute(
        "failed-action",
        {
          label: "test",
          session: "failed-action",
          goal: "Continue",
        },
        undefined,
      );
      expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
        status: "blocked",
        message: operation + " failed: Browser disconnected",
        steps: 0,
        history: [],
      });
      expect(execMock).toHaveBeenCalledTimes(2);
      expect(execMock.mock.calls[1]?.[0]).toContain(
        operation === "WAIT"
          ? "'wait' '1000'"
          : "'scroll' '" + (operation === "SCROLL_UP" ? "up" : "down") + "' '500'",
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    { operation: "INVALID", target: undefined, message: "Jev returned no valid operation choice." },
    {
      operation: "CLICK",
      target: undefined,
      message: "Jev chose CLICK but no target was available.",
    },
    { operation: "CLICK", target: "e999", message: "Jev chose CLICK but no target was available." },
  ])(
    "invalid goal decision $operation/$target blocks without action",
    async ({ operation, target, message }) => {
      mockAgentBrowser([
        {
          success: true,
          data: {
            snapshot: "Buttons",
            refs: target
              ? {
                  e1: { role: "button", name: "Save" },
                  e2: { role: "button", name: "Cancel" },
                }
              : {},
          },
        },
      ]);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          model: "typesafe/jev-1.0",
          answers: {
            operation: { type: "choice", choice: operation, probabilities: { [operation]: 1 } },
            ...(target
              ? { click_target: { type: "choice", choice: target, probabilities: { [target]: 1 } } }
              : {}),
          },
        }),
      );
      const result = await createJevBrowserTool(executor).execute(
        "invalid-decision",
        {
          label: "test",
          session: "invalid-decision",
          goal: "Save",
        },
        undefined,
      );
      expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
        status: "blocked",
        message,
        steps: 0,
        history: [],
      });
      expect(execMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  test("reports the last page snapshot even when DONE is reached on the first observation", async () => {
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } },
      {
        success: true,
        data: {
          origin: "https://example.com/",
          refs: {},
          snapshot: '- heading "Example Domain" [ref=e1]\n- link "More information..." [ref=e2]',
        },
      },
      { success: true, data: { closed: true } },
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

  test("declares frame as an optional string", () => {
    const schema = createJevBrowserTool(executor).parameters;
    expect(schema.properties.frame).toMatchObject({ type: "string" });
    expect(schema.required).not.toContain("frame");
  });

  test("switches frames after opening and before commands and full goal snapshots, quoting selectors literally", async () => {
    const snapshot =
      '- iframe "Customer form"\n  - paragraph: Thank you, your request is complete.';
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } },
      { success: true, data: null },
      { success: true, data: { title: "Customer form" } },
      { success: true, data: { snapshot, refs: {} } },
      { success: true, data: { closed: true } },
    ]);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        model: "typesafe/jev-1.0",
        answers: { operation: { type: "choice", choice: "DONE", probabilities: { DONE: 1 } } },
      }),
    );
    const signal = new AbortController().signal;
    const result = await createJevBrowserTool(executor).execute(
      "frame",
      {
        label: "Complete form",
        session: "frame-test",
        url: "https://example.com",
        frame: 'iframe[title="Customer\'s $(echo frame); `echo frame`"]',
        commands: [["get", "title"]],
        goal: "Confirm the request is complete",
        close: true,
      },
      signal,
    );
    const prefix = "'agent-browser' '--session' 'frame-test'";
    expect(execMock.mock.calls).toEqual([
      [prefix + " 'open' 'https://example.com' '--json'", { timeout: 90, signal }],
      [
        prefix + " 'frame' 'iframe[title=\"Customer'\\''s $(echo frame); `echo frame`\"]' '--json'",
        { timeout: 90, signal },
      ],
      [prefix + " 'get' 'title' '--json'", { timeout: 90, signal }],
      [prefix + " 'snapshot' '--json'", { timeout: 90, signal }],
      [prefix + " 'close' '--json'", { timeout: 90, signal: undefined }],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(request.state.page).toBe(snapshot);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      status: "done",
      steps: 0,
      lastPageSnapshot: snapshot,
    });
  });

  test("frame main returns an existing session to the parent before raw commands without reopening", async () => {
    mockAgentBrowser([{ success: true, data: null }]);
    const result = await createJevBrowserTool(executor).execute(
      "main",
      {
        label: "Return to parent",
        session: "existing",
        frame: "main",
        commands: [["snapshot"]],
      },
      undefined,
    );
    expect(execMock.mock.calls).toEqual([
      [
        "'agent-browser' '--session' 'existing' 'frame' 'main' '--json'",
        { timeout: 90, signal: undefined },
      ],
      [
        "'agent-browser' '--session' 'existing' 'snapshot' '--json'",
        { timeout: 90, signal: undefined },
      ],
    ]);
    expect(JSON.parse((result.content[0] as { text: string }).text).status).toBe("no-goal");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([undefined, false])(
    "failed frame switching never acts on the parent and respects close=%s",
    async (close) => {
      mockAgentBrowser([
        { success: true, data: { targetId: "t1" } },
        { success: false, error: "No matching frame" },
        { success: true, data: { closed: true } },
      ]);
      const signal = new AbortController().signal;
      await expect(
        createJevBrowserTool(executor).execute(
          "missing-frame",
          {
            label: "Submit inside frame",
            url: "https://example.com",
            frame: "#missing",
            commands: [["click", "@e1"]],
            goal: "Submit the form",
            close,
          },
          signal,
        ),
      ).rejects.toThrow("Failed to switch browser frame: No matching frame");
      expect(execMock.mock.calls).toEqual([
        [
          expect.stringMatching(
            /^'agent-browser' '--session' 'mikan-jb-[^']+' 'open' 'https:\/\/example.com' '--json'$/,
          ),
          { timeout: 90, signal },
        ],
        [
          expect.stringMatching(
            /^'agent-browser' '--session' 'mikan-jb-[^']+' 'frame' '#missing' '--json'$/,
          ),
          { timeout: 90, signal },
        ],
        ...(close === false
          ? []
          : [
              [
                expect.stringMatching(
                  /^'agent-browser' '--session' 'mikan-jb-[^']+' 'close' '--json'$/,
                ),
                { timeout: 90, signal: undefined },
              ],
            ]),
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test.each([false, true])(
    "refreshes the final snapshot after the last budgeted action (snapshot fails=%s)",
    async (fails) => {
      const snapshot = "- paragraph: Submission complete";
      mockAgentBrowser([
        {
          success: true,
          data: {
            origin: "https://example.com/form",
            snapshot: '- button "Submit" [ref=e1]',
            refs: { e1: { role: "button", name: "Submit" } },
          },
        },
        { success: true, data: null },
        fails
          ? { success: false, error: "Page disappeared" }
          : { success: true, data: { origin: "https://example.com/complete", snapshot, refs: {} } },
        { success: true, data: { closed: true } },
      ]);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          model: "typesafe/jev-1.0",
          answers: { operation: { type: "choice", choice: "CLICK", probabilities: { CLICK: 1 } } },
        }),
      );
      const signal = new AbortController().signal;
      const execution = createJevBrowserTool(executor).execute(
        "last-action",
        {
          label: "Submit",
          session: "budget",
          goal: "Submit the form",
          maxSteps: 1,
          close: true,
        },
        signal,
      );
      if (fails) {
        await expect(execution).rejects.toThrow("Final snapshot failed: Page disappeared");
      } else {
        const result = await execution;
        expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
          status: "step-limit",
          steps: 1,
          lastPageSnapshot: snapshot,
          finalUrl: "https://example.com/complete",
        });
      }
      expect(execMock.mock.calls).toEqual([
        ["'agent-browser' '--session' 'budget' 'snapshot' '--json'", { timeout: 90, signal }],
        ["'agent-browser' '--session' 'budget' 'click' '@e1' '--json'", { timeout: 90, signal }],
        ["'agent-browser' '--session' 'budget' 'snapshot' '--json'", { timeout: 90, signal }],
        [
          "'agent-browser' '--session' 'budget' 'close' '--json'",
          { timeout: 90, signal: undefined },
        ],
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  test("always closes the agent-browser session, even after a mid-loop failure", async () => {
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } },
      { success: false, error: "boom" },
      { success: true, data: { closed: true } },
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
      { success: true, data: { targetId: "t1" }, error: null },
      { success: true, data: { started: true }, error: null },
      {
        success: true,
        data: {
          origin: "https://example.com/",
          refs: {},
          snapshot: '- heading "Example Domain" [ref=e1]',
        },
        error: null,
      },
      { success: true, data: { closed: true }, error: null },
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
      { success: true, data: { targetId: "t1" }, error: null },
      { success: true, data: { path: "/tmp/shot.png" }, error: null },
      { success: true, data: { closed: true }, error: null },
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
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } },
      { success: true, data: { started: true } },
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

    execMock.mockReset();
    mockAgentBrowser([
      { success: true, data: { path: "/tmp/demo.webm", frames: 12 } },
      { success: true, data: { closed: true } },
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
    const finalCloseCall = execMock.mock.calls.find((call) => call[0].includes("'close'"));
    expect(finalCloseCall).toBeDefined();
  });

  test("an explicitly closed named session requires url before reuse", async () => {
    mockAgentBrowser([{ success: true, data: { closed: true } }]);
    const tool = createJevBrowserTool(executor);

    await tool.execute(
      "close",
      { label: "test", session: "closed-session", close: true },
      undefined,
    );
    execMock.mockClear();

    await expect(
      tool.execute(
        "reuse",
        { label: "test", session: "closed-session", commands: [["snapshot"]] },
        undefined,
      ),
    ).rejects.toThrow(/explicitly closed.*Provide url/i);
    expect(execMock).not.toHaveBeenCalled();
  });

  test("url can explicitly restart a named session after close", async () => {
    const tool = createJevBrowserTool(executor);
    mockAgentBrowser([{ success: true, data: { closed: true } }]);
    await tool.execute(
      "close",
      { label: "test", session: "restart-session", close: true },
      undefined,
    );

    execMock.mockReset();
    mockAgentBrowser([
      { success: true, data: { targetId: "new" } },
      { success: true, data: { snapshot: "Restarted", refs: {} } },
    ]);
    const result = await tool.execute(
      "restart",
      {
        label: "test",
        session: "restart-session",
        url: "https://example.com",
        commands: [["snapshot"]],
      },
      undefined,
    );
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      status: "no-goal",
      session: "restart-session",
    });
  });

  test("a failed explicit restart keeps the closed-session guard", async () => {
    const tool = createJevBrowserTool(executor);
    mockAgentBrowser([{ success: true, data: { closed: true } }]);
    await tool.execute(
      "close",
      { label: "test", session: "failed-restart", close: true },
      undefined,
    );

    execMock.mockReset();
    mockAgentBrowser([{ success: false, error: "navigation failed" }]);
    await expect(
      tool.execute(
        "restart",
        {
          label: "test",
          session: "failed-restart",
          url: "https://example.com",
          commands: [["snapshot"]],
        },
        undefined,
      ),
    ).rejects.toThrow(/Failed to open/);

    execMock.mockClear();
    await expect(
      tool.execute(
        "reuse",
        { label: "test", session: "failed-restart", commands: [["snapshot"]] },
        undefined,
      ),
    ).rejects.toThrow(/explicitly closed.*Provide url/i);
    expect(execMock).not.toHaveBeenCalled();
  });

  test("a reported close failure does not mark a named session as closed", async () => {
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } },
      { success: true, data: { title: "Example" } },
      { success: false, error: "close failed" },
    ]);
    const tool = createJevBrowserTool(executor);
    await tool.execute(
      "first",
      {
        label: "test",
        session: "close-failed",
        url: "https://example.com",
        commands: [["get", "title"]],
        close: true,
      },
      undefined,
    );

    execMock.mockReset();
    mockAgentBrowser([{ success: true, data: { title: "Still open" } }]);
    await expect(
      tool.execute(
        "reuse",
        { label: "test", session: "close-failed", commands: [["get", "title"]] },
        undefined,
      ),
    ).resolves.toBeDefined();
  });

  test("serializes concurrent calls from one runner to avoid parallel Chromium bursts", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolveStarted) => {
      execMock.mockImplementation(async (command) => {
        if (command.includes("'first'")) {
          resolveStarted();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return { stdout: JSON.stringify({ success: true, data: {} }), stderr: "", code: 0 };
      });
    });
    const tool = createJevBrowserTool(executor);
    const first = tool.execute(
      "first-call",
      { label: "test", session: "first", commands: [["get", "title"]] },
      undefined,
    );
    await firstStarted;
    const second = tool.execute(
      "second-call",
      { label: "test", session: "second", commands: [["get", "title"]] },
      undefined,
    );
    await Promise.resolve();
    expect(execMock.mock.calls.map(([command]) => command)).toEqual([
      "'agent-browser' '--session' 'first' 'get' 'title' '--json'",
    ]);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(execMock.mock.calls.map(([command]) => command)).toEqual([
      "'agent-browser' '--session' 'first' 'get' 'title' '--json'",
      "'agent-browser' '--session' 'second' 'get' 'title' '--json'",
    ]);
  });

  test("a one-off call (no session) still closes automatically, matching the original single-call ergonomics", async () => {
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } },
      { success: true, data: { path: "/tmp/shot.png" } },
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
      { success: true, data: { targetId: "t1" } },
      { success: true, data: { path: "/tmp/shot.png" } },
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
      },
      { success: true, data: { started: true, lifecycle: { reused: true } } },
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
      { success: true, data: { path: "/tmp/demo.webm", lifecycle: { reused: true } } },
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
      ["'agent-browser' '--session' 'goal' 'snapshot' '--json'", { timeout: 90, signal }],
      ["'agent-browser' '--session' 'goal' 'wait' '1000' '--json'", { timeout: 90, signal }],
      ["'agent-browser' '--session' 'goal' 'snapshot' '--json'", { timeout: 90, signal }],
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

  test("preserves structured JSON errors from nonzero exits and stops raw commands", async () => {
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
      status: "blocked",
      commandResults: [
        { command: ["click", "@e1"], success: false, data: null, error: "No matching element" },
      ],
    });
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
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
    const args = { label: "test", session: "shared", commands: [["get", "title"]] };
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
    const call = [
      "'agent-browser' '--session' 'shared' 'get' 'title' '--json'",
      { timeout: 90, signal: undefined },
    ];
    expect(execMock.mock.calls).toEqual([call, call]);
    expect(otherExec.mock.calls).toEqual([call]);
  });

  test.each([undefined, []])(
    "close-only sends exactly one close command (commands=%j)",
    async (commands) => {
      mockAgentBrowser([{ success: true, data: { closed: true } }]);
      const signal = new AbortController().signal;
      const tool = createJevBrowserTool(executor);
      const result = await tool.execute(
        "close-only",
        { label: "Close", session: "named", close: true, commands },
        signal,
      );
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
        status: "closed",
        session: "named",
      });
      expect(execMock).toHaveBeenCalledExactlyOnceWith(
        "'agent-browser' '--session' 'named' 'close' '--json'",
        { timeout: 90, signal },
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test("close-only surfaces CLI failure without reporting closed or retrying cleanup", async () => {
    mockAgentBrowser([{ success: false, error: "close failed" }]);
    await expect(
      createJevBrowserTool(executor).execute(
        "close",
        { label: "Close", session: "named", close: true },
        undefined,
      ),
    ).rejects.toThrow("Failed to close browser session: close failed");
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  test("successful commands without lifecycle metadata report unknown, not execution failure", async () => {
    mockAgentBrowser([{ success: true, data: { title: "Page" } }]);
    const result = await createJevBrowserTool(executor).execute(
      "read",
      { label: "Title", session: "named", commands: [["get", "title"]] },
      undefined,
    );
    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.commandResults[0].success).toBe(true);
    expect(data.browserContinuity).toContain("did not provide sufficient lifecycle information");
    expect(data.browserContinuity).not.toContain("no agent-browser command completed");
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
    ).rejects.toThrow(/Provide goal or commands/);
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe("describeContinuity", () => {
  test("reports unknown when the CLI omits lifecycle metadata", () => {
    expect(describeContinuity(true, undefined)).toMatch(/^unknown:/);
  });

  test("reports one-off for a call with no session name, regardless of lifecycle", () => {
    expect(describeContinuity(false, { reused: false })).toMatch(/^one-off session:/);
  });

  test("reports continuous when a named session's browser was reused", () => {
    expect(describeContinuity(true, { reused: true })).toMatch(/^continuous:/);
  });

  test.each([{}, { reused: false }, { launched: false }])(
    "does not infer a restart without launch evidence: %j",
    (metadata) => {
      expect(describeContinuity(true, metadata)).toMatch(/^unknown:/);
    },
  );

  test.each([{ launched: true }, { relaunchedBrowser: true }])(
    "reports NOT continuous with explicit launch evidence: %j",
    (metadata) => {
      expect(describeContinuity(true, metadata)).toMatch(/^NOT continuous:/);
    },
  );
});
