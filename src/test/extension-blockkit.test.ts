import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { namespaceActionIds, parseExtActionId } from "../harness/extensions/blockkit.js";
import { ExtensionRegistry } from "../harness/extensions/registry.js";
import { loadExtensions } from "../harness/extensions/loader.js";
import type { ExtensionBlockAction } from "../harness/extensions/types.js";
import { createOfficeAddress } from "../office/index.js";

let dir: string;

const testModel = { id: "test", name: "Test" } as Model<Api>;
const context = {
  address: createOfficeAddress("slack", "C123"),
  conversationId: "C123",
  workspaceDir: "/work",
  model: testModel,
  thinkingLevel: "off" as const,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-ext-blockkit-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("namespaceActionIds", () => {
  test("rewrites nested action_ids and leaves everything else untouched", () => {
    const blocks = [
      { type: "markdown", text: "Q" },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: "vote_0", value: "0" },
          { type: "static_select", action_id: "pick", options: [] },
        ],
      },
    ];
    const namespaced = namespaceActionIds(blocks, "poll") as typeof blocks;

    expect((namespaced[1] as { elements: { action_id: string }[] }).elements[0].action_id).toBe(
      "ext:poll:vote_0",
    );
    expect((namespaced[1] as { elements: { action_id: string }[] }).elements[1].action_id).toBe(
      "ext:poll:pick",
    );
    expect(namespaced[0]).toEqual({ type: "markdown", text: "Q" });
    // deep clone: the original is untouched
    expect((blocks[1] as { elements: { action_id: string }[] }).elements[0].action_id).toBe(
      "vote_0",
    );
  });
});

describe("parseExtActionId", () => {
  test("parses namespaced ids and rejects everything else", () => {
    expect(parseExtActionId("ext:poll:vote_0")).toEqual({ slug: "poll", actionId: "vote_0" });
    expect(parseExtActionId("ext:poll:with:colons")).toEqual({
      slug: "poll",
      actionId: "with:colons",
    });
    expect(parseExtActionId("vote_0")).toBeNull();
    expect(parseExtActionId("force_stop_C123")).toBeNull();
    expect(parseExtActionId("ext:poll")).toBeNull();
    expect(parseExtActionId("ext::vote")).toBeNull();
    expect(parseExtActionId("ext:poll:")).toBeNull();
  });
});

describe("ExtensionRegistry actions", () => {
  const action: ExtensionBlockAction = {
    actionId: "vote",
    value: "1",
    conversationId: "C123",
  };

  test("dispatches to the registered handler and reports consumption", async () => {
    const registry = new ExtensionRegistry();
    const handler = vi.fn();
    registry.registerAction("poll", "vote", handler);

    expect(await registry.dispatchAction("poll", action)).toBe(true);
    expect(handler).toHaveBeenCalledWith(action);
    expect(await registry.dispatchAction("poll", { ...action, actionId: "other" })).toBe(false);
    expect(await registry.dispatchAction("elsewhere", action)).toBe(false);
  });

  test("a throwing handler still counts as consumed", async () => {
    const registry = new ExtensionRegistry();
    registry.registerAction("poll", "vote", () => {
      throw new Error("boom");
    });
    expect(await registry.dispatchAction("poll", action)).toBe(true);
  });

  test("duplicate registration keeps the first handler", async () => {
    const registry = new ExtensionRegistry();
    const first = vi.fn();
    const second = vi.fn();
    registry.registerAction("poll", "vote", first);
    registry.registerAction("poll", "vote", second);

    await registry.dispatchAction("poll", action);
    expect(first).toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });
});

describe("api.blockkit", () => {
  test("post namespaces action_ids with the slug; onAction dispatches stripped ids", async () => {
    writeFileSync(
      join(dir, "voter.mjs"),
      `export default function activate(api) {
        api.blockkit.onAction("vote", (event) => { globalThis.blockkitTestAction = event; });
        globalThis.blockkitTestPost = () => api.blockkit.post({
          text: "Q",
          blocks: [{ type: "actions", elements: [{ type: "button", action_id: "vote", value: "1" }] }],
        });
      }\n`,
    );
    const postBlocks = vi.fn(async () => ({ ts: "100.1" }));
    const { registry, extensions, errors } = await loadExtensions({
      dirs: [dir],
      context,
      services: { postBlocks },
    });
    expect(errors).toEqual([]);
    const slug = extensions[0].slug;

    const { ts } = await (
      globalThis as unknown as { blockkitTestPost: () => Promise<{ ts: string }> }
    ).blockkitTestPost();
    expect(ts).toBe("100.1");
    expect(postBlocks).toHaveBeenCalledWith("C123", {
      text: "Q",
      blocks: [
        {
          type: "actions",
          elements: [{ type: "button", action_id: `ext:${slug}:vote`, value: "1" }],
        },
      ],
      threadTs: undefined,
    });

    const action: ExtensionBlockAction = {
      actionId: "vote",
      value: "1",
      userId: "U1",
      conversationId: "C123",
      messageTs: "100.1",
    };
    expect(await registry.dispatchAction(slug, action)).toBe(true);
    expect(
      (globalThis as unknown as { blockkitTestAction: ExtensionBlockAction }).blockkitTestAction,
    ).toEqual(action);
  });

  test("post and update throw an informative error without Block Kit services", async () => {
    writeFileSync(
      join(dir, "lonely.mjs"),
      `export default function activate(api) {
        globalThis.lonelyTestPost = () => api.blockkit.post({ text: "t", blocks: [] });
        globalThis.lonelyTestUpdate = () => api.blockkit.update("1.0", { text: "t", blocks: [] });
      }\n`,
    );
    const { errors } = await loadExtensions({ dirs: [dir], context, services: {} });
    expect(errors).toEqual([]);
    const g = globalThis as unknown as {
      lonelyTestPost: () => Promise<unknown>;
      lonelyTestUpdate: () => Promise<unknown>;
    };
    await expect(g.lonelyTestPost()).rejects.toThrow("api.blockkit is unavailable");
    await expect(g.lonelyTestUpdate()).rejects.toThrow("api.blockkit is unavailable");
  });
});
