import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ConversationEvent } from "../src/adapter.js";
import { saveConversationAutoReplyConfig } from "../src/config.js";
import { decideTrigger, evaluateAutoReplyPolicy } from "../src/trigger.js";
import { createOfficeAddress, officeDirName } from "../src/office-address.js";

const C123_OFFICE = officeDirName(createOfficeAddress("slack", "C123"));

describe("decideTrigger", () => {
  test("trivially triggers mention, direct, and thread continuation intents", () => {
    expect(decideTrigger("mention")).toEqual({ trigger: true, reason: "mention" });
    expect(decideTrigger("direct")).toEqual({ trigger: true, reason: "direct" });
    expect(decideTrigger("thread-continuation")).toEqual({
      trigger: true,
      reason: "thread-continuation",
    });
  });
});

describe("evaluateAutoReplyPolicy", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-trigger-test-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  const event: ConversationEvent = {
    type: "mention",
    address: createOfficeAddress("slack", "C123"),
    conversationId: "C123",
    conversationKind: "shared",
    ts: "1",
    user: "U123",
    text: "please deploy staging",
    sessionKey: "C123:1",
  };

  test("skips by default when no config exists", async () => {
    await expect(evaluateAutoReplyPolicy({ event, workingDir })).resolves.toEqual({
      trigger: false,
      reason: "auto-reply-disabled",
    });
  });

  test("triggers when enabled and rules match", async () => {
    saveConversationAutoReplyConfig(join(workingDir, C123_OFFICE), {
      enabled: true,
      rules: ["Reply when the user asks about deployments."],
    });

    await expect(
      evaluateAutoReplyPolicy({
        event,
        workingDir,
        judge: async ({ rules }) => {
          expect(rules).toEqual(["Reply when the user asks about deployments."]);
          return true;
        },
      }),
    ).resolves.toEqual({ trigger: true, reason: "auto-reply-rule-match" });
  });

  test("skips when enabled rules do not match", async () => {
    saveConversationAutoReplyConfig(join(workingDir, C123_OFFICE), {
      enabled: true,
      rules: ["Reply only for urgent incidents."],
    });

    await expect(
      evaluateAutoReplyPolicy({ event, workingDir, judge: async () => false }),
    ).resolves.toEqual({ trigger: false, reason: "auto-reply-rule-no-match" });
  });

  test("triggers without judge when enabled but no rules set", async () => {
    saveConversationAutoReplyConfig(join(workingDir, C123_OFFICE), { enabled: true, rules: [] });
    await expect(evaluateAutoReplyPolicy({ event, workingDir })).resolves.toEqual({
      trigger: true,
      reason: "auto-reply-enabled",
    });
  });

  test("does not throw when the judge throws — falls back to no trigger", async () => {
    saveConversationAutoReplyConfig(join(workingDir, C123_OFFICE), {
      enabled: true,
      rules: ["some rule"],
    });

    await expect(
      evaluateAutoReplyPolicy({
        event,
        workingDir,
        judge: async () => {
          throw new Error("upstream LLM down");
        },
      }),
    ).resolves.toEqual({ trigger: false, reason: "auto-reply-judge-failed" });
  });

  test("ignores settings.json auto-reply state and uses marker files", async () => {
    const conversationDir = join(workingDir, C123_OFFICE);
    mkdirSync(conversationDir, { recursive: true });
    writeFileSync(join(conversationDir, "settings.json"), "{ not valid json", "utf-8");

    await expect(evaluateAutoReplyPolicy({ event, workingDir })).resolves.toEqual({
      trigger: false,
      reason: "auto-reply-disabled",
    });
  });

  test("times out a slow judge and returns no trigger", async () => {
    saveConversationAutoReplyConfig(join(workingDir, C123_OFFICE), {
      enabled: true,
      rules: ["some rule"],
    });

    await expect(
      evaluateAutoReplyPolicy({
        event,
        workingDir,
        timeoutMs: 10,
        judge: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 200)),
      }),
    ).resolves.toEqual({ trigger: false, reason: "auto-reply-judge-timeout" });
  });
});
