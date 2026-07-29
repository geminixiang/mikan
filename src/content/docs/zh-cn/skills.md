---
title: 技能
description: 工作区级和对话级技能的加载位置、沙箱路径与工具结构。
---

| 级别                 | 用途                             | 主机路径                                        | 沙箱内的运行时路径                             |
| -------------------- | -------------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| 工作区级（全局技能） | 工作区内所有对话共享的工具       | `<workspace>/skills/<skill-name>/`              | `/workspace/skills/<skill-name>/`              |
| 对话级（本地技能）   | 仅供一个对话/频道/私聊使用的工具 | `<workspace>/<office-key>/skills/<skill-name>/` | `/workspace/<office-key>/skills/<skill-name>/` |
| Package 技能         | 由已安装 package 提供的技能      | state dir 下的一份 git checkout                 | `/mikan/packages/<slug>/skills/`（只读）       |

office key 是 mikan 为每个对话派生的 `v1-<platform>-<readable-id>-<hash>` 目录名；你不需要手工构造它。
管理 portal 的技能视图会列出这两个级别，并且可以在任一级别创建技能。

:::note
mikan 先加载工作区级技能，再加载对话级技能。如果两者定义了相同的 `name`，对话级技能会覆盖工作区级技能。
:::

:::caution[工作区级技能需要受信任的门禁]
在默认的 `isolated` 门禁策略下，一个对话只能看到它自己的办公室，因此工作区级技能既不会被挂载，也不会
提供给代理——提示词会告诉它把技能放在自己的办公室里。工作区级技能需要受信任的 `shared-support` 或
`full` 布局。参阅 [Sandbox](/zh-cn/sandbox/)。
:::

## 目录结构

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

工作区级技能适用于共享工具：公司 API、常用脚本、发布辅助工具、报告工具，或多个对话都会使用的任何能力。它们需要受信任的门禁策略。

对话级技能适用于本地工具：特定频道工作流、临时辅助工具，或不应出现在其他对话中的工具。它们在所有门禁策略下都能工作，而且是隔离办公室唯一可写的级别。

Package 技能用于跨安装分发一套技能。它们以只读方式挂载在 `/workspace` 之外，因为这些文件归主机所有——该目录是一份 git checkout，更新会整体替换它，因此代理的编辑会在下次刷新时被丢弃。文件系统会直接拒绝这类写入。
