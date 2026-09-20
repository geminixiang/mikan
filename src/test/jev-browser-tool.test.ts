import { describe, expect, test } from "vitest";
import {
  buildQuestionPlan,
  categorizeRefs,
  resolveTarget,
  truncate,
} from "../harness/tools/jev-browser.js";

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
    expect(operation && "criteria" in operation ? Object.keys(operation.criteria) : []).toEqual([
      "WAIT",
      "DONE",
      "BLOCKED",
    ]);
  });

  test("adds a scroll option only when the caller reports it is possible", () => {
    const { questions } = buildQuestionPlan({}, true, true);
    const operation = questions.operation;
    const keys = operation && "criteria" in operation ? Object.keys(operation.criteria) : [];
    expect(keys).toContain("SCROLL_DOWN");
    expect(keys).toContain("SCROLL_UP");
  });

  test("a single candidate for an operation resolves directly without a target question", () => {
    const refs = { e1: { role: "button", name: "Submit" } };
    const { questions, singles } = buildQuestionPlan(refs, false, false);
    expect(singles.CLICK).toBe("e1");
    expect(questions.click_target).toBeUndefined();
    expect(
      questions.operation && "criteria" in questions.operation
        ? questions.operation.criteria.CLICK
        : undefined,
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
      questions.click_target && "criteria" in questions.click_target
        ? questions.click_target.criteria
        : {};
    expect(Object.keys(criteria)).toEqual(["e1", "e2"]);
  });

  test("no click/type/select candidates omit those operations from the criteria", () => {
    const { questions } = buildQuestionPlan({}, false, false);
    const criteria =
      questions.operation && "criteria" in questions.operation ? questions.operation.criteria : {};
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
