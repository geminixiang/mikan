import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { tmpdir } from "node:os";
import { ExecutionError, err, ok } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

type ExecCall = (
  command: string,
  options: { timeout?: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number }>;

const quote = (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`;

function fakeEnv(exec: ExecCall): () => NodeExecutionEnv {
  const env = Object.assign(new NodeExecutionEnv({ cwd: tmpdir() }), {
    exec: async (
      command: string | readonly string[],
      options: Parameters<NodeExecutionEnv["exec"]>[1],
      context: Parameters<NodeExecutionEnv["exec"]>[2],
    ) => {
      const line = typeof command === "string" ? command : command.map(quote).join(" ");
      try {
        const result = await exec(line, { timeout: options?.timeout, signal: context.abortSignal });
        if (result.code === 127) return err(new ExecutionError("spawn_error", result.stderr));
        if (result.stdout) options?.onOutput?.(result.stdout, context, { stream: "stdout" });
        if (result.stderr) options?.onOutput?.(result.stderr, context, { stream: "stderr" });
        return ok({ exitCode: result.code });
      } catch (error) {
        return err(new ExecutionError("unknown", (error as Error).message));
      }
    },
  });
  return () => env;
}

const execMock = vi.fn<ExecCall>();
const env = fakeEnv(execMock);

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

interface JevBrowserRequestBody {
  state: { page: string };
  questions: { operation: { instructions: string; criteria: Record<string, string> } };
}

function requestBody(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
  index: number,
): JevBrowserRequestBody {
  const body = fetchMock.mock.calls[index]?.[1]?.body;
  if (typeof body !== "string") throw new Error(`fetch call ${index} has no string body`);
  return JSON.parse(body);
}

function sentCommands(): unknown[] {
  return execMock.mock.calls.map(([command, options]) => [
    command.replace(/'--session' 'mikan-jb-[^']+'/, "'--session' 'S'"),
    options,
  ]);
}

function sentCommand(index: number): string | undefined {
  return (sentCommands()[index] as [string] | undefined)?.[0];
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
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    execMock.mockReset();
    fetchMock.mockReset();
    global.fetch = fetchMock;
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
      answers: {
        operation: { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 },
      },
    });
  }

  function answerType(target: string) {
    return jsonResponse({
      answers: {
        operation: {
          type: "choice",
          choice: "TYPE_TEXT",
          probabilities: { TYPE_TEXT: 1 },
          confidence: 1,
        },
        type_target: {
          type: "choice",
          choice: target,
          probabilities: { [target]: 1 },
          confidence: 1,
        },
      },
    });
  }

  test("a TYPE step fills the field with text written by the run's chat model", async () => {
    const emailPage = {
      success: true,
      data: { snapshot: "Email field", refs: { e1: { role: "textbox", name: "Email" } } },
    };
    mockAgentBrowser([emailPage, { success: true, data: {} }, emailPage]);
    fetchMock
      .mockResolvedValueOnce(answerType("e1"))
      .mockResolvedValueOnce(answerOperation("DONE"));
    const generateText = vi.fn(async () => 'Here you go: {"text":"qa@example.com"}');

    await createJevBrowserTool(env, generateText).execute(
      "type",
      { label: "test", goal: "Enter the email qa@example.com", maxSteps: 2 },
      undefined,
    );

    expect(generateText).toHaveBeenCalledOnce();
    expect(JSON.stringify(generateText.mock.calls[0])).toContain("Enter the email qa@example.com");
    expect(
      execMock.mock.calls.some((call) => String(call[0]).includes("'fill' '@e1' 'qa@example.com'")),
    ).toBe(true);
  });

  test("a TYPE step without a chat model blocks and says why", async () => {
    mockAgentBrowser([
      {
        success: true,
        data: { snapshot: "Email field", refs: { e1: { role: "textbox", name: "Email" } } },
      },
    ]);
    fetchMock.mockResolvedValueOnce(answerType("e1"));

    const result = await createJevBrowserTool(env).execute(
      "type",
      { label: "test", goal: "Enter an email" },
      undefined,
    );

    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      status: "blocked",
      message: "No chat model is available to write text for this field.",
    });
  });

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
      createJevBrowserTool(env).execute(
        "invalid",
        {
          label: "test",
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
    const result = await createJevBrowserTool(env).execute(
      "key",
      {
        label: "test",
        commands: [[operation, key]],
      },
      undefined,
    );
    expect(sentCommand(0)).toBe(
      "'agent-browser' '--session' 'S' '" + operation + "' 'Enter' '--json'",
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
    const result = await createJevBrowserTool(env).execute(
      "help",
      {
        label: "Help",
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
    const result = await createJevBrowserTool(env).execute(
      "batch",
      {
        label: "test",
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
    expect(sentCommands().map((call) => (call as [string])[0])).toEqual([
      "'agent-browser' '--session' 'S' 'get' 'title' '--json'",
      "'agent-browser' '--session' 'S' 'click' '@e1' '--json'",
      "'agent-browser' '--session' 'S' 'close' '--json'",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([11999, 12000, 12001])("bounds goal page evidence at %s characters", async (length) => {
    const snapshot = "x".repeat(length);
    mockAgentBrowser([
      { success: true, data: { snapshot, origin: "https://example.com/active", refs: {} } },
    ]);
    fetchMock.mockResolvedValueOnce(answerOperation("DONE"));
    await createJevBrowserTool(env).execute(
      "page",
      {
        label: "test",
        goal: "Read page",
      },
      undefined,
    );
    const request = requestBody(fetchMock, 0);
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
    const result = await createJevBrowserTool(env).execute(
      "filtered",
      {
        label: "test",
        goal: "Complete Task and verify Active has no remaining items",
      },
      undefined,
    );
    const request = requestBody(fetchMock, 1);
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
      const result = await createJevBrowserTool(env).execute(
        "progress",
        {
          label: "test",
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
    const result = await createJevBrowserTool(env).execute(
      "cycle",
      { label: "test", goal: "Complete an item", maxSteps: 10 },
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
    const result = await createJevBrowserTool(env).execute(
      "reset",
      {
        label: "test",
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
      const result = await createJevBrowserTool(env).execute(
        "failed-action",
        {
          label: "test",
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
      expect(sentCommand(1)).toContain(
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
            operation: {
              type: "choice",
              choice: operation,
              probabilities: { [operation]: 1 },
              confidence: 1,
            },
            ...(target
              ? {
                  click_target: {
                    type: "choice",
                    choice: target,
                    probabilities: { [target]: 1 },
                    confidence: 1,
                  },
                }
              : {}),
          },
        }),
      );
      const result = await createJevBrowserTool(env).execute(
        "invalid-decision",
        {
          label: "test",
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
        answers: {
          operation: {
            type: "choice",
            choice: "DONE",
            probabilities: { DONE: 0.9 },
            confidence: 1,
          },
        },
      }),
    );

    const tool = createJevBrowserTool(env);
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

  test("keeps its definition within a prompt budget and leaves code-enforced rules to their errors", () => {
    const tool = createJevBrowserTool(env);
    const definition = JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    });

    expect(definition.length).toBeLessThanOrEqual(4200);
    expect(tool.description).toMatch(/untrusted/i);
    expect(tool.description).toMatch(/lastPageSnapshot/);
    expect(tool.description).not.toMatch(/press takes only a key/);
    expect(tool.description).not.toMatch(/about:blank/);
  });

  test("declares frame as an optional string", () => {
    const schema = createJevBrowserTool(env).parameters;
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
        answers: {
          operation: { type: "choice", choice: "DONE", probabilities: { DONE: 1 }, confidence: 1 },
        },
      }),
    );
    const signal = new AbortController().signal;
    const result = await createJevBrowserTool(env).execute(
      "frame",
      {
        label: "Complete form",
        url: "https://example.com",
        frame: 'iframe[title="Customer\'s $(echo frame); `echo frame`"]',
        commands: [["get", "title"]],
        goal: "Confirm the request is complete",
        close: true,
      },
      signal,
    );
    const prefix = "'agent-browser' '--session' 'S'";
    expect(sentCommands()).toEqual([
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
    const request = requestBody(fetchMock, 0);
    expect(request.state.page).toBe(snapshot);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      status: "done",
      steps: 0,
      lastPageSnapshot: snapshot,
    });
  });

  test("frame main returns an existing session to the parent before raw commands without reopening", async () => {
    mockAgentBrowser([{ success: true, data: null }]);
    const result = await createJevBrowserTool(env).execute(
      "main",
      {
        label: "Return to parent",
        frame: "main",
        commands: [["snapshot"]],
      },
      undefined,
    );
    expect(sentCommands()).toEqual([
      [
        "'agent-browser' '--session' 'S' 'frame' 'main' '--json'",
        { timeout: 90, signal: undefined },
      ],
      ["'agent-browser' '--session' 'S' 'snapshot' '--json'", { timeout: 90, signal: undefined }],
    ]);
    expect(JSON.parse((result.content[0] as { text: string }).text).status).toBe("no-goal");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([undefined, true])(
    "failed frame switching never acts on the parent and respects close=%s",
    async (close) => {
      mockAgentBrowser([
        { success: true, data: { targetId: "t1" } },
        { success: false, error: "No matching frame" },
        { success: true, data: { closed: true } },
      ]);
      const signal = new AbortController().signal;
      await expect(
        createJevBrowserTool(env).execute(
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
      expect(sentCommands()).toEqual([
        [
          expect.stringMatching(
            /^'agent-browser' '--session' 'S' 'open' 'https:\/\/example.com' '--json'$/,
          ),
          { timeout: 90, signal },
        ],
        [
          expect.stringMatching(/^'agent-browser' '--session' 'S' 'frame' '#missing' '--json'$/),
          { timeout: 90, signal },
        ],
        ...(close === true
          ? [
              [
                "'agent-browser' '--session' 'S' 'close' '--json'",
                { timeout: 90, signal: undefined },
              ],
            ]
          : []),
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
          answers: {
            operation: {
              type: "choice",
              choice: "CLICK",
              probabilities: { CLICK: 1 },
              confidence: 1,
            },
          },
        }),
      );
      const signal = new AbortController().signal;
      const execution = createJevBrowserTool(env).execute(
        "last-action",
        {
          label: "Submit",
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
      expect(sentCommands()).toEqual([
        ["'agent-browser' '--session' 'S' 'snapshot' '--json'", { timeout: 90, signal }],
        ["'agent-browser' '--session' 'S' 'click' '@e1' '--json'", { timeout: 90, signal }],
        ["'agent-browser' '--session' 'S' 'snapshot' '--json'", { timeout: 90, signal }],
        ["'agent-browser' '--session' 'S' 'close' '--json'", { timeout: 90, signal: undefined }],
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  test("keeps the thread's browser open after a mid-loop failure", async () => {
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } },
      { success: false, error: "boom" },
      { success: true, data: { closed: true } },
    ]);

    const tool = createJevBrowserTool(env);
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
    expect(closeCall).toBeUndefined();
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
        answers: {
          operation: {
            type: "choice",
            choice: "DONE",
            probabilities: { DONE: 0.9 },
            confidence: 1,
          },
        },
      }),
    );

    const tool = createJevBrowserTool(env);
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

    const tool = createJevBrowserTool(env);
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

  test("the thread's browser stays open between calls without a close flag", async () => {
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } },
      { success: true, data: { started: true } },
    ]);

    const tool = createJevBrowserTool(env);
    const result = await tool.execute(
      "call-1",
      {
        label: "test",
        url: "https://example.com",
        commands: [["record", "start", "/tmp/demo.webm"]],
      },
      undefined,
    );

    expect(JSON.parse((result.content[0] as { text: string }).text)).not.toHaveProperty("session");
    const closeCall = execMock.mock.calls.find((call) => call[0].includes("'close'"));
    expect(closeCall).toBeUndefined();

    execMock.mockReset();
    mockAgentBrowser([
      { success: true, data: { path: "/tmp/demo.webm", frames: 12 } },
      { success: true, data: { closed: true } },
    ]);
    const result2 = await tool.execute(
      "call-2",
      { label: "test", commands: [["record", "stop"]], close: true },
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
    const tool = createJevBrowserTool(env);

    await tool.execute("close", { label: "test", close: true }, undefined);
    execMock.mockClear();

    await expect(
      tool.execute("reuse", { label: "test", commands: [["snapshot"]] }, undefined),
    ).rejects.toThrow(/explicitly closed.*Provide url/i);
    expect(execMock).not.toHaveBeenCalled();
  });

  test("url can explicitly restart a named session after close", async () => {
    const tool = createJevBrowserTool(env);
    mockAgentBrowser([{ success: true, data: { closed: true } }]);
    await tool.execute("close", { label: "test", close: true }, undefined);

    execMock.mockReset();
    mockAgentBrowser([
      { success: true, data: { targetId: "new" } },
      { success: true, data: { snapshot: "Restarted", refs: {} } },
    ]);
    const result = await tool.execute(
      "restart",
      {
        label: "test",
        url: "https://example.com",
        commands: [["snapshot"]],
      },
      undefined,
    );
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      status: "no-goal",
    });
  });

  test("a failed explicit restart keeps the closed-session guard", async () => {
    const tool = createJevBrowserTool(env);
    mockAgentBrowser([{ success: true, data: { closed: true } }]);
    await tool.execute("close", { label: "test", close: true }, undefined);

    execMock.mockReset();
    mockAgentBrowser([{ success: false, error: "navigation failed" }]);
    await expect(
      tool.execute(
        "restart",
        {
          label: "test",
          url: "https://example.com",
          commands: [["snapshot"]],
        },
        undefined,
      ),
    ).rejects.toThrow(/Failed to open/);

    execMock.mockClear();
    await expect(
      tool.execute("reuse", { label: "test", commands: [["snapshot"]] }, undefined),
    ).rejects.toThrow(/explicitly closed.*Provide url/i);
    expect(execMock).not.toHaveBeenCalled();
  });

  test("a reported close failure does not mark a named session as closed", async () => {
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } },
      { success: true, data: { title: "Example" } },
      { success: false, error: "close failed" },
    ]);
    const tool = createJevBrowserTool(env);
    await tool.execute(
      "first",
      {
        label: "test",
        url: "https://example.com",
        commands: [["get", "title"]],
        close: true,
      },
      undefined,
    );

    execMock.mockReset();
    mockAgentBrowser([{ success: true, data: { title: "Still open" } }]);
    await expect(
      tool.execute("reuse", { label: "test", commands: [["get", "title"]] }, undefined),
    ).resolves.toBeDefined();
  });

  test("serializes concurrent calls from one runner to avoid parallel Chromium bursts", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolveStarted) => {
      execMock.mockImplementation(async () => {
        if (!releaseFirst) {
          resolveStarted();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return { stdout: JSON.stringify({ success: true, data: {} }), stderr: "", code: 0 };
      });
    });
    const tool = createJevBrowserTool(env);
    const first = tool.execute(
      "first-call",
      { label: "test", commands: [["get", "title"]] },
      undefined,
    );
    await firstStarted;
    const second = tool.execute(
      "second-call",
      { label: "test", commands: [["get", "title"]] },
      undefined,
    );
    await Promise.resolve();
    expect(sentCommands().map((call) => (call as [string])[0])).toEqual([
      "'agent-browser' '--session' 'S' 'get' 'title' '--json'",
    ]);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(sentCommands().map((call) => (call as [string])[0])).toEqual([
      "'agent-browser' '--session' 'S' 'get' 'title' '--json'",
      "'agent-browser' '--session' 'S' 'get' 'title' '--json'",
    ]);
  });

  test("an explicit close: false keeps the browser open", async () => {
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } },
      { success: true, data: { path: "/tmp/shot.png" } },
    ]);

    const tool = createJevBrowserTool(env);
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

  test("reports browserContinuity as NOT continuous when the thread's browser was relaunched", async () => {
    const tool = createJevBrowserTool(env);
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } },
      { success: true, data: {} },
    ]);
    await tool.execute(
      "open",
      { label: "test", url: "https://example.com", commands: [["get", "title"]] },
      undefined,
    );
    execMock.mockReset();
    mockAgentBrowser([
      { success: true, data: { started: true, lifecycle: { reused: false, launched: true } } },
    ]);

    const result = await tool.execute(
      "call-2",
      { label: "test", commands: [["record", "start", "/tmp/demo.webm"]] },
      undefined,
    );

    expect(JSON.parse((result.content[0] as { text: string }).text).browserContinuity).toMatch(
      /NOT continuous/,
    );
  });

  test("reports browserContinuity as continuous when the thread's browser was reused", async () => {
    const tool = createJevBrowserTool(env);
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } },
      { success: true, data: {} },
    ]);
    await tool.execute(
      "open",
      { label: "test", url: "https://example.com", commands: [["record", "start", "/tmp/a.webm"]] },
      undefined,
    );
    execMock.mockReset();
    mockAgentBrowser([
      { success: true, data: { path: "/tmp/demo.webm", lifecycle: { reused: true } } },
    ]);

    const result = await tool.execute(
      "call-2",
      { label: "test", commands: [["record", "stop"]] },
      undefined,
    );

    expect(JSON.parse((result.content[0] as { text: string }).text).browserContinuity).toMatch(
      /^continuous:/,
    );
  });

  test("quotes URL and eval argv literally, including shell substitutions", async () => {
    mockAgentBrowser([{ success: true, data: null, error: null }]);
    const signal = new AbortController().signal;
    await createJevBrowserTool(env).execute(
      "quoting",
      {
        label: "test",
        url: "https://example.com/a'b?q=$(echo url)&x=`echo query`",
        commands: [
          ["eval", "document.title = '$(echo eval)'; `echo script`"],
          ["eval", ""],
        ],
        close: true,
      },
      signal,
    );

    const prefix = "'agent-browser' '--session' 'S'";
    expect(sentCommands()).toEqual([
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
          answers: {
            operation: { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 },
          },
        }),
      );
    }
    const signal = new AbortController().signal;
    const result = await createJevBrowserTool(env).execute(
      "goal",
      { label: "test", goal: "Wait until ready", close: true },
      signal,
    );
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      status: "done",
      steps: 1,
      lastPageSnapshot: "Ready",
    });
    expect(sentCommands()).toEqual([
      ["'agent-browser' '--session' 'S' 'snapshot' '--json'", { timeout: 90, signal }],
      ["'agent-browser' '--session' 'S' 'wait' '1000' '--json'", { timeout: 90, signal }],
      ["'agent-browser' '--session' 'S' 'snapshot' '--json'", { timeout: 90, signal }],
      ["'agent-browser' '--session' 'S' 'close' '--json'", { timeout: 90, signal: undefined }],
    ]);
  });

  test("cleans up through the executor without the aborted signal after execution rejects", async () => {
    const controller = new AbortController();
    execMock
      .mockImplementationOnce(async () => {
        controller.abort();
        throw new Error("Browser command aborted");
      })
      .mockResolvedValueOnce({ stdout: '{"success":true}', stderr: "", code: 0 });

    await expect(
      createJevBrowserTool(env).execute(
        "abort",
        { label: "test", commands: [["eval", "1"]], close: true },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.signal.aborted).toBe(true);
    expect(sentCommands()).toEqual([
      [
        "'agent-browser' '--session' 'S' 'eval' '1' '--json'",
        { timeout: 90, signal: controller.signal },
      ],
      ["'agent-browser' '--session' 'S' 'close' '--json'", { timeout: 90, signal: undefined }],
    ]);
  });

  test("does not execute or clean up when the signal is already aborted", async () => {
    await expect(
      createJevBrowserTool(env).execute(
        "aborted",
        { label: "test", commands: [["snapshot"]], close: true },
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
    const result = await createJevBrowserTool(env).execute(
      "nonzero",
      {
        label: "test",
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
    const execution = createJevBrowserTool(env).execute(
      "missing",
      { label: "test", commands: [["snapshot"]] },
      undefined,
    );
    await expect(execution).rejects.toThrow(/agent-browser/i);
    await expect(execution).rejects.toThrow(/container/i);
    await expect(execution).rejects.toThrow(/install|provision/i);
    expect(sentCommands()).toEqual([
      ["'agent-browser' '--session' 'S' 'snapshot' '--json'", { timeout: 90, signal: undefined }],
    ]);
  });

  test("tools with different executors never cross-run", async () => {
    mockAgentBrowser([{ success: true, data: { owner: "first" }, error: null }]);
    const otherExec = vi.fn<ExecCall>().mockResolvedValue({
      stdout: JSON.stringify({ success: true, data: { owner: "second" }, error: null }),
      stderr: "",
      code: 0,
    });
    const otherEnv = fakeEnv(otherExec);
    const first = createJevBrowserTool(env);
    const second = createJevBrowserTool(otherEnv);
    const args = { label: "test", commands: [["get", "title"]] };
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
      "'agent-browser' '--session' 'S' 'get' 'title' '--json'",
      { timeout: 90, signal: undefined },
    ];
    expect(sentCommands()).toEqual([call, call]);
    expect(
      otherExec.mock.calls.map(([command, options]) => [
        command.replace(/'mikan-jb-[^']+'/, "'S'"),
        options,
      ]),
    ).toEqual([call]);
    expect(execMock.mock.calls[0]?.[0]).not.toBe(otherExec.mock.calls[0]?.[0]);
  });

  test.each([undefined, []])(
    "close-only sends exactly one close command (commands=%s)",
    async (commands) => {
      mockAgentBrowser([{ success: true, data: { closed: true } }]);
      const signal = new AbortController().signal;
      const tool = createJevBrowserTool(env);
      const result = await tool.execute(
        "close-only",
        { label: "Close", close: true, commands },
        signal,
      );
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
        status: "closed",
      });
      expect(sentCommands()).toEqual([
        ["'agent-browser' '--session' 'S' 'close' '--json'", { timeout: 90, signal }],
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test("close-only surfaces CLI failure without reporting closed or retrying cleanup", async () => {
    mockAgentBrowser([{ success: false, error: "close failed" }]);
    await expect(
      createJevBrowserTool(env).execute("close", { label: "Close", close: true }, undefined),
    ).rejects.toThrow("Failed to close the browser: close failed");
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  test("successful commands without lifecycle metadata report unknown, not execution failure", async () => {
    const tool = createJevBrowserTool(env);
    mockAgentBrowser([
      { success: true, data: { targetId: "t1" } },
      { success: true, data: {} },
    ]);
    await tool.execute(
      "open",
      { label: "test", url: "https://example.com", commands: [["get", "title"]] },
      undefined,
    );
    execMock.mockReset();
    mockAgentBrowser([{ success: true, data: { title: "Page" } }]);
    const result = await tool.execute(
      "read",
      { label: "Title", commands: [["get", "title"]] },
      undefined,
    );
    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.commandResults[0].success).toBe(true);
    expect(data.browserContinuity).toContain("did not provide sufficient lifecycle information");
    expect(data.browserContinuity).not.toContain("no agent-browser command completed");
  });

  test("rejects a call with neither goal nor commands", async () => {
    const tool = createJevBrowserTool(env);
    await expect(
      tool.execute("call-1", { label: "test", url: "https://example.com" }, undefined),
    ).rejects.toThrow(/Provide goal or commands/);
    expect(execMock).not.toHaveBeenCalled();
  });
});

function tab(tabId: string, active = false) {
  return { tabId, active, url: `https://${tabId}.test/` };
}

describe("jev_browser tabs", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  function answerBrowser(tabs: ReturnType<typeof tab>[]) {
    execMock.mockImplementation(async (command) => {
      const data = command.includes("'tab' 'list'") ? { tabs } : { targetId: "x" };
      return { stdout: JSON.stringify({ success: true, data, error: null }), stderr: "", code: 0 };
    });
  }

  async function openTwice(tabsAtSecondOpen: ReturnType<typeof tab>[]) {
    const tool = createJevBrowserTool(env);
    answerBrowser([tab("t1", true)]);
    await tool.execute(
      "first",
      { label: "test", url: "https://one.test/", commands: [["get", "title"]] },
      undefined,
    );
    execMock.mockReset();
    answerBrowser(tabsAtSecondOpen);
    const result = await tool.execute(
      "second",
      { label: "test", url: "https://next.test/", commands: [["get", "title"]] },
      undefined,
    );
    return JSON.parse((result.content[0] as { text: string }).text) as {
      closedOldTabs?: string[];
    };
  }

  test("the first url opens in the thread's browser and later urls open new tabs", async () => {
    await openTwice([tab("t1", true)]);

    expect(sentCommands().map((call) => (call as [string])[0])).toEqual([
      "'agent-browser' '--session' 'S' 'tab' 'list' '--json'",
      "'agent-browser' '--session' 'S' 'tab' 'new' '--json'",
      "'agent-browser' '--session' 'S' 'open' 'https://next.test/' '--json'",
      "'agent-browser' '--session' 'S' 'get' 'title' '--json'",
    ]);
  });

  test("opening a tab past the limit closes the oldest inactive tabs first and reports them", async () => {
    const parsed = await openTwice([tab("t4"), tab("t2"), tab("t7", true), tab("t5")]);

    const sent = sentCommands().map((call) => (call as [string])[0]);
    expect(sent.slice(1, 3)).toEqual([
      "'agent-browser' '--session' 'S' 'tab' 'close' 't2' '--json'",
      "'agent-browser' '--session' 'S' 'tab' 'close' 't4' '--json'",
    ]);
    expect(sent.slice(3, 5)).toEqual([
      "'agent-browser' '--session' 'S' 'tab' 'new' '--json'",
      "'agent-browser' '--session' 'S' 'open' 'https://next.test/' '--json'",
    ]);
    expect(parsed.closedOldTabs).toEqual(["https://t2.test/", "https://t4.test/"]);
  });

  test("a call within the limit closes no tab and reports none", async () => {
    const parsed = await openTwice([tab("t1"), tab("t2", true)]);

    expect(sentCommands().some((call) => (call as [string])[0].includes("'tab' 'close'"))).toBe(
      false,
    );
    expect(parsed).not.toHaveProperty("closedOldTabs");
  });
});

describe("describeContinuity", () => {
  test("reports unknown when the CLI omits lifecycle metadata", () => {
    expect(describeContinuity(true, undefined)).toMatch(/^unknown:/);
  });

  test("reports new for the call that starts the thread's browser", () => {
    expect(describeContinuity(false, { reused: false })).toMatch(/^new:/);
  });

  test("reports continuous when the thread's browser was reused", () => {
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
