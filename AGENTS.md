# Development Rules

## Conversational Style

- Keep answers short and concise.
- No fluff or cheerful filler text.
- Technical prose only; be kind but direct.
- Match the user's language when practical.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or analysis, explicitly say whether you agree or disagree before saying what changed.

## Coding Rules

- Prefer LBYL (Look Before You Leap) in implementation code: validate preconditions before performing operations when those checks are reliable and do not introduce race conditions.
- Use EAFP only when LBYL would introduce TOCTOU races, duplicate expensive work, or make error handling less clear.
- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- Make surgical changes only; avoid unrelated cleanup.
- Preserve existing behavior unless the user explicitly asks to change it.
- Do not remove intentional-looking functionality without asking first.
- Reuse existing helpers and project patterns before adding new abstractions.
- Avoid thin wrappers — functions that only delegate without adding logic, error handling, or meaningful abstraction. Inline them unless they have multiple call sites or encapsulate a non-trivial concern.
- Delete indirection rather than polish it. If behavior is unchanged, always prefer the simpler structure.
- Avoid `any` unless there is no practical typed alternative.
- Check dependency type definitions in `node_modules` instead of guessing external APIs.
- Use top-level imports; avoid inline/dynamic imports for normal code and type references.

## Verification

- After code changes, run the relevant test or check command.
- If unsure which command applies, inspect `package.json` first.
- For documentation-only changes, tests are not required unless requested.
- Report what was changed and what verification was run.

## Dependency and Install Security

- Treat dependency and lockfile changes as reviewed code.
- Do not add or update dependencies without user approval.
- Use `npm install --ignore-scripts` or `npm ci --ignore-scripts` unless lifecycle scripts are explicitly required.

## User Override

- If the user's instructions conflict with this document, ask for explicit confirmation before overriding.
