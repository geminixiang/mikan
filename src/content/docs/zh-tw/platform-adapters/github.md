---
title: GitHub 接入
description: GitHub adapter 的 GitHub App polling、issue/PR 對話、watermark 去重與 comment-based responses。
---

每個 GitHub issue 或 pull request 都是一個 mikan 對話。Adapter 以 GitHub App installation 身分輪詢 GitHub API，不需要 webhook endpoint，保留 mikan 的主動式模型。

## 主要程式碼

| 檔案                                | 用途                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/adapters/github/bot.ts`        | GitHub bot 主體：poll loop、watermark 去重、mention/participation 觸發與 tool backends。                                   |
| `src/adapters/github/client.ts`     | 以 GitHub App 驗證的最小 REST client（RS256 JWT → installation tokens）。                                                  |
| `src/adapters/github/cloudbuild.ts` | 供 `github_checks` 使用的 Cloud Build log 讀取（host 端 GCP 憑證）。                                                       |
| `src/adapters/github/context.ts`    | 建立 GitHub `ConversationResponder`；將完成的回應作為單一 comment 發布（不做 streaming edits）。                           |
| `src/adapters/github/ids.ts`        | `GH_<owner>_<repo>_<number>` conversation id 編碼／解析；`rc-<id>` review-comment ts。                                     |
| `src/adapters/github/tools/`        | 提供給 agent 的 tools：`github_pr`、`github_checks`、`github_review_reply`、`github_sync`、`github_read`、`github_issue`。 |
| `src/adapters/github/types.ts`      | GitHub adapter 專用型別與 REST payload shapes。                                                                            |

## 建立並安裝 GitHub App

1. 為擁有目標 repositories 的 account 或 organization 建立 GitHub App。
2. 授予 repository permissions：**Metadata: Read**、**Contents: Read & write**、**Issues: Read & write**、**Pull requests: Read & write**、**Checks: Read** 與 **Actions: Read**。Issues/PR write access 涵蓋 comments 與 reactions；Contents/Pull requests write access 僅由受保護的 `github_pr` tool 使用。
3. 將 App 安裝到 mikan 可輪詢的 repositories。
4. 記下 App ID 與 installation ID，接著產生 private key。將 PEM 保存在 workspace 外，並優先使用 `GITHUB_APP_PRIVATE_KEY_PATH`，不要使用 inline secret。

App slug 是使用者首次觸發時 mention 的名稱。

## 設定

| Env var                                                  | 用途                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GITHUB_APP_ID`                                          | GitHub App id（必要）。                                                        |
| `GITHUB_INSTALLATION_ID`                                 | 要以其身分操作的 installation id（必要）。                                     |
| `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_PRIVATE_KEY_PATH` | App private key PEM，可 inline（使用 `\n` escapes）或以檔案提供。              |
| `GITHUB_REPOS`                                           | 選用、以逗號分隔的 `owner/repo` 清單；預設為所有 installation repositories。   |
| `GITHUB_POLL_INTERVAL`                                   | 選用的 poll interval，單位為秒（預設 60）。                                    |
| `GOOGLE_APPLICATION_CREDENTIALS`                         | 選用的 GCP ADC JSON 路徑；為 `github_checks` 啟用 Cloud Build logs（見下文）。 |
| `GOOGLE_CLOUD_PROJECT`                                   | 選用的 fallback GCP project，當 Cloud Build check 未指明 project 時使用。      |

## 事件來源

Poll loop 會使用 ETag conditional requests（304 responses 不計入 rate limit），針對每個監看的 repo 取得自增 cursor 後更新的 issues、issue/PR comments 與 inline PR review comments。每個 endpoint 目前會讀取一頁、最多 100 筆 records；若兩次 polls 間出現更大的 burst，cursor 前進時可能遺漏。繁忙的 installations 請縮短 `GITHUB_POLL_INTERVAL` 或縮小 `GITHUB_REPOS` 範圍。

去重使用持久化於 `<state-dir>/github-sync.json` 的 watermark（atomic write）：

- 第一次執行只記錄 baseline，不會發出任何事件，歷史紀錄絕不會觸發。
- 已處理的 comment/issue ids 不會再次觸發，編輯也不會再次觸發。
- mikan 停機期間發布的 comments 會在重新啟動後重播。

## 觸發條件

Comment、inline review comment 或新 issue body 只有在 @mention app slug，或 bot 已參與該 issue 的對話時才會觸發執行。Commenter 也必須具有該 repo 的 **write permission or better**；在 public repos 中任何人都能留言，因此低於 write 的使用者所發 mentions 會完全忽略（permission lookups 快取五分鐘，且失敗時拒絕）。其他內容都會忽略且不建立任何狀態。包含 mention 的 `stop`（或 `/stop`）comment 會停止執行中的 session。

## Sessions 與回覆

整個 issue/PR 使用一個持久 session（`sessionKey === conversationId`），包含 inline review threads——它們會被攤平併入該 session，而不是映射到 sub-sessions。觸發的 review comment 會以標記為 `[PR review comment rc-<id> on <path>:<line>]` 的訊息注入，附帶 diff hunk；若是 thread 中段的回覆，還會附上該 thread 先前的對話。Agent 使用 `github_review_reply` tool 回覆該 thread（一般回應會以普通 PR comment 發布）。回應使用 GitHub Flavored Markdown，並在回應完成後發布，不做 streaming edits，因此 replies 不會反覆呼叫 API 或顯示為「edited」。超出 comment split threshold 的輸出會以 continuation comments 發布。System prompt 會告訴 agent 對話所屬的 issue/PR（owner/repo#number）。首次透過 comment 聯絡時，會先記錄 issue title/body，讓 session 知道 thread 的主題。

## Repository 存取與 pull requests

Sandbox 絕不持有憑證；git 操作跨越 conversation-dir bind mount 的兩端：

- 首次接觸時，repo 會 shallow-clone 到 conversation dir（sandbox 內為 `./repo`），使用限於該 repo 且具有 `contents:read` 的 ephemeral token；token 會隨每次 git invocation 傳入，絕不寫入 `.git/config`。PR 對話會以 PR head 的真實 branch 名稱 checkout（fork PR 或查詢失敗時 fallback 為 `pr-<n>`），因此 head 為 `pi/*` branch 的 PR 可以原地更新：直接在該 branch 上 commit 並呼叫 `github_pr`，push 會回到同一個 PR。
- Agent 在 sandbox 內使用一般 git 建立 branch 與 commits（已預先設定 bot author identity）；依設計，從 sandbox push 會失敗。
- `github_pr` tool 在 host 端執行：它會為該 repo 產生 `contents:write` + `pull_requests:write` token，從 mount 的 host 端 push agent 的 `pi/*` branch，並以 App 身分建立 pull request（支援 draft）；使用相同 branch 再次呼叫會將新 commits push 到既有 PR。它不能 push default branch、force-push 或 merge，所有 PR 都由人員 review 與 merge。
- `github_checks` tool 會讀取已 push branch（或 PR head）的 CI check runs，並可取得失敗 run 的 log tail：GitHub Actions runs 使用 `job_id`（需要 **Checks: Read** 與 **Actions: Read**）；當 host 具備 GCP 憑證時，Google Cloud Build runs 使用 `build_id`（見下文）。
- `github_sync` tool 使用 ephemeral read token，將 `./repo` snapshot 從 origin 更新為最新 PR head、base branch 或指定 branch。只有在不會遺失 agent 工作成果時（working tree 乾淨、沒有 agent commits；force-push 過的 PR heads 仍可同步）才會移動 checkout；否則只 fetch 到 `FETCH_HEAD` 並回報，讓 agent 在 sandbox 內自行 merge 或 rebase。
- `github_review_reply` tool 會在單一 inline review thread 內發布回覆，數字 id 取自 `rc-<id>` 訊息。
- `github_read` tool 讀取 clone 無法呈現的 metadata：PR 狀態與 diff 統計、變更檔案、已提交的 reviews 及 open thread ids、issue metadata、近期 comments，以及可篩選的 issue/PR 清單。其設計上僅限於該對話所屬的 repo。
- `github_issue` tool 管理該對話 repo 內任一 issue 的 labels、assignees 與 close/reopen（triage）。Lock、delete 與 transfer 不在其 action set 中。

這些工具使用設定章節列出的 App permissions。它們無法繞過 mikan 強制執行的 branch/default-branch guards。

## Cloud Build logs（選用）

當 CI 在 Google Cloud Build 上執行時，其 check runs 在 GitHub 上顯示為 external CI，其 logs 無法透過 GitHub API 取得。在 **host** 上將 `GOOGLE_APPLICATION_CREDENTIALS` 設為 GCP Application Default Credentials JSON 的路徑——可以是 Workload Identity Federation 的 `external_account` 檔案（file 或 url credential source）、service-account key，或 gcloud user ADC——之後 `github_checks` 的摘要就會列出可取得 logs 的 `[build <uuid>]` handles（builds.get → build 的 logs bucket 中的 `log-<uuid>.txt` 物件，取 tail 截斷）。

該憑證的 principal 需要在 project 上具有 `roles/cloudbuild.builds.viewer`，並在 logs bucket 上具有 `roles/storage.objectViewer`。設定為 `CLOUD_LOGGING_ONLY` 的 builds 不會寫入 GCS log 物件；此時 tool 會改為回傳 console URL。憑證絕不會進入 sandbox；沒有憑證時，Cloud Build checks 會退化為先前的指引文字。

## 限制

- REST API 不支援檔案上傳；`uploadFile` 會改為發布 pointer comment。
- 若 PR review 只有 summary body mention bot（沒有任何 inline comments），不會觸發——沒有 repo 層級的「reviews since」endpoint。請改發一般 PR comment。
- `./repo` clone 是首次接觸時的 snapshot；sandbox 無法自行 fetch updates——agent 使用 `github_sync` 更新。
