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

## 门禁策略要求

`host` 无法强制执行对话范围的工作区投影：没有可挂载的目标，工具能看到的就是 host 用户能看到的一切。
因此当办公室的门禁策略为 `isolated`（也就是默认值）时，mikan 会拒绝运行，并给出：

```text
Sandbox 'host' cannot provide an isolated conversation office; use image:*,
or explicitly choose trusted workspace policy
```

要使用 host 模式，请显式选择受信任策略，可以在 `<state-dir>/settings.json` 中全局设置：

```json
{
  "sandbox": {
    "workspace": { "doorPolicy": "trusted", "layout": "shared-support" }
  }
}
```

也可以在 admin portal 中按对话设置。`/pi-sandbox` 聊天命令在 host 模式下不可用——它只服务于受管理的

适合：

- 在你已经信任其访问整个工作区的机器上做本地开发
- 不希望 mikan 把 vault credential 放进 host command process

不适合共享或多租户部署：host 模式让每个对话都拥有与 mikan 自身相同的文件系统和进程视图。
那种场景请改用 [`image:<image>`](/zh-cn/sandbox/image/)。
