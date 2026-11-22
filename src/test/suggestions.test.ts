import { describe, expect, test, vi } from "vitest";
import { createRunState, finalizeRunResponse } from "../harness/presenter.js";
import type { MikanAgentSession } from "../harness/session.js";
import { splitSuggestions, SUGGESTED_REPLIES_PROMPT } from "../harness/suggestions.js";
import type { ConversationResponder } from "../types.js";

describe("splitSuggestions", () => {
  test("takes the trailing marked lines off the text", () => {
    expect(
      splitSuggestions("Here is the draft.\n\n↳ Make it shorter\n  ↳   More formal  \n"),
    ).toEqual({ text: "Here is the draft.", suggestions: ["Make it shorter", "More formal"] });
  });

  test("keeps the first two of more lines and removes all of them from the text", () => {
    expect(splitSuggestions("Plan.\n↳ one\n↳ two\n↳ three")).toEqual({
      text: "Plan.",
      suggestions: ["one", "two"],
    });
  });

  test("leaves a marked line that is not at the end in the text", () => {
    const text = "Steps:\n↳ first do this\nThen you are done.";
    expect(splitSuggestions(text)).toEqual({ text, suggestions: [] });
    expect(splitSuggestions("Steps:\n↳ first\nDone.\n↳ next")).toEqual({
      text: "Steps:\n↳ first\nDone.",
      suggestions: ["next"],
    });
  });

  test("returns a reply without marked lines unchanged", () => {
    const text = "404 means not found.\n\n";
    expect(splitSuggestions(text)).toEqual({ text, suggestions: [] });
  });

  test("drops marked lines that hold nothing", () => {
    expect(splitSuggestions("Done.\n↳\n↳ again")).toEqual({
      text: "Done.",
      suggestions: ["again"],
    });
    expect(splitSuggestions("Done.\n↳  ")).toEqual({ text: "Done.", suggestions: [] });
  });

  test("never blanks a reply that is only marked lines", () => {
    const text = "↳ one\n↳ two";
    expect(splitSuggestions(text)).toEqual({ text, suggestions: [] });
  });
});

function sessionAnswering(text: string): MikanAgentSession {
  const session: Pick<MikanAgentSession, "lastRunMessages"> = {
    lastRunMessages: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
      } as MikanAgentSession["lastRunMessages"][number],
    ],
  };
  return session as MikanAgentSession;
}

function makeResponder() {
  const replaceResponse = vi.fn<ConversationResponder["replaceResponse"]>(async () => undefined);
  const responder: ConversationResponder = {
    replaceResponse,
    respond: async () => undefined,
    respondDiagnostic: async () => undefined,
    setTyping: async () => undefined,
    setWorking: async () => undefined,
    uploadFile: async () => undefined,
    deleteResponse: async () => undefined,
  };
  return { responder, replaceResponse };
}

describe("the final response", () => {
  test("hands the marked lines to the adapter as suggestions, before the signature", async () => {
    const { responder, replaceResponse } = makeResponder();
    const runState = { ...createRunState(), triggerAttribution: "@alice" };

    await finalizeRunResponse(
      responder,
      sessionAnswering("Here is the draft.\n\n↳ Make it shorter\n↳ More formal"),
      runState,
    );

    expect(replaceResponse).toHaveBeenCalledExactlyOnceWith(
      "Here is the draft.\n\n_Triggered by @alice_",
      {
        createOverflowLink: undefined,
        final: true,
        suggestions: ["Make it shorter", "More formal"],
      },
    );
  });

  test("carries no suggestions for a reply without marked lines", async () => {
    const { responder, replaceResponse } = makeResponder();

    await finalizeRunResponse(responder, sessionAnswering("Paris."), createRunState());

    expect(replaceResponse.mock.calls[0]).toStrictEqual([
      "Paris.",
      { createOverflowLink: undefined, final: true, suggestions: undefined },
    ]);
  });
});

test("the prompt section is the measured wording", () => {
  expect(SUGGESTED_REPLIES_PROMPT).toBe(`
## Suggested replies
A reply that hands the person something to use or choose from (a draft, a rewrite, a plan, a schedule, a list of ideas or questions, options with a recommendation, steps) always ends with one or two lines starting with ↳: what they would most likely send next, in their words. They become buttons, so the person taps instead of typing.
- After the draft of a leave email: ↳ 改短一點 and ↳ 語氣正式一點.
- After a step-by-step plan: ↳ 第二步說詳細一點 and ↳ 幫我排成一週的時程.
- After "404 means the page was not found": nothing. A fact, a definition, a yes-or-no answer, small talk and thanks get no ↳ lines.
- After "要寄給誰？新的時間是？": nothing. When you ask the person for something, the reply ends with your question. A ↳ line is sent as written, so it never holds an answer you guessed or a placeholder.
Never ↳ 謝謝 or ↳ 好的.`);
});
