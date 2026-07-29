---
title: Skills
description: Load locations, sandbox paths, and tool structure for workspace-level and conversation-level skills.
---

| Level                             | Purpose                                                    | Host path                                       | Runtime path inside sandbox                    |
| --------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| Workspace-level (global skills)   | Shared tools available to all conversations in a workspace | `<workspace>/skills/<skill-name>/`              | `/workspace/skills/<skill-name>/`              |
| Conversation-level (local skills) | Tools for one conversation / channel / DM only             | `<workspace>/<office-key>/skills/<skill-name>/` | `/workspace/<office-key>/skills/<skill-name>/` |
| Package skills                    | Skills shipped by an installed package                     | a git checkout under the state dir              | `/mikan/packages/<slug>/skills/` (read-only)   |

The office key is the `v1-<platform>-<readable-id>-<hash>` directory name mikan derives for each
conversation; you do not construct it by hand. The admin portal's skills view lists both levels and
can create a skill in either.

:::note
mikan loads workspace-level skills first, then conversation-level skills. If both sides define the same `name`, the conversation-level skill overrides the workspace-level skill.
:::

:::caution[Workspace-level skills need a trusted door]
Under the default `isolated` door policy a conversation sees only its own office, so
workspace-level skills are neither mounted nor offered to the agent — the prompt tells it to keep
skills in its own office instead. Workspace-level skills require a trusted `shared-support` or
`full` layout. See [Sandbox](/sandbox/).
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

Workspace-level skills are good for shared tools: company APIs, common scripts, release helpers, reporting tools, or any capability used by multiple conversations. They require a trusted door policy.

Conversation-level skills are good for local tools: a specific channel workflow, a temporary helper, or tools that should not appear in other conversations. They work under every door policy, and are the only writable level an isolated office has.

Package skills are for distributing a skill set across installations. They mount read-only, outside `/workspace`, because the host owns those files — the directory is a git checkout that an update replaces wholesale, so an agent edit would be discarded on the next refresh. The filesystem refuses the write instead.
