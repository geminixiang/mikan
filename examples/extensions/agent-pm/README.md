# agent-pm — mikan extension 範例

一個 follow-up 追蹤器：單一 `index.mjs`（約 200 行）、零 npm 依賴
（儲存用 Node 內建 `node:sqlite`），示範 extension v1 + v2 的完整介面。

## 它做什麼

- **`followup` 工具**（`registerTool`）：模型可 `add` / `list` / `done` /
  `cancel` / `note` / `remind`，管理本會話的待辦追蹤項目。
- **每回合自動注入**（`before_agent_start` hook）：把未結案項目附加到
  system prompt，agent 每回合開場就知道有哪些 follow-up、哪些已逾期。
- **每日逾期掃描**（v2 `api.schedules`）：activate 時登錄 cron 排程，
  變成 mikan 的 event 檔——每天 09:00 觸發一次自主 agent run，沒人發話
  也會主動追殺逾期項目。
- **主動發訊**（v2 `api.notify`）：`remind` action 直接把清單貼進頻道，
  不經過 agent 回覆。
- **資料目錄**（v2 `api.paths.dataDir`，預設）：sqlite 檔放在
  `<stateDir>/conversations/<id>/extension-data/agent-pm/`，host-only、
  永不進 sandbox。每個會話一個 db，隔離免費——這是常見裝法（單一頻道/DM
  的 follow-up 追蹤）。若想要跨頻道 PM 視圖（一張總表涵蓋所有頻道），
  改用 `api.paths.sharedDataDir` 並靠 `conversation_id` 欄位自行分區。
- **manifest.json**（v2）：名稱／版本／描述。
- **skills/**（v2）：`follow-up-triage` SKILL.md 隨 extension 出貨，
  內容直接內嵌進 system prompt（sandbox 讀不到 host-only 路徑，
  所以 extension skills 一律 inline）。

## 安裝

```sh
# 只對單一會話生效（常見裝法）
cp -r agent-pm ~/.mikan/conversations/<id>/extensions/

# 或所有會話生效
cp -r agent-pm ~/.mikan/global/extensions/
```

新的 harness instance 建立時會重新載入 extension（import 帶 cache-busting），
編輯後不需重啟整個 mikan。

## Secrets（本範例未用到，但可直接取用）

若 extension 需要外部服務 token（例如同步到 Linear/GitHub），管理員把
KEY=VALUE 寫進 `<stateDir>/vaults/extensions/agent-pm/env`，程式內以
`api.secrets.get("LINEAR_TOKEN")` 讀取（唯讀）。

## 使用情境

```
使用者: 記一下，vendor 報價要在週五前回覆
agent:  (followup add "回覆 vendor 報價" due=2026-07-10) 好，已加入追蹤。

-- 隔天 09:00，沒有任何人發話 --

mikan:  (排程觸發自主 run → followup list → 發現逾期)
        ⚠️ 「回覆 vendor 報價」已逾期（due 2026-07-10），請更新狀態。
```

## Extension API 覆蓋

| 需求                       | 現況                                       |
| -------------------------- | ------------------------------------------ |
| 自訂工具                   | ✅ `registerTool`                          |
| 每回合注入 context         | ✅ `before_agent_start`                    |
| 會話範圍                   | ✅ `api.context.conversationId`            |
| 定時主動提醒（無人發話時） | ✅ v2 `api.schedules`（cron / one-shot）   |
| 主動發訊息到平台           | ✅ v2 `api.notify`                         |
| 專屬資料目錄               | ✅ v2 `api.paths.dataDir`                  |
| secrets                    | ✅ v2 `api.secrets`（vault env，唯讀）     |
| 身分／版本                 | ✅ v2 `manifest.json`                      |
| 隨附 skills                | ✅ v2 `skills/` 目錄（SKILL.md，自動內嵌） |
