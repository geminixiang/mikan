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
- `/pi-login` 仍可把 credential 存進 `~/.mikan/vaults`，以平台使用者為 key；env 項目只是不會被用到，但該 vault 中的 _file_ credential 會讓執行失敗並拋出 `Sandbox type "host" does not support vault file mounts`
- bash commands 會在 mikan process 自己的工作目錄下啟動

## 不強制 private office

`host` 無法強制 private office 的 visibility（ADR 0008）：沒有東西可以掛進去，工具看得到的就是 host 使用者看得到的一切，包括其他 private office 以及共用的 `MEMORY.md` 與 `skills/`。mikan 仍會執行這些對話，並對每個 office 記錄一次：

```text
Sandbox 'host' cannot enforce private office visibility for <office-key>
```

平台推導使這點適用於 DM、Slack 私人頻道、外部共享與未知的對話，以及所有 Telegram、Discord、GitHub 對話。`/pi-sandbox` 聊天指令在 host 模式下無法使用——它只服務受管的 `image:*` sandbox。

適合：

- 在你已經信任其掌握整個 workspace 的機器上做本機開發
- 不希望 mikan 把 vault credential 放進 host command process

不適合共享或多租戶部署：host 模式讓每個對話都擁有與 mikan 自身相同的檔案系統與 process 視野。那些情境請改用 [`image:<image>`](/zh-tw/sandbox/image/)。
