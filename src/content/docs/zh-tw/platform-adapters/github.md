---
title: GitHub 接入
description: 綁定 GitHub 帳號、以 webhook 驅動、issue/PR 對話、限制設定與以 comment 回覆。
---

:::caution[實驗性功能]
GitHub 接入目前是實驗性功能。它的設定和對話的儲存方式，可能在次版本更新時改變，這個版本的對話不保證能延續。
:::

每個 GitHub issue 或 pull request 都是一個 mikan 對話。mikan 以你綁定的一般 GitHub 帳號行動，所以大家可以像對待隊友一樣，用自動完成 @ 它、把 issue 和 PR assign 給它、請它 review。GitHub 透過有簽章的 webhook 通知 mikan 發生了什麼。設計理由見 [ADR 0015](https://github.com/geminixiang/mikan/blob/main/docs/adr/0015-github-agent-account-and-webhooks.md)。

逐步設定請見[讓 mikan 成為 GitHub 隊友](/zh-tw/github-teammate-guide/)。

Conversation id 是 `GH_<owner>_<repo>_<number>`，其中 owner 與 repo 都轉為小寫。它避開 `/` 與 `:`，因為 id 會原樣當成單一路徑片段使用，也會出現在 docker 的 `-v source:target` 語法中；它以 `_` 而非 `-` 分隔，是因為 GitHub owner 可能含有 `-`（那會讓 owner/repo 的界線變得有歧義），但絕不會含有 `_`。和每個平台一樣，raw id 只停留在 GitHub API 邊界上：在磁碟上，該對話位於一個以 office key 命名的 office 目錄中。

## 主要程式碼

| 檔案                                | 用途                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/adapters/github/bot.ts`        | GitHub bot 主體：判斷是否觸發、檢查權限、送進對話。                                                         |
| `src/adapters/github/activity.ts`   | 驗證 webhook 內容，整理成統一的活動格式。                                                                   |
| `src/adapters/github/policy.ts`     | 解析並套用限制設定。                                                                                        |
| `src/adapters/github/webhook.ts`    | 驗證簽章、回應 GitHub、丟掉重複的推送。                                                                     |
| `src/adapters/github/github-ops.ts` | 每個 `github_*` tool 背後的 host 端 backend。                                                               |
| `src/adapters/github/client.ts`     | 以帳號 token 驗證的最小 REST client。                                                                       |
| `src/adapters/github/context.ts`    | 建立 GitHub `ConversationResponder`；將完成的回應作為單一 comment 發布（不做 streaming edits）。            |
| `src/adapters/github/ids.ts`        | `rc-<id>` review-comment ts。`GH_<owner>_<repo>_<number>` conversation id 語法位於 `src/office/index.ts`。  |
| `src/adapters/github/tool-pack.ts`  | 把 host 端的 tools 打包成由 main 注入的 platform tool pack。                                                |
| `src/adapters/github/tools/`        | 提供給 agent 的 tools：`github_pr`、`github_checks`、`github_review_reply`、`github_read`、`github_issue`。 |

## 需要準備

- **一個 agent 帳號**：給 mikan 用的一般 GitHub 帳號，對它要工作的 repo 有存取權。它在各 repo 的角色是外層上限：只需要對話的 repo 給 read，要推 branch 的 repo 給 write。
- **該帳號的 fine-grained personal access token**：resource owner 選組織，repository permissions 為 **Contents**、**Issues**、**Pull requests** 讀寫，**Actions** 與 **Commit statuses** 唯讀。組織要求核准時，由 owner 核准。
- **一個 webhook**：送到 `<LINK_URL>/github/webhook`，設定 secret，訂閱 **Issues**、**Issue comments**、**Pull requests**、**Pull request review comments**。組織 webhook 最簡單；GitHub App 的 webhook 也可以，mikan 不使用任何 App 憑證。
- **Link server**（`LINK_PORT` 與公開的 `LINK_URL`），用來接收 webhook。

## 設定

兩個密鑰放在 `~/.mikan/mikan.env`，設定後就會啟用 GitHub adapter：

| 環境變數                | 用途                                                     |
| ----------------------- | -------------------------------------------------------- |
| `GITHUB_AGENT_TOKEN`    | 帳號的 fine-grained PAT（必填）。GitHub 拒絕時啟動失敗。 |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret（必填）。                                 |

要回應哪些 repo、誰可以觸發，放在 `~/.mikan/settings.json`：

```json
{
  "github": {
    "repos": ["acme/*"],
    "capabilities": ["triage"]
  }
}
```

| 設定                   | 用途                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `github.repos`         | `owner/repo` 或 `owner/*`（必填）。其他 repo 一律不回應。          |
| `github.publicRepos`   | 設為 `true` 時也回應公開 repo（預設 `false`）。                    |
| `github.users`         | 允許觸發的帳號（預設：任何有足夠權限的人）。                       |
| `github.minPermission` | 觸發者需要的 repo 權限：`write`（預設）、`maintain` 或 `admin`。   |
| `github.triggers`      | `mention`、`assign`、`review`、`followup` 的任意組合（預設全部）。 |
| `github.capabilities`  | 在留言之外額外開放 `triage` 和／或 `push`（預設都不開）。          |

任何一項填了不認得的值，啟動就會失敗。

## 觸發條件

一次推送要同時符合以下條件才會觸發：

1. 發送者不是 bot，也不是 agent 帳號自己。
2. Repo 符合 `github.repos`，而且是私有 repo，除非 `github.publicRepos` 是 `true`。
3. 屬於有開啟的觸發方式：
   - `mention`：新的 issue、PR、留言或 inline review comment 提到 `@<帳號>`；
   - `assign`：issue 或 PR 被 assign 給這個帳號；
   - `review`：PR 請這個帳號 review；
   - `followup`：mikan 已經參與的 thread 有新留言。
4. 有設定 `github.users` 時，發送者在名單內。
5. 發送者在該 repo 有 `github.minPermission` 以上的權限。查詢結果快取五分鐘，查詢失敗一律拒絕。

其他情況一律忽略，也不會留下任何狀態。@ 帳號並留言 `stop`（或 `/stop`）會停止執行中的 session；這個 magic word 在所有平台用同一套語法。

推送採盡力而為：mikan 立刻回應 GitHub，忽略重複的推送，不保存任何推送紀錄。mikan 停機或連不到時送出的事件會遺失，請再 @ 一次。

## 能力

沒有設定 `github.capabilities` 時，mikan 可以留言、按 reaction、讀取 repo 與 CI 結果、在 review thread 回覆，但不能改 label、assignee 或程式碼。

| 能力     | 開放                                                     |
| -------- | -------------------------------------------------------- |
| `triage` | `github_issue` tool：label、assignee、關閉與重開。       |
| `push`   | `github_pr` tool 以及推 branch、開 pull request 的說明。 |

沒開的能力，對應的 tool 和說明會完全不給 agent，但不會拿走憑證：agent 能從 sandbox 推什麼，取決於 sandbox 的 GitHub token、帳號在 repo 的角色，以及 branch protection。請保護預設 branch，讓 agent 的變更只能經由 review 過的 pull request 進入。

只有至少具 write 權限的協作者能觸發 mikan，所以 GitHub 回報 `trustModel: "membership"`。GitHub 對話因此會像 Slack 對話一樣拿到 `sandbox.defaultSharedVault`、settings 宣告的 MCP servers，以及預設的 OpenConnector token。見 [Vault](/zh-tw/sandbox/vault/)。

## Sessions 與回覆

整個 issue/PR 是一個持久 session（`sessionKey === conversationId`），inline review threads 也會攤平進同一個 session，而不是對應到 sub-sessions。觸發的 review comment 會被注入為標記 `[PR review comment rc-<id> on <path>:<line>]` 的訊息，帶有 diff hunk；若是 thread 中段的回覆，也會附上該 thread 先前的內容。Agent 會用 `github_review_reply` tool 回覆該 thread（一般回應會以普通 PR comment 發布）。回覆使用 GitHub Flavored Markdown，並在完成後才發布：不做 streaming edits，因此不會頻繁呼叫 API，也不會顯示為「edited」。超過 comment 分割門檻的輸出會以接續 comments 發布。第一次透過 comment 接觸時，會先記錄 issue 標題與內文，讓 session 知道這個 thread 在談什麼。

## Repository 存取與 pull requests

mikan 從不在 host 上執行 git。agent 在自己的 sandbox 內，用 sandbox 的 GitHub credentials 把 repo clone 到 scratch 目錄、用 `gh pr checkout` 切到 pull request、以 agent 帳號 commit 並 push。沒有 credentials 時只能存取公開 repo。

- `github_pr`（能力 `push`）替 agent 已經 push 的 branch 開 pull request（支援 draft）；該 branch 已有開啟中的 PR 時直接回傳那個 PR。它不會 push，也不能 merge。
- `github_checks` 讀取已 push branch 或 PR head 的 GitHub Actions jobs 與 commit statuses，並可依 `job_id` 取得 Actions job 的 log 尾端。Fine-grained token 沒有 Checks 權限，所以第三方 CI app 發布的 check runs 看不到。
- `github_review_reply` 在單一 inline review thread 中回覆。
- `github_read` 讀取對話所屬 repo 的 PR 狀態與 diff stats、變更檔案、reviews、issue metadata、comments，以及篩選後的 issue/PR 清單。
- `github_issue`（能力 `triage`）管理 labels、assignees 與 close/reopen。Lock、delete 與 transfer 不在其 action set 中。

## 限制

- 漏掉的 webhook 推送不會補送。
- REST API 不支援檔案上傳；`uploadFile` 會改發一則指標 comment。
- 只有 summary body 提到帳號、沒有 inline comment 的 PR review 不會觸發。請改成請它 review，或另外留言。
