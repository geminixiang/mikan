import { afterEach, expect, test, vi } from "vitest";
import * as Sentry from "@sentry/node";
import { SlackMessagingBot } from "../adapters/slack/bot.js";
import { renderSlackBlocks } from "../adapters/slack/blocks.js";
import { recordSlackUpdate } from "../adapters/slack/update-diagnostics.js";
import { sanitizeBreadcrumb } from "../observability/sentry.js";

vi.mock("@sentry/node", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/node")>()),
  addBreadcrumb: vi.fn(),
  logger: { info: vi.fn() },
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function setup() {
  const breadcrumb = vi.mocked(Sentry.addBreadcrumb).mockImplementation(() => {});
  const update = vi.fn().mockResolvedValue({ ok: true });
  const bot: SlackMessagingBot = Object.create(SlackMessagingBot.prototype);
  Object.assign(bot, { webClient: { chat: { update } }, users: new Map() });
  return { breadcrumb, update, bot };
}

test("records sanitized rejection and first recovery without changing payload, error, or attempts", async () => {
  const { breadcrumb, update, bot } = setup();
  const source = "```private-canary\n``` ...";
  const error = Object.assign(new Error("private-canary"), {
    data: {
      error: "block_mismatch",
      response_metadata: {
        messages: ["invalid private-canary https://secret.example at /blocks/0/text"],
      },
    },
  });
  update.mockRejectedValueOnce(error);
  await expect(bot.updateMessage("C1", "1.1", source)).rejects.toBe(error);
  expect(update).toHaveBeenCalledExactlyOnceWith({
    channel: "C1",
    ts: "1.1",
    ...renderSlackBlocks(source),
  });
  const rejected = sanitizeBreadcrumb(breadcrumb.mock.calls[0]![0]!);
  expect(rejected?.data).toMatchObject({
    errorCode: "block_mismatch",
    blockTypes: ["markdown"],
    leadingConstruct: "fence",
    fenceWithWorkingSuffix: true,
    validationCategories: ["invalid"],
    blockIndices: [0],
  });
  expect(JSON.stringify(breadcrumb.mock.calls)).not.toContain("private-canary");
  expect(JSON.stringify(breadcrumb.mock.calls)).not.toContain("secret.example");
  await bot.updateMessage("C1", "1.1", "complete");
  expect(breadcrumb).toHaveBeenCalledTimes(2);
  expect(breadcrumb.mock.calls[1]![0]).toMatchObject({
    message: "Slack update recovered",
    data: { failedAttempts: 1, responseMessageId: "1.1" },
  });
  expect(Sentry.logger.info).toHaveBeenCalledExactlyOnceWith(
    "Slack update recovered",
    expect.objectContaining({ failedAttempts: 1, responseMessageId: "1.1" }),
  );
  expect(JSON.stringify(vi.mocked(Sentry.logger.info).mock.calls)).not.toContain("private-canary");
  await bot.updateMessage("C1", "1.1", "later");
  expect(breadcrumb).toHaveBeenCalledTimes(2);
});

test("telemetry failure cannot replace transport error or reject success", async () => {
  const { breadcrumb, update, bot } = setup();
  breadcrumb.mockImplementation(() => {
    throw new Error("telemetry unavailable");
  });
  const failure = new Error("transport failed");
  update.mockRejectedValueOnce(failure);
  await expect(bot.updateMessage("C1", "1", "hello")).rejects.toBe(failure);
  await expect(bot.updateMessage("C1", "1", "hello")).resolves.toBeUndefined();
  expect(update).toHaveBeenCalledTimes(2);
});

test("correlation is bounded, expires, and cannot cross owners or messages", () => {
  const breadcrumb = vi.mocked(Sentry.addBreadcrumb).mockImplementation(() => {});
  const owner = {};
  const payload = renderSlackBlocks("hello");
  for (let index = 0; index < 129; index++)
    recordSlackUpdate(owner, { channel: "C1", ts: String(index) }, "hello", payload, {
      error: null,
    });
  breadcrumb.mockClear();
  recordSlackUpdate(owner, { channel: "C1", ts: "0" }, "hello", payload, { success: true });
  recordSlackUpdate({}, { channel: "C1", ts: "128" }, "hello", payload, { success: true });
  recordSlackUpdate(owner, { channel: "C2", ts: "128" }, "hello", payload, { success: true });
  expect(breadcrumb).not.toHaveBeenCalled();
  recordSlackUpdate(owner, { channel: "C1", ts: "128" }, "hello", payload, { success: true });
  expect(breadcrumb).toHaveBeenCalledOnce();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600_001);
  recordSlackUpdate(owner, { channel: "C1", ts: "127" }, "hello", payload, { success: true });
  expect(breadcrumb).toHaveBeenCalledOnce();
});
