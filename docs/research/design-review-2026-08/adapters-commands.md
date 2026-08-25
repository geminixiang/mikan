# mikan adapters / commands 設計審查

- 審查範圍：`src/adapters/**`、`src/commands/**`、`src/adapter.ts`
- 審查框架：`AGENTS.md` File-Split Scale（Slot / Authority / Weight）與 platform-neutral adapter seam
- 審查方式：完整只讀審查及 `rg` 交叉驗證
- Repository：`/Users/geminixiang/Github/mikan`
- 結果：未修改 repository 內任何檔案

## Severity 說明

每項以使用者指定的類別標記：

- `correctness`：可能造成錯誤行為、隔離失效或資料/能力作用域錯誤
- `authority`：同一規則存在多個 authority，可能 drift
- `duplication`：相同平台轉換或 dispatch 邏輯重複生長
- `naming`：檔案歸屬、型別歸屬或文件描述誤導維護者

另附影響程度：高 / 中 / 低。

---

# 設計不合理

## 1. Slack thread slash command 的 event 與 command context 指向不同 session

- **Severity：`correctness`／高**
- **次要分類：`authority`**
- **檔案與行號：**
  - `src/adapters/slack/bot.ts:1092-1110`
  - `src/adapters/slack/bot.ts:1195-1231`
  - `src/commands/session-view.ts:37-40`
  - `src/commands/session-view.ts:58-63`

### 問題

Slack 的 `buildSlashCommandEvent` 會依 `slackRoute.thread` 計算 thread-scoped session，並將結果放入 event。

但建立 command adapters/context 時，message 又使用 top-level `conversationId` 作為 `sessionKey`，且沒有一致傳遞 `threadTs`。因此同一次 slash command 的 event 與 `CommandContext.message/sessionKey` 可能代表不同 session。

這不只是內部資料不一致。`SessionViewCommandHandler` 直接使用 `CommandContext.sessionKey`：

- 尋找現有 session file；
- 建立 Session View token。

因此在 Slack thread 內執行 `/pi-session`，可能取得 top-level conversation 的 session，而不是當前 thread session。

Thread-to-session mapping 應是單一 **Authority**。目前 event builder 與 command-context builder 各自組裝 session identity，導致 authority 分裂及 seam 洩漏。

### 最小修正方向

先建立一次 slash-command session plan，至少包含：

- `sessionKey`
- `conversationId`
- `threadTs`
- `conversationKind`

event、message、command context 與 Session View lookup 全部使用同一份 plan，不要在不同 builder 重複推導。

---

## 2. GitHub participation 以任意 log 存在作判定，首次 `stop` 即可誤啟用 participation

- **Severity：`correctness`／高**
- **次要分類：`authority`**
- **檔案與行號：**
  - `src/adapters/github/bot.ts:594-596`
  - `src/adapters/github/bot.ts:631-638`
  - `src/adapters/github/bot.ts:673-693`
  - `src/adapters/intake.ts:43-47`

### 問題

GitHub adapter 以 `log.jsonl` 是否存在判斷 bot 是否已參與某 issue/PR。

但 shared intake 對 magic word `stop` 的處理發生在正常 trigger/agent dispatch 之前，而 GitHub 路徑仍可能記錄該事件。可能形成：

1. 一個從未啟動 agent 的 issue 收到首次 `@bot stop`；
2. 即使結果只是「沒有執行中的工作」或沒有 agent dispatch，log 仍被建立；
3. 後續有 write 權限的使用者即使未 mention bot，其留言也可能因「log 已存在」被視為 bot 已參與而觸發。

`log.jsonl` 的本質是 diagnostic/audit log，卻同時被當成 participation state 的 **Authority**。「發生過可記錄事件」與「bot 已正式參與 conversation」是不同規則，不應共用同一判據。

### 最小修正方向

以明確狀態作為 participation authority，例如：

- 成功開始過 agent dispatch；
- 已成功發布 bot comment；
- 專用 participation marker。

至少保證首次、無實際作用的 `stop` 不會建立 participation 狀態。

---

## 3. GitHub Cloud Build log capability 未限制於原 conversation/repository

- **Severity：`correctness`／高**
- **次要分類：`authority`**
- **檔案與行號：**
  - `src/adapters/github/github-ops.ts:79-81`
  - `src/adapters/github/github-ops.ts:178-197`
  - `src/adapters/github/github-ops.ts:213-240`

### 問題

程式註解表達的規則是只能讀取「this repo checks」先前見過的 Cloud Build。

但實際 `buildRef` 只用全域 `buildId` 記錄 project。之後 `getBuildLog(conversationId, ...)` 雖接收 `conversationId`，卻沒有用它驗證 build 的來源，也沒有驗證 owner/repository。

若 `GithubOps` instance 被多個 GitHub conversations 共用：

1. conversation A 先看過某個 build ID；
2. 該 build ID 進入全域索引；
3. conversation B 可使用同一 build ID 讀取 log，即使 B 對應另一個 issue、PR 或 repository。

`github-ops.ts` 作為 GitHub host capability 的 Weight module 本身合理；問題是 capability key 缺少 office/conversation/repository scope，違反 conversation isolation seam。

### 最小修正方向

將索引至少改為：

- `conversationId + buildId`

更完整則保存並驗證：

- GitHub owner；
- repository；
- conversation/office identity；
- Cloud project；
- build ID。

`getBuildLog` 必須只接受由同一 scope 的 checks 查詢所授權的 build reference。

---

## 4. Slack、Discord、Telegram 仍以 literal command name 硬編 routing，繞過 manifest authority

- **Severity：`authority`／高**
- **次要分類：`duplication`**
- **檔案與行號：**
  - `src/commands/manifest.ts:70-82`
  - `src/adapters/slack/bot.ts:1236-1240`
  - `src/adapters/slack/bot.ts:1267-1285`
  - `src/adapters/slack/bot.ts:1611-1618`
  - `src/adapters/discord/bot.ts:471-474`
  - `src/adapters/discord/bot.ts:518-557`
  - `src/adapters/telegram/bot.ts:339-405`

### 問題

Manifest 宣稱平台 adapters 應由單一 command inventory 衍生原生註冊與 routing，但三個平台仍各自重述特殊 command 名稱。

#### Slack

`new` 只在 manifest 中有 `slackCommand`，沒有一般 `slackRoute`。Slack adapter 再以 `entry.name === "new"` 進入 bespoke route，並直接執行 reset/new-session 行為。

因此下列規則沒有由 manifest 表達：

- `new` 的特殊 dispatch kind；
- DM-only policy；
- 與一般 command handler 不同的 lifecycle。

#### Discord

Discord 先由 manifest 找 entry，之後仍比較：

- `interaction.commandName === "new"`
- `interaction.commandName === "stop"`

其中 `stop` 的特殊性已有 manifest 的 `magicWord` metadata，但 routing 沒有依 metadata 執行，而是再次硬編名稱。

#### Telegram

Telegram menu 由 manifest 產生，但實際 native command handlers 只硬編：

- `client.command("new", ...)`
- `client.command("sandbox", ...)`

因此 menu inventory 與 routing inventory 是兩份 authority。

Manifest 應是 command identity/routing 規則的 **Authority**；adapter-specific registrar 則是各平台合理的 **Slot**。目前 adapters 又決定一次 command identity，已形成 drift 風險。

### 最小修正方向

在 manifest 增加最小、平台中立的 route metadata，例如：

- normal command-handler dispatch；
- magic-word intake；
- conversation reset；
- private/DM-only policy。

各 adapter 迭代 manifest，依 route kind 執行，不再比較 `"new"`、`"stop"` 等 literal names。

不需要把 handler 邏輯塞入 manifest，也不需要合併平台 adapters。

---

## 5. Discord `new` branch 與 generic event dispatch 無實質差異

- **Severity：`duplication`／中**
- **次要分類：`authority`**
- **檔案與行號：**
  - `src/adapters/discord/bot.ts:518-533`
  - `src/adapters/discord/bot.ts:549-557`

### 問題

Discord 對 `new` 建立的 command event，與後面的 generic command event 路徑在可觀察資料及 dispatch 行為上沒有實質差異。

特殊 branch 沒有封裝額外 policy 或錯誤處理，卻使 `new` 名稱再次成為 adapter-local routing authority。

依 File-Split Scale，這個 branch 沒有形成新的 Slot、Authority 或足以獨立吸收的 Weight，只是重述 generic path。

### 最小修正方向

刪除 Discord `new` special branch，讓它走 generic command dispatch。

`stop` 若仍需 magic-word intake，應依 manifest 的 `magicWord` 或 route metadata 分流，而不是依 command name 分流。

---

## 6. Manifest 與 default handler registry 是兩份可 dispatch inventory

- **Severity：`authority`／高**
- **次要分類：`correctness`**
- **檔案與行號：**
  - `src/commands/manifest.ts:1-7`
  - `src/commands/README.md:9-10`
  - `src/commands/registry.ts:11-25`
  - `src/commands/registry.ts:28-35`
  - `src/adapters/discord/bot.ts:118-138`
  - `src/adapters/discord/bot.ts:471-474`
  - `src/adapters/telegram/bot.ts:110`
  - `src/test/command-manifest.test.ts:1-70`

### 問題

Manifest 與 commands README 宣稱：

- manifest 是單一 inventory；
- 新增 command 是加入 manifest entry 與 handler；
- 目標是避免遺漏某個平台或 route 而造成 silent no-response。

但 `defaultCommandHandlers` 仍以手寫 imports 與 constructor list 維護第二份「真正可 dispatch」的 inventory。

可觀察的 drift 路徑：

1. 新 command 加入 manifest；
2. Discord 從 manifest 註冊 application command，Telegram 也可從 manifest 顯示 menu；
3. handler file 已建立，但漏加進 `defaultCommandHandlers`；
4. 使用者仍看得到並可呼叫 command；
5. `dispatchCommand` 逐一詢問既有 handlers，全部回傳 `false`；
6. command silent no-response。

現有 manifest tests 驗證 spellings、menu 與部分 platform metadata，但未驗證每個非 `magicWord` manifest entry 都有 registry handler。

Handler-per-file 是合理的 command **Slot**；問題是 dispatch inventory 的 **Authority** 同時存在於 `manifest.ts` 與 `registry.ts`。

### 最小修正方向

最小、低侵入修正：

1. 將 handler registry 改為以 canonical command name 為 key；
2. 加入 completeness test；
3. 驗證每個非 `magicWord` manifest entry 恰有一個 handler；
4. 驗證 registry 不含 manifest 外的 command。

不必合併所有 command modules。若未來需要更完整的單一 authority，再由同一 command definition 衍生 metadata 與 handler factory。

---

## 7. Telegram `new` 與 `sandbox` 重複建構 native command intake/event/log

- **Severity：`duplication`／中**
- **次要分類：`authority`**
- **檔案與行號：**
  - `src/adapters/telegram/bot.ts:339-405`

### 問題

兩個硬編的 `client.command(...)` block 對下列內容近乎逐行重複：

- user identity；
- conversation/address；
- command event；
- logging fields；
- responder/dispatch context。

這些欄位共同表達「Telegram native command 如何轉成 mikan conversation event」，應是一項平台規則，而不是 `new` 和 `sandbox` 各自的業務知識。

不應把它再拆成多個小 command files；那會是沒有 Slot/Authority/Weight 的過度分檔。真正問題是 native-command conversion authority 被重述。

### 最小修正方向

建立一個有實質規則的 Telegram native-command registrar/event builder：

- 迭代 manifest route metadata；
- 統一建立 address、event、log context；
- 再送入對應 dispatch path。

避免新增只轉呼叫的薄 wrapper。

---

## 8. Core `attach` tool 錯放在 Slack adapter Slot

- **Severity：`naming`／中**
- **次要分類：`authority`**
- **檔案與行號：**
  - `src/adapters/slack/tools/attach.ts:1-55`
  - `src/adapters/slack/tools/README.md:7`
  - `src/tools/index.ts:5`
  - `src/tools/index.ts:53`

### 問題

`attach` 被 core tool inventory 引用，功能也不是 Slack-specific。Slack tools README 已明確說明它位於 Slack 目錄是歷史原因。

結果是：

- core tools 反向 import Slack adapter；
- 檔案路徑暗示不存在的 Slack ownership；
- 其他平台要理解 core tool inventory 時必須跨入 Slack Slot。

`src/tools/` 已有 one-file-per-tool 的既存分類軸。`attach` 應填入該 **Slot**，而不是形成「由 Slack 擁有 core tool」的假 authority。

相對地，Slack Block Kit tool、Slack tool pack，以及 Block Kit rendering/interaction knowledge 都確實屬於 Slack capability，留在 Slack adapter 下是合理的。

### 最小修正方向

將實作移至：

- `src/tools/attach.ts`

並更新 imports/tests。若原 import path 屬於公開介面，可暫時從原路徑 re-export 以降低遷移風險。

---

## 9. Exported adapter types 散落在 implementation files，繞過既有 `types.ts` authority

- **Severity：`authority`／中**
- **次要分類：`naming`**
- **檔案與行號：**
  - `src/adapters/slack/assistant.ts:38-73`
  - `src/adapters/discord/components.ts:21-24`
  - `src/adapters/markdown-tables.ts:20-26`
  - `src/adapters/github/webhook.ts:22-26`

### 問題

以下 exported types 位於 implementation files：

- Slack assistant 的四個 exported interfaces；
- Discord `DiscordTextPayload`；
- shared adapter `MarkdownTable`；
- GitHub `GithubWebhookOptions`。

但這些 modules 已各自存在 `types.ts` authority：

- `src/adapters/slack/types.ts`
- `src/adapters/discord/types.ts`
- `src/adapters/types.ts`
- `src/adapters/github/types.ts`

專案已將 exported type ownership 定義為明確 **Authority**：最近的 `types.ts`。Implementation file 再 export named type，會使讀者和 importers 無法只看 `types.ts` 理解 module contract，也增加循環 import 或 type authority drift 的風險。

### 最小修正方向

分別移至：

- Slack interfaces → `src/adapters/slack/types.ts`
- `DiscordTextPayload` → `src/adapters/discord/types.ts`
- `MarkdownTable` → `src/adapters/types.ts`
- `GithubWebhookOptions` → `src/adapters/github/types.ts`

Implementation 使用 type-only imports。若 downstream code 已從原 implementation import，可由原入口 re-export 以保持相容性。

---

## 10. Telegram README 描述不存在的 HTML pipeline 與檔案

- **Severity：`naming`／低**
- **檔案與行號：**
  - `src/adapters/telegram/README.md:8-17`
  - `src/adapters/telegram/bot.ts:56-72`
  - `src/adapters/telegram/context.ts:14-17`

### 問題

Telegram README 宣稱 adapter 使用 HTML pipeline，並在 file inventory 中列出不存在的 `html.ts`。

目前實作已使用 rich Markdown 路徑，README 與實際 seam 不一致。README 是 adapter 的導覽與 locality 文件；錯誤列出 authority/file ownership，會使維護者尋找不存在的 Slot，並誤判 Telegram formatting seam。

### 最小修正方向

更新 README：

- 改述目前的 rich Markdown pipeline；
- 移除 `html.ts`；
- 列出實際負責 formatting/rendering 的檔案。

---

# 疑問項目

## 疑問 A：部分 command parser 對 Telegram `@bot` suffix 的處理不一致

- **可能 Severity：`correctness`／低**
- **檔案與行號：**
  - `src/commands/admin.ts:8-10`
  - `src/commands/auto-reply.ts:16-18`
  - `src/commands/extensions.ts:33-35`
  - `src/commands/sandbox.ts:31-33`
  - `src/commands/login.ts:13-15`
  - `src/commands/model.ts:25-27`
  - `src/commands/new.ts:10-12`
  - `src/commands/session-view.ts:13-15`

### 問題

部分 handlers 呼叫 `matchCommand(..., { stripMention: true })`，部分沒有。

但 Telegram framework 是否在進入 handler 前已移除 `/command@bot` suffix，需要由實際 Telegram/adapter intake 路徑或 e2e 行為確認。因此目前只列為疑問，不列為已證實 correctness finding。

### 最小查證／修正方向

加入 `/command@mikan_bot` 的 platform-level tests，確認所有可在 Telegram group 使用的 command 進入 handler 時，其 `commandText` 是否已正規化。

若未統一正規化，最小修正應把 normalization 收斂到 Telegram intake 或 shared command parser 的單一 authority，而不是逐一修補 handlers。

---

# 審查後認為合理的歸屬

## Slack Block Kit tools 留在 adapter 下是合理的

下列內容符合 Slack capability **Slot**：

- Slack Block Kit tool；
- Slack-specific tool pack；
- Slack Block Kit rendering；
- Slack interaction/response lifecycle knowledge。

它們吸收 Slack API、Block Kit schema 與平台 response lifecycle，沒有證據顯示應搬入 platform-neutral `src/tools/`。

唯一明確錯位的是通用 `attach` tool。

## GitHub tools 的分檔合理

GitHub `tools/*` 的 one-tool-per-file 符合既有 Slot 分類軸。沒有因檔案數量或每檔大小而提出合併。

## `github-ops.ts` 的 Weight 合理

此檔內容屬於同一 GitHub host capability authority。問題是 build-log capability scope，不是檔案太大，因此不提出純拆檔建議。

## Shared adapter utilities 整體合理

Shared intake 與 progressive rendering 集中跨平台共同規則，具有合理 Authority/Weight。未因多平台使用或程式量而建議拆分。

## Command handlers 的 one-file-per-command 合理

Handler-per-command 是既有 Slot。主要問題是 manifest 與 registry 的雙重 inventory，而不是 handler 檔案數量。

## GitHub 一 issue/PR = 一 conversation 的特殊性

此特殊性留在 GitHub adapter 的 conversation/address mapping 內整體合理，沒有發現它要求 core adapter interface 增加 GitHub-only 欄位。已確認的污染點是：

- participation state 借用通用 log existence；
- Cloud Build capability 未正確綁定 conversation/repository scope。

---

# Command manifest authority 的 `rg` 驗證摘要

交叉檢查了：

- `COMMAND_MANIFEST`
- `commandManifestEntry`
- `slashForms`
- `commandForms`
- `telegramCommandMenu`
- `slackCommand`
- `slackRoute`
- `magicWord`
- `client.command(...)`
- Discord `interaction.commandName === ...`
- Slack literal `entry.name === ...`
- command handler imports 與 `defaultCommandHandlers`
- `dispatchCommand`
- `/pi-login`
- `/pi-session`
- `/pi-model`
- `/pi-sandbox`
- `/pi-new`
- `/pi-admin`
- `/pi-extensions`
- `/pi-auto-reply`
- command manifest tests 與各 adapter command tests

驗證結果：

1. Discord application-command registration 由 manifest 衍生，但仍有 literal-name routing。
2. Telegram menu 由 manifest 衍生，但 native handlers 只硬編部分 command。
3. Slack 多數 slash command 使用 manifest route，`new` 仍是 adapter-local bespoke route。
4. Handler grammar 普遍由 `slashForms`/`commandForms` 衍生。
5. Default handler registry 仍手動重述可 dispatch inventory。
6. 現有 manifest tests 沒有驗證 manifest 與 handler registry 的完整對應。

---

# 完整閱讀範圍

- `AGENTS.md` File-Split Scale 與相關 coding/type rules
- `src/adapter.ts`
- `src/adapters/slack/**`
- `src/adapters/discord/**`
- `src/adapters/telegram/**`
- `src/adapters/github/**`
- `src/adapters/` 下 shared utilities、README 與 shared types
- `src/commands/**`
- 與 findings 直接相關的 command manifest tests、command tests、session-view 使用點及 shared intake 使用點

本審查未修改 repository code。
