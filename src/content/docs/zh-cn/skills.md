---
title: Skills
---

# Skills

mikan loads custom CLI tools from two `skills/` locations:

| Level                             | Purpose                                                         | Host path                                           | Runtime path in sandbox                            |
| --------------------------------- | --------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------- |
| Workspace-level (global skills)   | Reusable tools available to every conversation in the workspace | `<workspace>/skills/<skill-name>/`                  | `/workspace/skills/<skill-name>/`                  |
| Conversation-level (local skills) | Tools only for one conversation/channel/DM                      | `<workspace>/<conversationId>/skills/<skill-name>/` | `/workspace/<conversationId>/skills/<skill-name>/` |

:::note
Workspace-level skills are loaded first. Conversation-level skills are loaded second and override a workspace skill with the same `name`.
:::

## Directory layout

```text
<workspace>/
├── skills/
│   └── my-global-tool/
│       ├── SKILL.md
│       └── run.sh
└── <conversationId>/
    └── skills/
        └── my-local-tool/
            ├── SKILL.md
            └── run.sh
```

Each skill directory needs a `SKILL.md` file:

```yaml
---
name: my-tool
description: Does something useful
---

Usage: {baseDir}/run.sh <args>
```

`name` and `description` are required. Use `{baseDir}` in instructions when referring to files inside the skill directory; mikan replaces it with the runtime path for that skill.

## When to use each level

Use workspace-level skills for shared tools: company APIs, common scripts, release helpers, reporting tools, or anything useful across multiple conversations.

Use conversation-level skills for local tools: channel-specific workflows, temporary helpers, or a tool that should not appear in other conversations.
