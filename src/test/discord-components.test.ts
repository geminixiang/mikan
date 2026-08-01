import { ComponentType, MessageFlags } from "discord.js";
import { describe, expect, test } from "vitest";
import { DISCORD_V2_TEXT_LIMIT, discordTextPayload } from "../adapters/discord/components.js";

/**
 * Components V2 is a per-message choice that cannot be undone: once a message
 * carries the flag, `content` stops working on it forever. A send path that
 * built a classic payload would therefore produce a message that can never be
 * edited again — so every path builds its payload here, and these tests pin
 * the shape that makes that safe.
 */
describe("discordTextPayload", () => {
  test("carries the flag that makes components render", () => {
    const payload = discordTextPayload("hello");
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    // 1 << 15, spelled out: the wire value is what Discord actually keys on.
    expect(payload.flags).toBe(32768);
  });

  test("puts the text in a Text Display, not content", () => {
    const payload = discordTextPayload("**bold** and `code`");
    expect(payload.components).toEqual([
      { type: ComponentType.TextDisplay, content: "**bold** and `code`" },
    ]);
    // `content` is dead on a V2 message; sending it would silently show nothing.
    expect(payload).not.toHaveProperty("content");
  });

  test("uses one display, because the budget is shared not multiplied", () => {
    // The 4000 limit is the sum across a message's text, so extra displays buy
    // layout and no extra room. One keeps the markdown rendering identical to
    // what `content` produced.
    const payload = discordTextPayload("x".repeat(3000));
    expect(payload.components).toHaveLength(1);
  });

  test("leaves markdown untouched for Discord to render", () => {
    const markdown = "# Heading\n- item\n```js\ncode\n```\n||spoiler||";
    expect(discordTextPayload(markdown).components[0]?.content).toBe(markdown);
  });

  test("the ceiling is double what classic content allowed", () => {
    expect(DISCORD_V2_TEXT_LIMIT).toBe(4000);
    expect(DISCORD_V2_TEXT_LIMIT).toBeGreaterThan(2000);
  });
});
