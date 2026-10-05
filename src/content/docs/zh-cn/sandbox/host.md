---
title: Host sandbox
description: 直接在宿主机执行 commands，适合本地开发与不注入 vault env 的场景。
---

```bash
mikan --sandbox=host /path/to/workspace
```

特性：

- commands 直接在宿主机执行
- 不注入 vault env
- `/pi-login` 仍可把 credential 存进 `state-dir/vaults`，按平台用户标识；env 条目只是不会被使用，但该 vault 中的**文件**凭证会让运行以 `Sandbox type "host" does not support vault file mounts` 失败
- bash commands 从 mikan 进程自身的工作目录启动

## 不强制执行 private 办公室

`host` 无法强制执行 private 办公室的 visibility（ADR 0008）：没有可挂载的目标，工具能看到的就是 host 用户能看到的一切，
包括其他 private 办公室以及共享的 `MEMORY.md` 和 `skills/`。mikan 仍会运行这些对话，并对每个办公室记录一次：

```text
Sandbox 'host' cannot enforce private office visibility for <office-key>
```

平台推导使这一点适用于 DM、Slack 私密频道、外部共享和未知对话，以及所有 Telegram、Discord 和 GitHub 对话。
`/pi-sandbox` 聊天命令在 host 模式下不可用——它只服务于受管理的 `image:*` 沙箱。

适合：

- 在你已经信任其访问整个工作区的机器上做本地开发
- 不希望 mikan 把 vault credential 放进 host command process

不适合共享或多租户部署：host 模式让每个对话都拥有与 mikan 自身相同的文件系统和进程视图。
那种场景请改用 [`image:<image>`](/zh-cn/sandbox/image/)。
