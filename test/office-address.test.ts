import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createConversationEvent, createConversationMessage } from "../src/adapter.js";
import {
  assertConversationId,
  assertOfficeKey,
  conversationOfficeDir,
  createOfficeAddress,
  isOfficeKey,
  legacyConversationDir,
  officeDir,
  officeDirName,
  officeKey,
  officeStateDir,
  sameOffice,
  validateOfficeAddress,
} from "../src/office-address.js";

describe("office address", () => {
  test("normalizes events and messages and rejects mismatched supplied addresses", () => {
    const slack = createOfficeAddress("slack", "C123");
    const event = createConversationEvent({
      platform: "slack",
      conversationId: "C123",
      type: "message",
      conversationKind: "shared",
      ts: "1",
      user: "U1",
      text: "hello",
    });
    const message = createConversationMessage({
      platform: "slack",
      conversationId: "C123",
      id: "1",
      sessionKey: "C123",
      conversationKind: "shared",
      userId: "U1",
      text: "hello",
    });

    expect(event.address).toEqual(slack);
    expect(message.address).toEqual(slack);
    expect(() =>
      createConversationEvent({
        platform: "slack",
        conversationId: "C123",
        address: createOfficeAddress("discord", "C123"),
        type: "message",
        conversationKind: "shared",
        ts: "1",
        user: "U1",
        text: "hello",
      }),
    ).toThrow(/address mismatch/);
  });

  test("derives a deterministic versioned key from platform and raw id", () => {
    const address = createOfficeAddress("slack", "C123");

    expect(officeKey(address)).toBe("v1-slack-c123-f1bbf4ab194ff2ea");
    expect(officeKey(address)).toBe(
      `v1-slack-c123-${createHash("sha256")
        .update("office-address-v1\0slack\0C123")
        .digest("hex")
        .slice(0, 16)}`,
    );
    expect(isOfficeKey(officeKey(address))).toBe(true);
    expect(assertOfficeKey(officeKey(address))).toBe(officeKey(address));
  });

  test("separates same raw id across platforms", () => {
    expect(officeKey(createOfficeAddress("slack", "C123"))).not.toBe(
      officeKey(createOfficeAddress("discord", "C123")),
    );
    expect(
      sameOffice(createOfficeAddress("slack", "C123"), createOfficeAddress("slack", "C123")),
    ).toBe(true);
    expect(
      sameOffice(createOfficeAddress("slack", "C123"), createOfficeAddress("discord", "C123")),
    ).toBe(false);
  });

  test("does not use punctuation-cleaning as identity", () => {
    const left = createOfficeAddress("slack", "foo:bar");
    const right = createOfficeAddress("slack", "foo.bar");

    expect(officeKey(left)).not.toBe(officeKey(right));
    expect(officeKey(left)).toMatch(/^v1-slack-foo-bar-[a-f0-9]{16}$/);
    expect(officeKey(right)).toMatch(/^v1-slack-foo-bar-[a-f0-9]{16}$/);
  });

  test("accepts negative Telegram ids", () => {
    expect(officeKey(createOfficeAddress("telegram", "-1001234567890"))).toBe(
      "v1-telegram-1001234567890-53db752ab26cabc6",
    );
  });

  test.each([
    "",
    ".",
    "..",
    "foo/bar",
    String.raw`foo\bar`,
    "bad\u0000id",
    "bad\u001fid",
    "bad\u007fid",
  ])("rejects path-dangerous raw id %j", (conversationId) => {
    expect(() => createOfficeAddress("slack", conversationId)).toThrow();
    expect(() => assertConversationId(conversationId)).toThrow();
  });

  test("validates runtime address values and keeps paths under supplied roots", () => {
    const address = validateOfficeAddress({
      platform: "slack",
      conversationId: "../outside".replace("/", "-"),
    });
    const workspacePath = officeDir("/var/lib/mikan/workspace", address);
    const statePath = officeStateDir("/var/lib/mikan/state", address);

    expect(workspacePath).toMatch(/^\/var\/lib\/mikan\/workspace\/v1-slack-/);
    expect(statePath).toMatch(/^\/var\/lib\/mikan\/state\/conversations\/v1-slack-/);
    expect(workspacePath).not.toContain("/../");
  });

  test("rejects unsupported platforms and malformed addresses", () => {
    expect(() => createOfficeAddress("matrix" as never, "C1")).toThrow(/Unsupported platform/);
    expect(() => validateOfficeAddress({ platform: "slack", conversationId: 123 })).toThrow(
      /conversation id must be a string/,
    );
    expect(isOfficeKey("v1-slack-c123-not-a-key")).toBe(false);
  });

  describe("current office dir seam (pre-migration layout)", () => {
    // These pin the legacy layout the ADR 0005 storage migration will flip:
    // when officeDirName switches to the office key, this block is the one
    // place that changes.
    const address = createOfficeAddress("slack", "C123");

    test("host dir and runtime segment agree on the office name", () => {
      expect(officeDirName(address)).toBe("C123");
      expect(conversationOfficeDir("/data/workspace", address)).toBe("/data/workspace/C123");
    });

    test("legacy raw-id bridge resolves the same directory", () => {
      expect(legacyConversationDir("/data/workspace", "C123")).toBe(
        conversationOfficeDir("/data/workspace", address),
      );
      expect(() => legacyConversationDir("/data/workspace", "../escape")).toThrow(
        /path separators/,
      );
    });
  });
});
