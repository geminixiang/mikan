---
title: 技能
description: 工作区级和对话级技能的加载位置、沙箱路径与工具结构。
---

| 级别                 | 用途                             | 主机路径                                        | 沙箱内的运行时路径                             |
| -------------------- | -------------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| 工作区级（全局技能） | 工作区内所有对话共享的工具       | `<workspace>/skills/<skill-name>/`              | `/workspace/skills/<skill-name>/`              |
| 对话级（本地技能）   | 仅供一个对话/频道/私聊使用的工具 | `<workspace>/<office-key>/skills/<skill-name>/` | `/workspace/<office-key>/skills/<skill-name>/` |

office key 是 mikan 为每个对话派生的 `v1-<platform>-<readable-id>-<hash>` 目录名；你不需要手工构造它。
管理 portal 的技能视图会列出这两个级别（包括嵌套的技能目录），可以在任一级别创建技能，也可以开关技能。

:::note
mikan 先加载工作区级技能，再加载对话级技能。如果两者定义了相同的 `name`，对话级技能会覆盖工作区级技能。
:::

:::note[private 办公室可读取工作区级技能]
每个对话都会列出并读取工作区级技能。private 办公室（私密频道、DM 或任何非 Slack 对话）会以只读方式挂载
`/workspace/skills/`，因此它可以使用这些技能，但要在自己的办公室里创建技能。参阅 [Sandbox](/zh-cn/sandbox/)。
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

工作区级技能适用于共享工具：公司 API、常用脚本、发布辅助工具、报告工具，或多个对话都会使用的任何能力。只有 public 办公室可以写入它们。

对话级技能适用于本地工具：特定频道工作流、临时辅助工具，或不应出现在其他对话中的工具。每间办公室都可以写入它们，而且它们是 private 办公室唯一可写的级别。

## 关闭技能

默认情况下，每个技能都会列进 system prompt。全局或对话设置中的 `skills` 按 Pi 的 resource 规则排除技能，
管理 portal 的技能页面则可按工作区和按对话开关技能；参阅[配置](/zh-cn/configuration/#skills)。被排除的技能只是不会出现在提示词中，
其文件在沙箱中仍可读取。
