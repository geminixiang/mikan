import MarkdownIt from "markdown-it";

interface CurrencyBoundary {
  inline: string;
  offset: number;
}
interface NormalizeEnv {
  boundaries: CurrencyBoundary[];
}

const parser = new MarkdownIt({ html: false });
parser.inline.ruler.before("emphasis", "slack_currency_boundary", (state) => {
  if (
    state.src.startsWith("**$", state.pos) &&
    /[0-9]/.test(state.src[state.pos + 3] ?? "") &&
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\uFF01-\uFF60]/u.test(
      state.src[state.pos - 1] ?? "",
    )
  ) {
    const env = state.env as NormalizeEnv;
    env.boundaries.push({ inline: state.src, offset: state.pos });
  }
  return false;
});

export function normalizeSlackCurrencyBold(source: string): string {
  if (!source.includes("**$")) return source;
  const env: NormalizeEnv = { boundaries: [] };
  const tokens = parser.parse(source, env);
  if (env.boundaries.length === 0) return source;
  const lines = source.split("\n");
  const lineOffsets = [0];
  for (const line of lines) lineOffsets.push(lineOffsets.at(-1)! + line.length + 1);
  const insertions = new Set<number>();
  for (const token of tokens) {
    if (token.type !== "inline" || !token.map) continue;
    const start = lineOffsets[token.map[0]]!;
    const end = lineOffsets[token.map[1]]!;
    const index = source.indexOf(token.content, start);
    if (index < start || index + token.content.length > end) continue;
    for (const boundary of env.boundaries) {
      if (boundary.inline === token.content) insertions.add(index + boundary.offset);
    }
  }
  let result = source;
  for (const index of [...insertions].toSorted((a, b) => b - a)) {
    result = `${result.slice(0, index)} ${result.slice(index)}`;
  }
  return result;
}
