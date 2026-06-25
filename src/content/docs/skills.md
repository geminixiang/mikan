---
title: Skills
description: Load locations, sandbox paths, and tool structure for workspace-level and conversation-level skills.
---

| Level                             | Purpose                                                    | Host path                                           | Runtime path inside sandbox                        |
| --------------------------------- | ---------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------- |
| Workspace-level (global skills)   | Shared tools available to all conversations in a workspace | `<workspace>/skills/<skill-name>/`                  | `/workspace/skills/<skill-name>/`                  |
| Conversation-level (local skills) | Tools for one conversation / channel / DM only             | `<workspace>/<conversationId>/skills/<skill-name>/` | `/workspace/<conversationId>/skills/<skill-name>/` |

:::note
mikan loads workspace-level skills first, then conversation-level skills. If both sides define the same `name`, the conversation-level skill overrides the workspace-level skill.
:::

## Directory structure

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

Each skill directory needs a `SKILL.md`:

```yaml
---
name: my-tool
description: Does something useful
---

Usage: {baseDir}/run.sh <args>
```

`name` and `description` are required. To reference files inside the skill directory in the description, use `{baseDir}`; mikan replaces it with that skill's runtime path.

## Which level to use

Workspace-level skills are good for shared tools: company APIs, common scripts, release helpers, reporting tools, or any capability used by multiple conversations.

Conversation-level skills are good for local tools: a specific channel workflow, a temporary helper, or tools that should not appear in other conversations.
