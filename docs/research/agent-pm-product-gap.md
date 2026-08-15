# livingbio/agent-pm 產品流程與 mikan 範例差距研究

> 研究日期：2026-06-10
> Upstream：[`livingbio/agent-pm`](https://github.com/livingbio/agent-pm)
> 研究版本：[`ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad`](https://github.com/livingbio/agent-pm/tree/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad)
> 對照範圍：本 repo `deploy/examples/extensions/agent-pm/`（唯讀）

## 摘要

Upstream 不是一個單一、完整的「AI 專案管理成品 UI」，而是一套為 Living Bio 內部營運量身打造、以 **Django management commands + 排程 + Slack 訊息 + Django Admin** 操作的後台系統。它已可運作的主要產品迴路有三組：

1. 從 Slack、Google Calendar、GitHub 匯入團隊資料，做 standup／請假／GitHub activity 監控與提醒；
2. 人工用 CLI 把既有或新建 GitHub issue 加入 follow-up，系統在 Slack 建 thread、定時追問、解析回覆並在 issue 關閉時結案；
3. 匯入 customer Slack channel，LLM 每 channel／day 判斷新增與已解決 customer requests，建立 `Task`，再將 open items 回貼 Slack。

新 `pipeline` 核心（Event → Workflow → Task → Feedback）已經有資料表、路由、task 建立、回覆解析、重送防護、sweep 與 prompt-revision proposal 的實作；但它仍在舊功能遷移期。README 所描述的是較舊的 app 架構，pipeline 設計文件則包含已落地、分期計畫與未決問題，不能把整份設計稿都視為產品現況。

mikan 版則刻意只是 extension reference：保留通用 schema、排程骨架、delivery dedupe、`pm_task` 查詢／結案工具與一個 heartbeat workflow，但沒有 upstream 的 Slack/GitHub/Calendar ingestors、identity seed、domain workflows、reply loop、task notification 或 workflow improvement。因此它雖有 `tasks` 表，正常安裝後沒有任何會建立業務 Task 的輸入路徑；`pm_task` 也只支援 `list/show/close`，不支援 create。

## 1. Upstream 作為成品的實際產品流程

### 1.1 操作者不是從 dashboard 開始，而是從 CLI、排程、Slack 與 Admin 開始

Upstream 的 HTTP 路由只有 `/admin/` 與 `/graphql/`；沒有自訂 dashboard、task board 或一般 end-user web app。GraphQL schema 又刻意只有 query，沒有 mutation，且目前只暴露 organization、Slack、GitHub、attendance、customer requests，**沒有 pipeline Task query**。所以可寫入的產品入口主要是 management command、Django Admin、排程與 Slack thread，而不是 GraphQL 或 dashboard。

來源：

- [`config/urls.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/config/urls.py)：只有 admin 與 GraphQL URL。
- [`api/schema.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/api/schema.py)：query-only schema，沒有 mutation/subscription，也未包含 pipeline query。
- [`api/views.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/api/views.py)：GraphQL 需 bearer token 或 staff session。
- [`pipeline/admin.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/pipeline/admin.py)：Event、Workflow、Run、Task、Delivery、Feedback 的實際管理介面；可 requeue event、編輯 task、套用已核准 prompt revision。
- [`Makefile`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/Makefile)：面向操作者的 standup、refresh、follow-up、customer-request 命令集合。

因此「成品」較準確的描述是：**由排程自動跑、在 Slack 交付工作、由 CLI/Admin 設定與補救的內部 operations bot**。

### 1.2 Standup／attendance 流程

實際流程是：

1. `fetch_slack_users` 與 GitHub member sync 建立使用者／Member mapping；
2. `import_attendance_gapi` 從 Google Calendar 匯入請假；
3. `import_slack_standups` 從固定 team channels 匯入 standup；
4. `list_missing_standups` 計算缺交者；
5. `send_standup_reminders` 對每個 team channel 發提醒或全員完成訊息，並跳過台灣假日。

GitHub Actions 已提供平日 11:00 Taipei 的 reminder 與 13:00 summary；這是可執行 workflow，不只是描述。

來源：

- [`README.md`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/README.md)：app 架構、standup 匯入命令與先決 scope。
- [`slack_integration/management/commands/send_standup_reminders.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/slack_integration/management/commands/send_standup_reminders.py)：查缺交、holiday gate、Slack mention/post 的可運作程式。
- [`.github/workflows/daily-standup-reminder.yml`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/.github/workflows/daily-standup-reminder.yml)：checkout、安裝、migrate、匯入與發送的完整自動化。
- [`AUTOMATION_SETUP.md`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/AUTOMATION_SETUP.md)：Actions secrets 與排程設定。

### 1.3 GitHub issue follow-up：最清楚的人工 Task 產生入口

這是 upstream 一個明確、可操作的「建立工作」入口：

```text
make add-followup
  → 互動詢問 existing/new issue、repo、team、cadence
  → manage.py add_followup
  → 必要時呼叫 GitHub API 建 issue／同步 mirror
  → 建立 pipeline Task(queue=followup)
  → 寫 Delivery 並在 team Slack channel 發 thread anchor
  → 定期 ingest Slack replies 與 GitHub issue state
  → workflow tools 更新進度、催問／升級，或 issue close 時結案
```

`add_followup` 同時支援既有 issue（`--issue`）與新 issue（`--title --text`），且要求 team；這就是 upstream 中最接近「task create form」的入口，只是它是 CLI wizard，不是 web form 或 chat command。

後續迴路也已落地：Slack ingestor 掃描每個 open follow-up 的 anchor thread；GitHub ingestor refresh issue，遇到 closed 產生 `github.issue_closed`；registered tools 處理 reply、nudge、close。回覆先做 `done:/wip:/blocked:/approve:/reject:` 等 deterministic parsing，必要時可呼叫 LLM，並將狀態變更與 feedback 記錄回 pipeline。

來源：

- [`Makefile`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/Makefile)：`make add-followup` 的互動流程。
- [`followup/management/commands/add_followup.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/followup/management/commands/add_followup.py)：GitHub issue 建立／取得、`Task.objects.create`、Slack anchor 與 comment sync。
- [`followup/ingestors.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/followup/ingestors.py)：`slack` 與 `github` ingestors。
- [`followup/pipeline_tools.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/followup/pipeline_tools.py)：`followup.handle_reply`、`followup.nudge`、`followup.close_on_issue` 的外部副作用與 task transition。
- [`pipeline/replies.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/pipeline/replies.py)：規則優先、LLM fallback 的 reply intent 解析與套用。

### 1.4 Customer request 流程：Task 的另一個實際產生器

Customer request 不是由使用者逐筆新增，而是批次從 customer channel 對話推導：

1. `import_slack_channel`／transcript importer 將訊息寫成 immutable `Event(kind=customer.message, state=logged)`；
2. `process_customer_day` 每 channel／day 讀當日 messages + 現有 open Task；
3. 一次 LLM call 回傳 daily summary、`new_requests`、`resolved`；
4. 每個 new request 建 `Task(queue=customer-requests, kind=contact)`；resolved id 直接結案；
5. `post_open_requests` 先補跑 missing/failed days，再把 open items 發到 Slack，Delivery key 防同日重複發送；
6. AM thread replies 可再同步 resolution。

來源：

- [`customer_requests/pipeline_ingest.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/customer_requests/pipeline_ingest.py)：Slack record → `customer.message` Event 的單一 funnel，含 bot-message skip 與 actor mapping。
- [`customer_requests/management/commands/process_customer_day.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/customer_requests/management/commands/process_customer_day.py)：可供 scheduler/CLI 使用的日期、channel、dry-run 入口。
- [`customer_requests/classifier.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/customer_requests/classifier.py)：一日一次 classification，實際建立／resolve Task 並記 WorkflowRun。
- [`customer_requests/management/commands/post_open_requests.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/customer_requests/management/commands/post_open_requests.py)：補跑、fail-closed、Slack digest 與 Delivery dedupe。
- [`customer_requests/migrations/0007_seed_pipeline_rows.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/customer_requests/migrations/0007_seed_pipeline_rows.py)：customer classifier/resolution prompts；兩個 workflow 初始 **disabled**，需 admin staged activation。

### 1.5 通用 pipeline 背景工作流

通用管線由四個管理命令組成：

- `ingest_events`：poll enabled `EventSource`，以 `(source, external_id)` 去重，失敗記到 source health；
- `run_workflows`：讀 pending Event，先 deterministic trigger，再視需要一次 LLM routing，執行 tools／LLM，產生 Task/Event/Delivery；
- `sweep_tasks`：把 overdue／nudge-due 轉成 Event，不直接通知；
- `improve_workflows`：累積足夠 bad feedback 後產生 prompt revision review Task，絕不自動套用。

重要語義包括：run 在效果前先落地、task/delivery 有 dedupe key、外部 send 先 claim Delivery、workflow prompt 有版本、feedback 可注入後續 prompt。這些都有 source 與 tests，不只是架構圖。

來源：

- [`pipeline/management/commands/ingest_events.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/pipeline/management/commands/ingest_events.py)
- [`pipeline/management/commands/run_workflows.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/pipeline/management/commands/run_workflows.py)
- [`pipeline/management/commands/sweep_tasks.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/pipeline/management/commands/sweep_tasks.py)
- [`pipeline/management/commands/improve_workflows.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/pipeline/management/commands/improve_workflows.py)
- [`pipeline/engine.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/pipeline/engine.py)
- [`pipeline/improve.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/pipeline/improve.py)

## 2. 核心資料模型

### 2.1 Identity 與 domain mirrors

`organization.Member` 是跨來源 identity 的中心，連接 Team、SlackUser 與 GitHub User；confidence／verification 欄位用於處理 mapping 不確定性。周邊 app 保留 GitHub repository/issue/PR/commit/review mirror、Slack standup/user、attendance，以及 customer channel 設定。

來源：

- [`organization/models.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/organization/models.py)
- [`github_monitor/models.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/github_monitor/models.py)
- [`slack_integration/models.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/slack_integration/models.py)
- [`attendance/models.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/attendance/models.py)

### 2.2 Pipeline 八模型

| 模型              | 產品責任                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `EventSource`     | 來源開關、cursor、health、連續失敗                                                                       |
| `Event`           | immutable inbound／internal fact；以 kind + subject URN 表達跨 domain 事件                               |
| `Workflow`        | trigger、prompt、tools、creates、scope、autonomy、priority                                               |
| `WorkflowVersion` | prompt/tool snapshot 與 feedback proposal provenance                                                     |
| `WorkflowRun`     | event×workflow attempt、routing reason、model/token/cost、output/error                                   |
| `Task`            | human work item；queue/kind、assignee/team、priority/status/approval/outcome、due/nudge、proposed action |
| `Delivery`        | 所有 outbound effect 的 request/response/status/external ref 與 dedupe guard                             |
| `Feedback`        | existence/routing/assignment/priority/content/timing 的 good/edit/wrong 判斷                             |

資料庫約束承擔關鍵 idempotency：Event `(source, external_id)`、WorkflowRun `(event, workflow, attempt)`、Task/Delivery dedupe key。`Task.save()` 被視為 human edit 並觸發 implicit feedback；pipeline 自身用 queryset `.update()` 避免誤判成人工編輯。

來源：[`pipeline/models.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/pipeline/models.py)、[`pipeline/signals.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/pipeline/signals.py)、[`pipeline/transitions.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/pipeline/transitions.py)。

## 3. 整合來源

| 整合                                                                         | 實際用途                                                                                             | 狀態                                                                        |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Slack Web API                                                                | user sync、standup import/reminder、customer channel import/digest、follow-up thread/reply/reaction  | 已實作                                                                      |
| GitHub REST API                                                              | org/repo/user、issue/comment、commit、PR/review mirror；建立 issue；follow-up close detection        | 已實作                                                                      |
| Google Calendar API                                                          | attendance／leave import                                                                             | 已實作                                                                      |
| LLM providers                                                                | customer classification、reply quality/fallback、generic workflow execution/routing、prompt revision | 已實作；由 config 選 provider                                               |
| GraphQL                                                                      | authenticated read-only organization/Slack/GitHub/attendance/customer data                           | 已實作但不含 pipeline Task，無 mutation                                     |
| GCS                                                                          | SQLite daily backup                                                                                  | 文件描述為部署環境 periodic event；repo 內不是完整 scheduler implementation |
| Email、LINE、WhatsApp、Teams、WeChat、Discord、meeting transcript、documents | Customer OS 願景中的來源                                                                             | 僅設計，repo 無 connectors                                                  |

LLM 預設 customer flow 走 Agent-Model；可切 OpenAI。Google Vertex/GenAI 套件也在依賴中。來源：[`config/llm.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/config/llm.py)、[`ENV_SETUP.md`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/ENV_SETUP.md)、[`agent-native-action-items.md`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/agent-native-action-items.md)。

## 4. 部署與設定方式

Upstream 是 Python 3.11 + Django 5.2 + SQLite 專案，以 `uv` 管依賴。基本流程是：

```bash
uv sync
cp .env.example .env
uv run python manage.py migrate
uv run python manage.py createsuperuser   # 若要用 Admin
uv run python manage.py runserver          # admin/graphql
```

主要設定：

- `SLACK_BOT_TOKEN`：Slack read/write；不同流程需要 history/read/users/chat/reactions scopes；
- `GITHUB_TOKEN`、可選 `GITHUB_ORG`：repo mirror 與 issue operation；
- `GOOGLE_SERVICE_ACCOUNT_KEY`、`GOOGLE_CALENDAR_ID`：attendance；
- LLM provider/model credentials；
- `SECRET_KEY`、`DEBUG`、`ALLOWED_HOSTS`、可選 `DATABASE_NAME`；
- `AGENT_PM_API_TOKEN`：GraphQL bearer auth。

資料預設在 `db.sqlite3`。settings 中預設 `DEBUG=True` 且有 insecure fallback secret，因此 production 必須覆寫；repo 沒有 Dockerfile、systemd/ASGI process manager 或完整 production deployment manifest。排程有兩套第一方說明：

1. GitHub Actions 的 standup reminder/summary；
2. `SCHEDULE.md` 所述 `/workspace/events/*.json` bot periodic events，執行 Make targets／commands，並提到 18:00 GCS backup。

這兩套文件部分互相矛盾（例如 backup 時間／expected output），顯示排程屬於特定內部部署，而非 repo 一鍵完成的標準產品部署。pipeline 設計明確選 cron、無常駐 worker、無 inbound webhook、無 queue，因此最低延遲受 cron 間隔限制。

來源：

- [`pyproject.toml`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/pyproject.toml)
- [`.env.example`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/.env.example)
- [`config/settings.py`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/config/settings.py)
- [`ENV_SETUP.md`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/ENV_SETUP.md)
- [`AUTOMATION_SETUP.md`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/AUTOMATION_SETUP.md)
- [`SCHEDULE.md`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/SCHEDULE.md)

## 5. 可運作實作 vs. 設計／未完成

### 已有可執行 code path

- Django Admin 檢視／編輯 pipeline rows、requeue failed/skipped event、套用 approved workflow revision。
- GitHub、Slack、Calendar import/sync 與 standup reminders。
- `make add-followup`／`add_followup` 建 GitHub issue follow-up Task 並發 Slack anchor。
- Slack reply 與 GitHub close ingestors，以及 follow-up reply/nudge/close tools。
- Customer Slack message ingestion、daily LLM classification、Task create/resolve、open-item digest。
- 通用 Event/Workflow/Run/Task/Delivery/Feedback schema、routing、validation、dedupe、sweep、feedback injection 與 prompt-revision proposal。
- Authenticated read-only GraphQL（但不是 pipeline API）。
- 廣泛的 unit/integration tests（例如 `pipeline/tests/`、`customer_requests/tests_pipeline/`、`followup/tests_pipeline/`）。

### 已寫在設計或介面中，但不是完整產品能力

- **Customer OS 全貌**：`agent-native-action-items.md` 的多來源 customer memory、CRM update、translation、auto reply、dashboard、customer health、Goal Agent 與多-agent orchestrator 都是產品構想，repo 沒有對應完整模型/UI/connectors。
- **一般化任意來源 ingestion**：pipeline interface 支援 poll/push/clock/internal，但 generic core 的原始註解明說第一版只註冊 clock；目前真實 ingestors 是 follow-up Slack/GitHub 與 domain-specific customer import，不是 email/calendar/customer chat universal event bus。
- **任意 data-defined workflow execution**：engine 可執行 prompt/tools，但 tool registry 只有 follow-up domain tools；不是一個已有大量可組裝 actions 的 automation marketplace。
- **自動 prompt improvement**：可產生 review Task；必須人工 approve 並由 Admin action 套用，故不是 autonomous self-improvement。
- **Dashboard／board**：設計文件有 board 與 dashboard，但 milestone 明說 boards 從未實際使用、決定移除；目前只有 Django Admin。
- **GraphQL pipeline surface**：pipeline models 已存在，API schema 尚未 expose；自然也沒有 task mutation/create。
- **push/webhook/queue**：設計明確排除；背景工作由 cron polling。
- **完整 production packaging**：缺少標準容器、process manager、部署 IaC 與統一 scheduler；現況偏 organization-specific deployment。

判讀設計文件時應以其狀態與 source 為準：[`docs/superpowers/specs/2026-07-30-event-workflow-task-design.md`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/docs/superpowers/specs/2026-07-30-event-workflow-task-design.md) 是 approved behavior authority，但末段仍列 Customer/Conversation、retention、GraphQL exposure 等未決題；[`milestone.md`](https://github.com/livingbio/agent-pm/blob/ae7c5efd6dd4a43ac64651ebfdf0efb8d70495ad/milestone.md) 也明載遷移與未決狀態。

## 6. 與 mikan `deploy/examples/extensions/agent-pm` 的功能差距

### 6.1 對照表

| 能力                  | Upstream                                                                                            | mikan extension example                                                | 差距                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| 使用者入口            | CLI/Make、Slack threads、Django Admin、read-only GraphQL                                            | `/pm status                                                            | ingest                                                        | run | sweep | all`、agent tool `pm_task list/show/close` | mikan 沒有 create wizard、Admin、GraphQL、Slack task interaction |
| Identity              | Member/Team + Slack/GitHub mapping + holidays                                                       | schema 有 members/teams/team_members/holidays，但沒有 importer/seed/UI | 表存在但通常為空                                              |
| Event sources         | clock、Slack replies、GitHub issue state、customer Slack imports，加上舊式 activity/calendar import | `SOURCES` 只有 `clock`                                                 | 無真實業務輸入                                                |
| Workflows             | customer classify/resolution、follow-up reply/nudge/close、generic engine                           | 只 seed `pipeline_heartbeat`，只註冊 heartbeat handler                 | 沒有 creates=task 的 runnable workflow                        |
| Task 建立             | `add_followup`、customer classifier、generic engine output、improvement proposal                    | 無 create command/tool；heartbeat creates delivery                     | 正常流程不會產生 Task                                         |
| Task 操作             | Admin edit、Slack reply transitions、issue close、CLI/domain commands                               | `pm_task` 僅 list/show/close                                           | 無 progress/block/reassign/approve/reject/thread reply        |
| Delivery              | Slack SDK + thread anchors/replies/reactions、domain routing                                        | `api.notify`，test/live diversion，message id 記錄                     | 基礎 send/dedupe 有，task delivery/reply consumption 無       |
| Feedback              | signals、reply/admin capture、多 dimensions、next-run injection                                     | close 為 no_action/invalid 時只寫 existence/wrong                      | mikan 沒有一般 correction capture/injection                   |
| Improvement           | feedback threshold → proposal Task → Admin approval/apply                                           | README 明列 `improve_workflows` 未實作                                 | 完全缺少改善迴路                                              |
| Background scheduling | 外部 cron/Actions/periodic events                                                                   | mikan callback schedules，四個 schedule 名稱                           | mikan host integration 較完整，但第四個 callback 實際是 no-op |
| Domain product        | standup、leave、GitHub metrics/follow-up、customer requests                                         | heartbeat proof-of-life                                                | 幾乎全部 domain feature 未移植                                |
| Storage/API           | Django ORM/SQLite/Admin/read GraphQL                                                                | `node:sqlite` shared extension data；無 API/UI                         | 可攜但只供 extension 內部使用                                 |

mikan 來源：

- [`deploy/examples/extensions/agent-pm/README.md`](../../deploy/examples/extensions/agent-pm/README.md)
- [`deploy/examples/extensions/agent-pm/src/index.ts`](../../deploy/examples/extensions/agent-pm/src/index.ts)
- [`deploy/examples/extensions/agent-pm/src/pipeline/ingest.ts`](../../deploy/examples/extensions/agent-pm/src/pipeline/ingest.ts)
- [`deploy/examples/extensions/agent-pm/src/pipeline/run.ts`](../../deploy/examples/extensions/agent-pm/src/pipeline/run.ts)
- [`deploy/examples/extensions/agent-pm/src/workflows/seeds.ts`](../../deploy/examples/extensions/agent-pm/src/workflows/seeds.ts)
- [`deploy/examples/extensions/agent-pm/src/workflows/handlers.ts`](../../deploy/examples/extensions/agent-pm/src/workflows/handlers.ts)
- [`deploy/examples/extensions/agent-pm/src/delivery.ts`](../../deploy/examples/extensions/agent-pm/src/delivery.ts)

### 6.2 為何目前 mikan 版本沒有 Task 產生入口

不是單一 bug，而是四個刻意裁切疊加的結果：

1. **唯一 ingest source 是 clock。** `src/pipeline/ingest.ts` 的 `SOURCES` 只有 `clock`；沒有 Slack reply、GitHub、customer chat、calendar 等 event source。
2. **唯一 seeded workflow 是 heartbeat，且 `creates: "delivery"`。** `src/workflows/seeds.ts` 沒有任何 `creates: "task"` workflow；`src/workflows/handlers.ts` 也只有 `pipeline_heartbeat`，只查 queue counts 並通知。
3. **對 agent 暴露的 `pm_task` 工具明確是 read/close view。** schema 的 action enum 只有 `list | show | close`；工具 body 沒有 INSERT task。註解也寫「Workflows create tasks」，表示設計上不讓人透過此工具任意新增。
4. **upstream 的兩個真正 task producers 被 README 明確列為未移植範圍。** mikan README 說 chat/repository/calendar ingest sources 與 `improve_workflows` 因 credentials 和 organization identity data 而省略；而 upstream 的 task producers 正是 `add_followup`（GitHub + team identity）、customer classifier（Slack customer data + LLM），以及 improvement proposal。

所以目前實際閉環是：

```text
clock event → pipeline_heartbeat → Delivery
```

而不是：

```text
business event → creates=task workflow → Task → task notification → human reply Event → Feedback
```

雖然 `src/db.ts` 已建立完整 `tasks` table、`run.ts` 也具備 workflow execution bookkeeping，但「有容器」不等於「有 producer」。除非人工直接改 SQLite（不是產品入口），fresh install 的 task count 會一直是 0；`sweep_tasks` 也只能掃既有 task，因此不會自行創造第一筆 task。

另外，mikan `src/index.ts` 的頂端概念註解仍提到四個 callbacks（含 `improve_workflows`），但實際 `SCHEDULES` 與 callback registration 只有 ingest、run、sweep 三個；README 也明說 improvement 未實作。這是尚未同步的概念說明，不是可運作的 prompt improvement。

### 6.3 mikan 已保留、而且確實可運作的價值

這個 example 並非空殼；它保留並示範了可重用的 infrastructure：

- shared `node:sqlite` schema 與 migrations；
- mikan callback schedules，且以 `controlConversationId` 避免每個 conversation 重複註冊；
- `/pm` deterministic command，可手動跑 stage；
- `api.subagent.run` 的 structured routing seam；
- Delivery unique key、test-mode diversion、message-id capture；
- pending/skipped/failed 可觀測性；
- `pm_task` list/show/close 與最小 existence feedback；
- 一個能端到端驗證 clock → workflow → notify 的 heartbeat。

但定位應是 **pipeline extension reference／vertical slice**，不能當成 upstream 產品的 mikan port。

## 7. 結論

Upstream 的核心價值不是抽象 pipeline 本身，而是已接上 Living Bio identity、Slack、GitHub、Calendar 與 customer operations 的 domain workflows；其「產品入口」多半是排程、CLI/Admin 和 Slack，而非 dashboard。mikan example 移植的是架構 seam，而非 domain deployment。它目前無 task 產生入口的直接原因，是沒有業務 ingestor、沒有 creates-task workflow/handler、沒有 create tool/command，且唯一 heartbeat 只產生 Delivery。若要達到 upstream 的最小產品等價，至少要先選一條垂直流程（例如 GitHub follow-up），同時補齊 identity mapping、source ingest、task-producing workflow、initial delivery/thread anchor、reply ingestion 與 transition/feedback；只增加一個 `pm_task create` 並不能重建 upstream 的產品迴路。
