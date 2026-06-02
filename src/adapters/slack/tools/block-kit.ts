import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

type SlackBlockKitResponse = {
  text: string;
  blocks: object[];
};

const blockKitSchema = Type.Object({
  label: Type.String({ description: "Brief description of the Slack Block Kit response" }),
  text: Type.String({ description: "Plain-text fallback for notifications and non-Slack clients" }),
  blocks: Type.Array(Type.Unknown(), {
    description:
      "Slack Block Kit blocks. Supports section, context, divider, header, actions; buttons in actions.elements; static_select and multi_static_select in section.accessory.",
  }),
});

const ALLOWED_BLOCK_TYPES = new Set(["section", "context", "divider", "header", "actions"]);
const ALLOWED_INTERACTIVE_ELEMENT_TYPES = new Set([
  "button",
  "static_select",
  "multi_static_select",
]);

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function validateInteractiveElement(element: Record<string, unknown>, label: string): void {
  if (typeof element.type !== "string" || !ALLOWED_INTERACTIVE_ELEMENT_TYPES.has(element.type)) {
    return;
  }
  if (typeof element.action_id !== "string" || !element.action_id) {
    throw new Error(`${label}.action_id is required`);
  }
  if (element.type === "button" && typeof element.value !== "string") {
    throw new Error(`${label}.value is required for buttons`);
  }
}

function validateInteractiveElements(value: unknown, label: string): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateInteractiveElements(item, `${label}[${index}]`));
    return;
  }

  const obj = value as Record<string, unknown>;
  validateInteractiveElement(obj, label);
  for (const [key, nested] of Object.entries(obj)) {
    validateInteractiveElements(nested, `${label}.${key}`);
  }
}

function validateBlockPlacement(block: Record<string, unknown>, label: string): void {
  if (block.type === "actions") {
    if (!Array.isArray(block.elements)) throw new Error(`${label}.elements is required`);
    block.elements.forEach((element, index) => {
      assertPlainObject(element, `${label}.elements[${index}]`);
      if (element.type !== "button") {
        throw new Error(
          `${label}.elements[${index}] uses ${String(element.type)}; put static_select and multi_static_select in section.accessory instead`,
        );
      }
    });
  }

  if (block.type === "section" && block.accessory !== undefined) {
    assertPlainObject(block.accessory, `${label}.accessory`);
    const type = String(block.accessory.type);
    if (!ALLOWED_INTERACTIVE_ELEMENT_TYPES.has(type)) {
      throw new Error(`${label}.accessory has unsupported type: ${type}`);
    }
  }
}

function validateBlocks(blocks: unknown[]): object[] {
  if (blocks.length === 0) throw new Error("blocks must not be empty");
  if (blocks.length > 20) throw new Error("blocks must contain at most 20 blocks");

  return blocks.map((block, index) => {
    assertPlainObject(block, `blocks[${index}]`);
    const type = block.type;
    if (typeof type !== "string" || !ALLOWED_BLOCK_TYPES.has(type)) {
      throw new Error(`Unsupported Block Kit block type: ${String(type)}`);
    }
    validateBlockPlacement(block, `blocks[${index}]`);
    validateInteractiveElements(block, `blocks[${index}]`);
    return block;
  });
}

export function createSlackBlockKitTool(): {
  tool: AgentTool<typeof blockKitSchema>;
  setBlockKitResponseFunction: (fn: (response: SlackBlockKitResponse) => Promise<void>) => void;
} {
  let respondFn: ((response: SlackBlockKitResponse) => Promise<void>) | null = null;

  const tool: AgentTool<typeof blockKitSchema> = {
    name: "slack_blockkit",
    label: "slack block kit",
    description:
      "Send a Slack Block Kit response. Use when structured Slack UI helps the user choose or inspect information. Supports buttons, static_select, and multi_static_select. Put buttons in actions.elements. Put static_select and multi_static_select in section.accessory.",
    parameters: blockKitSchema,
    execute: async (
      _toolCallId: string,
      { text, blocks }: { label: string; text: string; blocks: unknown[] },
      signal?: AbortSignal,
    ) => {
      if (!respondFn) throw new Error("Slack Block Kit response function not configured");
      if (signal?.aborted) throw new Error("Operation aborted");

      await respondFn({ text, blocks: validateBlocks(blocks) });

      return {
        content: [{ type: "text" as const, text: "Sent Slack Block Kit response" }],
        details: undefined,
      };
    },
  };

  return {
    tool,
    setBlockKitResponseFunction: (fn) => {
      respondFn = fn;
    },
  };
}
