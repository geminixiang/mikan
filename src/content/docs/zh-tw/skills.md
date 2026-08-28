---
title: 技能
description: workspace-level 與 conversation-level skills 的載入位置、sandbox 路徑與工具結構。
---

| 層級                               | 用途                                                 | Host path                                       | Sandbox 內 runtime path                        |
| ---------------------------------- | ---------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| Workspace-level（global skills）   | 整個 workspace 內所有 conversations 都可用的共用工具 | `<workspace>/skills/<skill-name>/`              | `/workspace/skills/<skill-name>/`              |
| Conversation-level（local skills） | 只給單一 conversation / channel / DM 使用的工具      | `<workspace>/<office-key>/skills/<skill-name>/` | `/workspace/<office-key>/skills/<skill-name>/` |
| Package skills                     | 由已安裝的 package 提供的 skills                     | state dir 底下的一份 git checkout               | `/mikan/packages/<slug>/skills/`（唯讀）       |

office key 是 mikan 為每個對話推導出的 `v1-<platform>-<readable-id>-<hash>` 目錄名稱；你不需要自己組出它。Admin portal 的 skills 檢視會列出兩個層級，也能在任一層級建立 skill。

:::note
mikan 會先載入 workspace-level skills，再載入 conversation-level skills。若兩邊有相同 `name`，conversation-level skill 會覆蓋 workspace-level skill。
:::

:::caution[Workspace-level skills 需要 trusted door]
在 `isolated` door policy 下，一個對話只看得到自己的 office，因此 workspace-level skills 既不會被掛載，也不會提供給 agent——prompt 會要求它把 skills 放在自己的 office 裡。DM、外部頻道與未知平台可見性會推導出此 policy，除非 admin 明確覆寫。Workspace-level skills 需要 trusted 的 `shared-support` 或 `full` layout。見 [Sandbox](/zh-tw/sandbox/)。
:::

## 目錄結構

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

包含 `SKILL.md` 的目錄會被視為一個 skill root，且不會遞迴搜尋。mikan 也會探索設定的 skills 目錄正下方的獨立 `.md` 檔案。

Directory-based skill 使用 `SKILL.md`：

```yaml
---
name: my-tool
description: Does something useful
---

Usage: {baseDir}/run.sh <args>
```

`name` 與 `description` 必填。請使用相對於 skill directory 的路徑，或填寫上表所示、runtime 可見的絕對路徑。`{baseDir}` 不會自動展開。

## 什麼時候用哪一層

Workspace-level skills 適合共用工具：公司 API、常用 scripts、release helpers、reporting tools，或任何多個 conversations 都會用到的能力。它們需要 trusted door policy。

Conversation-level skills 適合本地工具：特定 channel workflow、暫時 helper，或不應出現在其他 conversations 的工具。它們在任何 door policy 下都能運作，也是 isolated office 唯一可寫的層級。

Package skills 則用於在多個安裝之間散布一組 skills。它們以唯讀方式掛在 `/workspace` 之外，因為那些檔案由 host 擁有——該目錄是一份 git checkout，更新時會被整個取代，所以 agent 的修改會在下次刷新時被丟棄。因此檔案系統會直接拒絕寫入。
