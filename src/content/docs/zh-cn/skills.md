---
title: 技能
description: workspace-level 与 conversation-level skills 的载入位置、sandbox 路径与工具结构。
---

| 层级                               | 用途                                                 | Host path                                                  | Sandbox 内 runtime path                                   |
| ---------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| Workspace-level（global skills）   | 整个 workspace 内所有 conversations 都可用的共用工具 | `<workspace>/.mikan/skills/<skill-name>/`                  | `/workspace/.mikan/skills/<skill-name>/`                  |
| Conversation-level（local skills） | 只给单一 conversation / channel / DM 使用的工具      | `<workspace>/<conversationId>/.mikan/skills/<skill-name>/` | `/workspace/<conversationId>/.mikan/skills/<skill-name>/` |

:::note
mikan 会先载入 workspace-level skills，再载入 conversation-level skills。若两边有相同 `name`，conversation-level skill 会覆盖 workspace-level skill。
:::

## 目录结构

```text
<workspace>/
├── .mikan/skills/
│   └── my-global-tool/
│       ├── SKILL.md
│       └── run.sh
└── <conversationId>/
    └── .mikan/skills/
        └── my-local-tool/
            ├── SKILL.md
            └── run.sh
```

每个 skill 目录都需要一个 `SKILL.md`：

```yaml
---
name: my-tool
description: Does something useful
---

Usage: {baseDir}/run.sh <args>
```

`name` 与 `description` 必填。若要在说明中引用 skill 目录内的档案，请使用 `{baseDir}`；mikan 会把它换成该 skill 的 runtime path。

## 什么时候用哪一层

Workspace-level skills 适合共用工具：公司 API、常用 scripts、release helpers、reporting tools，或任何多个 conversations 都会用到的能力。

Conversation-level skills 适合本地工具：特定 channel workflow、暂时 helper，或不应出现在其他 conversations 的工具。
