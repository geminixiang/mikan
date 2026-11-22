const SUGGESTION_MARK = "↳";
const MAX_SUGGESTIONS = 2;

export const SUGGESTED_REPLIES_PROMPT = `
## Suggested replies
A reply that hands the person something to use or choose from (a draft, a rewrite, a plan, a schedule, a list of ideas or questions, options with a recommendation, steps) always ends with one or two lines starting with ${SUGGESTION_MARK}: what they would most likely send next, in their words. They become buttons, so the person taps instead of typing.
- After the draft of a leave email: ${SUGGESTION_MARK} 改短一點 and ${SUGGESTION_MARK} 語氣正式一點.
- After a step-by-step plan: ${SUGGESTION_MARK} 第二步說詳細一點 and ${SUGGESTION_MARK} 幫我排成一週的時程.
- After "404 means the page was not found": nothing. A fact, a definition, a yes-or-no answer, small talk and thanks get no ${SUGGESTION_MARK} lines.
- After "要寄給誰？新的時間是？": nothing. When you ask the person for something, the reply ends with your question. A ${SUGGESTION_MARK} line is sent as written, so it never holds an answer you guessed or a placeholder.
Never ${SUGGESTION_MARK} 謝謝 or ${SUGGESTION_MARK} 好的.`;

export function splitSuggestions(text: string): { text: string; suggestions: string[] } {
  const lines = text.trimEnd().split("\n");
  const firstMarked = lines.findLastIndex((line) => !line.trim().startsWith(SUGGESTION_MARK)) + 1;
  const body = lines.slice(0, firstMarked).join("\n").trimEnd();
  if (firstMarked === lines.length || !body) return { text, suggestions: [] };
  const suggestions = lines
    .slice(firstMarked)
    .map((line) => line.trim().slice(SUGGESTION_MARK.length).trim())
    .filter(Boolean)
    .slice(0, MAX_SUGGESTIONS);
  return { text: body, suggestions };
}
