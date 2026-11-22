import { expect, test } from "vitest";
import { renderSlackBlocks, resolveSlackMentions } from "../adapters/slack/blocks.js";

const USERS = [{ id: "U0000000001", userName: "alice", displayName: "Alice" }];

const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
const columns = Array.from({ length: 12 }, (_, index) => index);

const REPLIES: Record<string, string> = {
  prose: "Deployed **v2** to _staging_. ~~Old plan~~ dropped. See `config.yaml`.",
  headings: "# Summary\n\n## Details\n\nText under a heading.\n\n### Next\n\nMore.",
  lists: "- one\n- two\n  - nested\n- three\n\n1. first\n2. second",
  code: "Run this:\n\n```bash\nnpm test -- src/test/x.test.ts\n```\n\nand `inline` too.",
  links: "See [the docs](https://example.com/docs) and <https://example.com/legacy|legacy label>.",
  table: "| Name | Count |\n| --- | --- |\n| alpha | 1 |\n| beta | 22 |",
  indexedTable: "| # | Name |\n| --- | --- |\n| 1 | alpha |\n| 2 | beta |",
  wideTable: [
    row(columns.map((index) => `c${index}`)),
    row(columns.map(() => "---")),
    row(columns.map((index) => `v${index}`)),
  ].join("\n"),
  twoTables: "Before\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nBetween\n\n| C |\n| - |\n| 3 |\n\nAfter",
  currency: "Cost is **$1,200** and **$30** per seat.",
  mention: "Thanks <@alice>, cc <@U0123456789>.",
  quote: "> quoted line\n> second line\n\nplain after",
  mixed:
    '## Report\n\n- item **one**\n- item two\n\n| K | V |\n| - | - |\n| a | 1 |\n\n```json\n{"ok": true}\n```\n\n[link](https://example.com)',
};

test.each(Object.entries(REPLIES))(
  "an ordinary reply with %s converts to the same Slack blocks as before",
  (_name, source) => {
    expect(renderSlackBlocks(resolveSlackMentions(source, USERS))).toMatchSnapshot();
  },
);
