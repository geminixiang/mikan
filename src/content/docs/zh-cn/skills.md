---
title: 技能
description: 工作区级和对话级技能的加载位置、沙箱路径与工具结构。
---

| 级别                 | 用途                             | 主机路径                                            | 沙箱内的运行时路径                                 |
| -------------------- | -------------------------------- | --------------------------------------------------- | -------------------------------------------------- |
| 工作区级（全局技能） | 工作区内所有对话共享的工具       | `<workspace>/skills/<skill-name>/`                  | `/workspace/skills/<skill-name>/`                  |
| 对话级（本地技能）   | 仅供一个对话/频道/私聊使用的工具 | `<workspace>/<conversationId>/skills/<skill-name>/` | `/workspace/<conversationId>/skills/<skill-name>/` |

:::note
mikan 先加载工作区级技能，再加载对话级技能。如果两者定义了相同的 `name`，对话级技能会覆盖工作区级技能。
:::

## 目录结构

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

包含 `SKILL.md` 的目录会被视为一个技能根目录，不会递归搜索。mikan 也会发现配置的技能目录直属的独立 `.md` 文件。

基于目录的技能使用 `SKILL.md`：

```yaml
---
name: my-tool
description: Does something useful
---

Usage: {baseDir}/run.sh <args>
```

`name` 和 `description` 为必填项。请使用相对于技能目录的路径，或使用上表所示的运行时可见绝对路径。`{baseDir}` 不会自动展开。

## 如何选择级别

工作区级技能适用于共享工具：公司 API、常用脚本、发布辅助工具、报告工具，或多个对话都会使用的任何能力。

对话级技能适用于本地工具：特定频道工作流、临时辅助工具，或不应出现在其他对话中的工具。
