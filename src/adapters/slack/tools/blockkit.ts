import type { ToolRegistration } from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import type { SlackBlockKitOps } from "../types.js";
import { renderSlackBlocks } from "../blocks.js";
import { LABEL_PARAMETER } from "../../../harness/tools/host-fn-tool.js";

export const SLACK_BLOCKKIT_TOOL = "slack_blockkit";

const MAX_BUTTONS = 10;
const MAX_MENU_OPTIONS = 100;
const MAX_MESSAGE_BLOCKS = 50;
const BUTTON_TEXT_LIMIT = 75;
const VALUE_LIMIT = 2000;

const choice = (description: string) =>
  Type.Object({
    text: Type.String({ minLength: 1, maxLength: BUTTON_TEXT_LIMIT, description }),
    value: Type.String({
      minLength: 1,
      maxLength: VALUE_LIMIT,
      description: "What you receive when the person picks it.",
    }),
  });

const blockkitSchema = Type.Object({
  label: LABEL_PARAMETER,
  text: Type.String({
    minLength: 1,
    description:
      "The message, in the same Markdown as any reply: tables, lists, code blocks, and links render natively.",
  }),
  buttons: Type.Optional(
    Type.Array(
      Type.Object({
        ...choice("The button's caption.").properties,
        style: Type.Optional(
          Type.Union([Type.Literal("primary"), Type.Literal("danger")], {
            description: "primary for the recommended action, danger for a destructive one.",
          }),
        ),
      }),
      { maxItems: MAX_BUTTONS, description: "Buttons shown under the message." },
    ),
  ),
  menu: Type.Optional(
    Type.Object(
      {
        placeholder: Type.String({ minLength: 1, maxLength: 150 }),
        options: Type.Array(choice("The option as shown in the menu."), {
          minItems: 1,
          maxItems: MAX_MENU_OPTIONS,
        }),
        multiple: Type.Optional(
          Type.Boolean({ description: "Let the person pick several options." }),
        ),
      },
      { description: "A select menu shown under the message." },
    ),
  ),
  update_ts: Type.Optional(
    Type.String({
      description:
        "Replace a message this tool posted earlier in this conversation, for example to remove its buttons once someone has answered: give the new text and no buttons or menu.",
    }),
  ),
});

type BlockKitArgs = Static<typeof blockkitSchema>;

const plainText = (text: string) => ({ type: "plain_text", text });

function interactiveElements(args: BlockKitArgs): object[] {
  const buttons = (args.buttons ?? []).map((button, index) => ({
    type: "button",
    action_id: `button_${index + 1}`,
    text: plainText(button.text),
    value: button.value,
    style: button.style,
  }));
  if (!args.menu) return buttons;
  const options = args.menu.options.map((option) => ({
    text: plainText(option.text),
    value: option.value,
  }));
  return [
    ...buttons,
    {
      type: args.menu.multiple ? "multi_static_select" : "static_select",
      action_id: "menu",
      placeholder: plainText(args.menu.placeholder),
      options,
    },
  ];
}

function buildMessage(
  args: BlockKitArgs,
  ops: SlackBlockKitOps,
): { text: string; blocks: object[] } {
  const rendered = renderSlackBlocks(ops.resolveMentions(args.text));
  const elements = interactiveElements(args);
  if (elements.length === 0) return rendered;
  if (rendered.blocks.length >= MAX_MESSAGE_BLOCKS) {
    throw new Error(
      `The text renders to ${rendered.blocks.length} blocks, which leaves no room for the buttons. Shorten it or attach the long content as a file.`,
    );
  }
  return { text: rendered.text, blocks: [...rendered.blocks, { type: "actions", elements }] };
}

function refuseRawBlocks(args: unknown): unknown {
  if (args && typeof args === "object" && "blocks" in args) {
    throw new Error(
      "slack_blockkit no longer takes Block Kit JSON. Give the message as Markdown in `text` and the interactive elements in `buttons` or `menu`.",
    );
  }
  return args;
}

function formatSlackApiError(err: unknown): Error {
  const data = (
    err as { data?: { error?: string; response_metadata?: { messages?: string[] } } } | undefined
  )?.data;
  if (!data?.error) return err instanceof Error ? err : new Error(String(err));
  const details = data.response_metadata?.messages?.length
    ? `\n${data.response_metadata.messages.join("\n")}`
    : "";
  return new Error(`Slack rejected the request: ${data.error}${details}`);
}

export function createSlackBlockKitTool(): {
  tool: ToolRegistration<typeof blockkitSchema>;
  setSlackBlockKitOps: (ops: SlackBlockKitOps | null) => void;
} {
  let boundOps: SlackBlockKitOps | null = null;

  const tool: ToolRegistration<typeof blockkitSchema> = {
    name: SLACK_BLOCKKIT_TOOL,
    description:
      'Post a Slack message with buttons or a select menu, or replace one this tool posted. Use it only when the person should answer by clicking; a normal reply already renders Markdown, tables included. A click arrives as a "[Slack action] <id>: <value>" message.',
    parameters: blockkitSchema,
    prepareArguments: refuseRawBlocks as (args: unknown) => BlockKitArgs,
    execute: async (args, _api, { abortSignal: signal }) => {
      const ops = boundOps;
      if (!ops) {
        throw new Error("slack_blockkit is only available in Slack conversations");
      }
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      if (!args.update_ts && !args.buttons?.length && !args.menu) {
        throw new Error(
          "slack_blockkit is for messages people answer by clicking: give `buttons` or `menu`. For anything else, reply normally; your Markdown is rendered natively.",
        );
      }
      const message = buildMessage(args, ops);

      try {
        if (args.update_ts) {
          await ops.updateBlocks({ ts: args.update_ts, ...message });
          return {
            output: [
              { type: "text" as const, text: `Updated the message (ts: ${args.update_ts}).` },
            ],
            details: undefined,
          };
        }
        const { ts } = await ops.postBlocks(message);
        return {
          output: [
            {
              type: "text" as const,
              text: `Posted the message (ts: ${ts}). A click arrives as a "[Slack action] <id>: <value>" message; pass ts back as update_ts to replace this message.`,
            },
          ],
          details: undefined,
        };
      } catch (err) {
        throw formatSlackApiError(err);
      }
    },
  };

  return {
    tool,
    setSlackBlockKitOps: (ops) => {
      boundOps = ops;
    },
  };
}
