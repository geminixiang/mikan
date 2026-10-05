---
title: 技能
description: workspace-level 與 conversation-level skills 的載入位置、sandbox 路徑與工具結構。
---

| 層級                               | 用途                                                 | Host path                                       | Sandbox 內 runtime path                        |
| ---------------------------------- | ---------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| Workspace-level（global skills）   | 整個 workspace 內所有 conversations 都可用的共用工具 | `<workspace>/skills/<skill-name>/`              | `/workspace/skills/<skill-name>/`              |
| Conversation-level（local skills） | 只給單一 conversation / channel / DM 使用的工具      | `<workspace>/<office-key>/skills/<skill-name>/` | `/workspace/<office-key>/skills/<skill-name>/` |

office key 是 mikan 為每個對話推導出的 `v1-<platform>-<readable-id>-<hash>` 目錄名稱；你不需要自己組出它。Admin portal 的 skills 檢視會列出兩個層級（包含巢狀的 skill 目錄），能在任一層級建立 skill，也能開關 skills。

:::note
mikan 會先載入 workspace-level skills，再載入 conversation-level skills。若兩邊有相同 `name`，conversation-level skill 會覆蓋 workspace-level skill。
:::

:::note[Private office 可讀取 workspace-level skills]
每個對話都會列出並讀取 workspace-level skills。Private office（私人頻道、DM，或任何非 Slack 對話）會以唯讀方式掛載 `/workspace/skills/`，因此可以使用這些 skills，但要把自己的 skills 建在自己的 office 裡。見 [Sandbox](/zh-tw/sandbox/)。
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

Workspace-level skills 適合共用工具：公司 API、常用 scripts、release helpers、reporting tools，或任何多個 conversations 都會用到的能力。只有 public office 能寫入它們。

Conversation-level skills 適合本地工具：特定 channel workflow、暫時 helper，或不應出現在其他 conversations 的工具。每個 office 都能寫入它們，也是 private office 唯一可寫的層級。

## 關閉 skills

每個 skill 預設都會列在 system prompt 中。全域或 conversation 設定中的 `skills` 會以 Pi 的 resource rules 排除 skills，admin portal 的 Skills 頁面則可依 workspace 與依 conversation 切換它們；見[設定](/zh-tw/configuration/#skills)。被排除的 skill 只是不出現在 prompt 中，它的檔案在 sandbox 內仍然可讀。
