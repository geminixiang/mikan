---
title: Skills
description: Load locations, sandbox paths, and tool structure for workspace-level and conversation-level skills.
---

| Level                             | Purpose                                                    | Host path                                       | Runtime path inside sandbox                    |
| --------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| Workspace-level (global skills)   | Shared tools available to all conversations in a workspace | `<workspace>/skills/<skill-name>/`              | `/workspace/skills/<skill-name>/`              |
| Conversation-level (local skills) | Tools for one conversation / channel / DM only             | `<workspace>/<office-key>/skills/<skill-name>/` | `/workspace/<office-key>/skills/<skill-name>/` |

The office key is the `v1-<platform>-<readable-id>-<hash>` directory name mikan derives for each
conversation; you do not construct it by hand. The admin portal's skills view lists both levels,
including nested skill directories, can create a skill in either, and turns skills on and off.

:::note
mikan loads workspace-level skills first, then conversation-level skills. If both sides define the same `name`, the conversation-level skill overrides the workspace-level skill.
:::

:::note[Private offices read workspace-level skills]
Every conversation lists and reads workspace-level skills. A private office (a private channel, DM,
or any non-Slack conversation) mounts `/workspace/skills/` read-only, so it can use those skills but
creates its own in its office. See [Sandbox](/sandbox/).
:::

## Directory structure

```text
<workspace>/
├── skills/
│   └── my-global-tool/
│       ├── SKILL.md
│       └── run.sh
└── v1-slack-c0123456789-<digest>/
    └── skills/
        └── my-local-tool/
            ├── SKILL.md
            └── run.sh
```

A directory containing `SKILL.md` is treated as one skill root and is not searched recursively. mikan also discovers standalone `.md` files directly under a configured skills directory.

A directory-based skill uses `SKILL.md`:

```yaml
---
name: my-tool
description: Does something useful
---

Usage: {baseDir}/run.sh <args>
```

`name` and `description` are required. Use paths relative to the skill directory, or write the runtime-visible absolute path shown in the table above. `{baseDir}` is not expanded automatically.

## Which level to use

Workspace-level skills are good for shared tools: company APIs, common scripts, release helpers, reporting tools, or any capability used by multiple conversations. Only public offices can write them.

Conversation-level skills are good for local tools: a specific channel workflow, a temporary helper, or tools that should not appear in other conversations. Every office can write them, and they are the only writable level a private office has.

## Turning skills off

Every skill is listed in the system prompt by default. `skills` in the global or conversation
settings excludes skills with Pi's resource rules, and the admin portal's Skills pages toggle them
per workspace and per conversation; see [Configuration](/configuration/#skills). An excluded skill is
only left out of the prompt; its files stay readable in the sandbox.
