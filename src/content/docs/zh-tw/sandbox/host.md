---
title: Host sandbox
description: 直接在宿主機執行 commands，適合本機開發與不注入 vault env 的情境。
---

```bash
mikan --sandbox=host /path/to/workspace
```

特性：

- commands 直接在宿主機執行
- 不注入 vault env
- `/pi-login` 仍可把 credential 存進 `state-dir/vaults`，以平台使用者為 key；env 項目只是不會被用到，但該 vault 中的 _file_ credential 會讓執行失敗並拋出 `Sandbox type "host" does not support vault file mounts`
- bash commands 會在 mikan process 自己的工作目錄下啟動

## Door policy 需求

`host` 無法落實以對話為範圍的 workspace projection：沒有東西可以掛進去，工具看得到的就是 host 使用者看得到的一切。因此當該 office 的 door policy 是 `isolated`（也就是預設值）時，mikan 會拒絕執行並回報：

```text
Sandbox 'host' cannot provide an isolated conversation office; use image:*,
or explicitly choose trusted workspace policy
```

要使用 host 模式，必須明確選擇 trusted policy，可以在 `<state-dir>/settings.json` 中全域設定：

```json
{
  "sandbox": {
    "workspace": { "doorPolicy": "trusted", "layout": "shared-support" }
  }
}
```

也可以從 admin portal 依對話設定。`/pi-sandbox` 聊天指令在 host 模式下無法使用——它只服務受管的 `image:*` sandbox。

適合：

- 在你已經信任其掌握整個 workspace 的機器上做本機開發
- 不希望 mikan 把 vault credential 放進 host command process

不適合共享或多租戶部署：host 模式讓每個對話都擁有與 mikan 自身相同的檔案系統與 process 視野。那些情境請改用 [`image:<image>`](/zh-tw/sandbox/image/)。
