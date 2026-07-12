---
title: 技能
description: workspace-level 與 conversation-level skills 的載入位置、sandbox 路徑與工具結構。
---

| 層級                               | 用途                                                 | Host path                                           | Sandbox 內 runtime path                            |
| ---------------------------------- | ---------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------- |
| Workspace-level（global skills）   | 整個 workspace 內所有 conversations 都可用的共用工具 | `<workspace>/skills/<skill-name>/`                  | `/workspace/skills/<skill-name>/`                  |
| Conversation-level（local skills） | 只給單一 conversation / channel / DM 使用的工具      | `<workspace>/<conversationId>/skills/<skill-name>/` | `/workspace/<conversationId>/skills/<skill-name>/` |

:::note
mikan 會先載入 workspace-level skills，再載入 conversation-level skills。若兩邊有相同 `name`，conversation-level skill 會覆蓋 workspace-level skill。
:::

## 目錄結構

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

Workspace-level skills 適合共用工具：公司 API、常用 scripts、release helpers、reporting tools，或任何多個 conversations 都會用到的能力。

Conversation-level skills 適合本地工具：特定 channel workflow、暫時 helper，或不應出現在其他 conversations 的工具。
