# src/agent

Agent runner: prompt construction, path translation, per-run lifecycle, and
`createRunner` factory. Public imports should use `src/agent.ts`.

## Files

- `prompt.ts`: System/turn prompts, memory, skills, trigger attribution.
- `paths.ts`: Sandbox runtime path context and host/runtime path translation.
- `payload.ts`: User message + attachment payload for a turn.
- `run-lifecycle.ts`: Run state, response queue, finalize, usage metrics.
- `runner.ts`: `createRunner`, prepare-run, session event handlers, extensions.
