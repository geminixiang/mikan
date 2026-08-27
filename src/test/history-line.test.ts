import { describe, expect, test } from "vitest";
import { formatHistoryLine, stripHistoryLinePrefix } from "../sessions/history-line.js";

describe("history-line grammar", () => {
  test("round-trip: strip(format(text)) returns the original text", () => {
    const texts = [
      "hello world",
      "multi\nline\ntext",
      "text with [brackets] and: colons",
      "[2020-01-01 00:00:00+00:00] looks like a prefix but is payload",
    ];
    for (const text of texts) {
      const line = formatHistoryLine({
        date: new Date(),
        userName: "alice",
        threadTs: "1000.0001",
        text,
      });
      expect(stripHistoryLinePrefix(line)).toBe(text.trim());
    }
  });

  test("round-trips without a thread suffix", () => {
    const line = formatHistoryLine({ date: new Date(), userName: "bob", text: "hi" });
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] \[bob\]: hi$/);
    expect(stripHistoryLinePrefix(line)).toBe("hi");
  });

  test("missing user name renders as unknown", () => {
    const line = formatHistoryLine({ date: new Date(), text: "hi" });
    expect(line).toContain("[unknown]: hi");
    expect(stripHistoryLinePrefix(line)).toBe("hi");
  });

  test("timestampless lines are written without a bracket and left unstripped", () => {
    const line = formatHistoryLine({ userName: "carol", text: "hi" });
    expect(line).toBe("[carol]: hi");
    expect(stripHistoryLinePrefix(line)).toBe("[carol]: hi");
  });

  test("an invalid Date degrades to a timestampless line instead of writing garbage", () => {
    const line = formatHistoryLine({ date: new Date(Number.NaN), userName: "dave", text: "hi" });
    expect(line).toBe("[dave]: hi");
  });

  test("plain text without a prefix passes through", () => {
    expect(stripHistoryLinePrefix("no prefix here")).toBe("no prefix here");
  });
});
