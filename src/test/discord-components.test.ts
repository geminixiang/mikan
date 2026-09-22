import { ComponentType, MessageFlags } from "discord.js";
import { describe, expect, test } from "vitest";
import { DISCORD_V2_TEXT_LIMIT, discordTextPayload } from "../adapters/discord/components.js";

describe("discordTextPayload", () => {
  test("carries the flag that makes components render", () => {
    const payload = discordTextPayload("hello");
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.flags).toBe(32768);
  });

  test("puts the text in a Text Display, not content", () => {
    const payload = discordTextPayload("**bold** and `code`");
    expect(payload.components).toEqual([
      { type: ComponentType.TextDisplay, content: "**bold** and `code`" },
    ]);
    expect(payload).not.toHaveProperty("content");
  });

  test("uses one display, because the budget is shared not multiplied", () => {
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
