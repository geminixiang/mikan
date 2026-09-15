# mikan 設定、秘密、Vault 與控制狀態位置盤點

日期：2026-09-15。以已提交 `c615047` 為準；OpenConnector 未提交實驗不算現行設計。本文件只盤點，不批准新增目錄或改啟動方式。

本輪讀取 mikan source、相關 Pi provider implementation、部署範本，並唯讀蒐集 VM 檔名／類型／mode／數量。不讀秘密、對話或排程內容，不呼叫有 migration 副作用的 resolver。VM metadata：2026-09-15T14:52:46Z；本機 `/tmp/mikan-storage-vm-metadata.json` 與 `/tmp/mikan-storage-vm-extra.json`（0600）。不是掃描每一個任意外部工具的所有檔案；可配置任意路徑者另列，不假稱有限清單涵蓋任意 bash/MCP 副作用。

## 1. 根路徑並未統一

| 記號               | 實際解析方式                                                                                    | VM 路徑                               |
| ------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| `S` stateDir       | `--state-dir` > `STATE_DIR` > `MIKAN_STATE_DIR` > `homedir()/.mikan`；相對路徑依程序 cwd        | `/root/.mikan`（既有部署證據）        |
| `W` workspace      | CLI positional directory；無則 `S/workspace`                                                    | `/root/.mom/data`（既有啟動參數證據） |
| `H` runtime home   | Node `homedir()`，不是安裝 npm package 的使用者目錄                                             | `/root`                               |
| models file        | `defaultModelsJsonPath()` 固定 `H/.mikan/models.json`，不跟隨 S；embedder 可傳 `modelsJsonPath` | `/root/.mikan/models.json`            |
| bootstrap env file | onboard 寫 `S/mikan.env`；PM2 範本固定讀 `H/.mikan/mikan.env`                                   | `/root/.mikan/mikan.env`              |
| PM2 state          | process manager 的 PM2_HOME/default，而非 S                                                     | `/root/.pm2`                          |
| temp               | Node `tmpdir()` / runtime cwd，非 S                                                             | OS / executor 決定                    |

來源：`src/cli/arg-grammar.ts:30-55`、`cli/boot.ts:29-80`、`harness/models.ts:95-98,249-252`、`cli/onboard.ts:188-240`、`deploy/pm2/ecosystem.config.cjs:57-93`、`env-manifest.ts:14-29`。

**重要：daemon 沒有自動讀 `S/mikan.env`。** PM2 loader 或 shell source 把內容注入 process env。改 stateDir 不會自動改 PM2 env file 或 models file。一般 env 名稱優先於 MIKAN_ alias；provider/OTEL 等標準 env 不能一概假設支援同樣 alias。

## 2. 正式設定與秘密儲存

| 路徑／載體                                            | 內容、寫入者與讀者                                                                                      | Sandbox / Agent                                                                 | 生命週期                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `S/settings.json`                                     | global LLM selection、sandbox、Slack、MCP、Sentry；onboard/Admin/settings mutation 寫，config 讀        | managed projection 不掛載；Admin 能改                                           | 0600 atomic write；不是純非秘密設定，MCP env/headers 與 Sentry DSN 可在此  |
| `S/conversations/K/settings.json`                     | Office override；host config/Admin 写                                                                   | 不掛載，但既有管理入口授權仍待補                                                | 懶遷移可由讀取觸發；不存在時寫 `{}` marker                                 |
| `H/.mikan/models.json`                                | provider/model catalog，可能包含 literal apiKey、headers；人工/onboard 寫                               | host model resolver 讀；無預設 sandbox 注入                                     | onboard 0600 並拒絕覆蓋現有檔；人工檔 mode 不保證；讀取失敗可回退 builtins |
| `S/mikan.env`（onboard）／`H/.mikan/mikan.env`（PM2） | platform/API/OAuth bootstrap/OpenConnector admin/Cloudflare/OTLP secrets 與一般設定混合                 | process env；managed native execution 不直接繼承全部 host env；host mode 無隔離 | onboard 0600；PM2 load/source；無自動 rotation                             |
| `GITHUB_APP_PRIVATE_KEY_PATH` 指向任意檔              | GitHub App PEM；也可 inline `GITHUB_APP_PRIVATE_KEY`                                                    | host App auth 使用                                                              | main 讀路徑檔；不由 mikan 建立／刪除                                       |
| `S/conversations/K/open-connector-runtime-token.json` | **HEAD 現行** origin/name/id/raw runtime token，host provisioning 自動寫／重用                          | 不進 managed sandbox/Vault                                                      | 0600；無自動 revoke，搬／刪 local 不等於 revoke remote                     |
| `S/vaults/K/env`                                      | Office API key/OAuth access/refresh token 等；login/Vault 寫                                            | 授權執行會注入 env，Agent 可使用/讀取                                           | 0600，upsert/clear；shared copy 不隨來源更新                               |
| `S/vaults/K/<file or subtree>`                        | secret files、SSH/kube/CLI credentials；login/Vault 寫                                                  | 依推導 target 掛載，目前未標 ro                                                 | 0600 files、0700 dirs（寫入 helper）；credential consumer 也可能改掛載檔   |
| `S/vaults/shared/<profile>/env` 與 files              | 可命名共享登入 profile；shared login/Vault 管理                                                         | 不直接等於唯讀 host secret store；可複製到各 Office 後注入                      | copy 是實體複製，來源刪除不撤銷下游                                        |
| `S/vaults/<user/container-derived-key>/...`           | host/shared-container credential identity；新 key 有 hash，部分精確 legacy fallback                     | backend/runner wiring 決定注入；不能僅看 helper 推斷 host 自動注入              | 與 OfficeKey vault 並存，不可亂合併                                        |
| process env / MCP config args                         | MCP command/args/env、HTTP URL/headers 可包含秘密；provider custom env keys、OAUTH_SERVICES_JSON 可擴展 | MCP 在 host 執行；取決於 SDK ambient env + explicit config                      | secret 不一定有 file；任意 MCP 可以另外建立自己的 state                    |

來源：`src/config.ts`、`src/harness/models.ts`、HEAD `harness/open-connector.ts`、`src/vault/index.ts`、`sandbox/identity.ts`、`adapters/web/login/{portal,oauth}.ts`、`harness/mcp.ts:186-207`、`main.ts:558-560`。

### Vault 不是只有 token JSON

| Vault 中的相對位置                | Sandbox target                                              |
| --------------------------------- | ----------------------------------------------------------- |
| `env`                             | 作為 execution env，不作為普通 file mount                   |
| `gws.json`                        | `/root/.config/gws/credentials.json`                        |
| `gcloud-adc.json`                 | `/root/.config/gcloud/application_default_credentials.json` |
| `.ssh/`                           | `/root/.ssh`                                                |
| `.kube/`                          | `/root/.kube`                                               |
| `.config/gh/`                     | `/root/.config/gh`                                          |
| `.sentryclirc` 或其他一般相對路徑 | `/root/<relative-path>`                                     |

來源：`vault/index.ts:209-237,311-360`。OAuth file-output defaults 在 `adapters/web/login/oauth.ts:39-102`；GitHub OAuth access/refresh token 寫 Vault env，Google authorized_user credentials 寫上列 files。自訂 OAuth services 可指定 fileOutput，不能只盤三個內建 provider。

### bootstrap secret 類別

已提交 `env-manifest.ts` 涵蓋 Slack app/bot、Telegram/Discord bot、GitHub App key/webhook、Anthropic/OpenAI、OAuth client secrets、**OPENCONNECTOR_ADMIN_TOKEN**、Cloudflare bridge token、Sentry DSN、OTLP headers/endpoints 等。除此之外 provider env、MCP env/header、custom OAuth env names 都可增加，manifest 不是全部可能 secret 的封閉集合。未提交的 RUNTIME_TOKEN 實驗不是現行部署 contract。

## 3. host state：不是 secret 但會決定行為

| 路徑                              | 作用／擁有者                                                   | 寫入與清理                                                          |
| --------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| `S/office-registry.json`          | Office inventory、enabled platforms、migration journal         | OfficeRegistry atomic 0600；不可當 cache 隨意刪除                   |
| `S/.office-registry.lock/owner`   | Registry mutation lease                                        | 0700 dir / 0600 owner；正常 release 刪除，stale detection           |
| `S/github-sync.json`              | GitHub intake/sync checkpoint                                  | GitHub bot atomic 0600；刪除可能改變 replay/sync 行為               |
| `S/conversations/K/channel-kind`  | host 記錄平台 visibility 類型                                  | projection writer atomic 0600；非 Agent 可自我宣告的分類            |
| `S/conversations/K/dream.json`    | 記憶整理 checkpoint                                            | Dream atomic 0600；MEMORY 成功後才推進                              |
| Portal Admin/session/login tokens | **只在記憶體 Map，不是 auth.json**                             | Admin 30m、viewer 24h、login 15m；restart 消失；SSE expiry 尚有缺口 |
| OAuth pending state               | **只在記憶體 Map**，含驗證狀態                                 | 10m；完成/過期清除，restart 中斷流程                                |
| Runtime queues/leases/task state  | 記憶體 lifecycle + native session durable state + taskRoot log | 沒有另一個獨立 host task database 可直接搬                          |

來源：`office/index.ts:258-300,887-954`、`dream/index.ts:130-135`、`main.ts:580`、`adapters/web/token-store.ts`、`web/{admin,session-view,login}/portal.ts`、`runtime/session-lifecycle.ts`。

## 4. workspace：工作資料與控制資料目前混在一起

| 路徑                                              | 消費者／控制力                                              | sandbox 可見性                                                     |
| ------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `W/MEMORY.md`                                     | global prompt memory                                        | shared-support public rw/private ro；full rw；isolated 不掛載      |
| `W/skills/**/SKILL.md` + scripts                  | host skill catalog + Agent 可用腳本；可影响其他 Office 指令 | shared-support/full rw；own skills 的 symlink guard 比 shared 嚴格 |
| `W/agents/*.md`                                   | subagent profile/prompt/model/tool configuration            | host runner 會載入，不依 sandbox catalog；full 可直接修改          |
| `W/events/*.json`                                 | host watcher 的排程控制 bus                                 | shared-support/full rw；event tool checks 不能防 direct file edits |
| `W/K/MEMORY.md`                                   | own memory，Dream/Agent 更新                                | own Office rw                                                      |
| `W/K/skills/**`                                   | own skills                                                  | own rw，host loads with symlink rejection                          |
| `W/K/auto-reply`, `auto-reply.disabled`           | **實際 Slack 行為開關**，內容忽略                           | own rw；不是 host-only settings                                    |
| `W/K/log.jsonl`                                   | platform history、task roots 等                             | own rw；不構成不可竄改 audit log                                   |
| `W/K/sessions/current`                            | active session pointer                                      | own rw，host selectors 讀                                          |
| `W/K/sessions/*.jsonl`                            | native session content、tool results、operations 等         | own rw；可能含工具輸出的秘密；viewer/Dream 也讀                    |
| `W/K/sessions/scoped-archive-*`                   | thread rotation/archive，可能 .corrupt                      | 同上；沒有自動全面 retention 政策                                  |
| `W/K/attachments/*`, `scratch/`, `repo/`          | 附件、工作檔、GitHub clone                                  | own rw；GitHub auth 不寫入 remote URL                              |
| `W/K/<generated-image>`                           | host image tool 產物                                        | own rw；不是統一 artifact 子目錄                                   |
| `W/SYSTEM.md` 或 `W/K/SYSTEM.md`                  | prompt 請 Agent 維護環境修改紀錄                            | 不是 host 自動讀取的系統設定檔                                     |
| `<executor cwd>/.mikan/bash-output/*.log`         | shell 截斷輸出的 spill，可能含秘密                          | executor 所在環境；不是 host stateDir                              |
| 任意 agent 專案 `.env`、CLI config、git config 等 | native bash/write/MCP 允許任意 authorized 工作              | 无法用固定檔名列完；需按 workspace/container 實際盤點              |

來源：`office/index.ts:185-219`、`office/projection.ts`、`config.ts:317-336`、`harness/{prompt,skills,subagent-profiles,execution-env}.ts`、`sessions/store.ts`、`adapters/shared.ts`、`adapters/github/repo.ts`。Full 掛載會讓以上其他 Office 資料都可讀寫。所有「own」仍受 effective backend/projection 影響。

## 5. 暫存、副本與外部持久層

| 位置                                                            | 內容                                                                    | 清理／風險                                                                         |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `tmpdir()/mikan-docker-env-*/env.list`                          | execution secret env 暫存                                               | 0700 dir/0600 file，正常 finally 清理；SIGKILL 不保證                              |
| `tmpdir()/mikan-upload-*/*`                                     | 從 executor 讀出的上傳資料                                              | private staging，正常 finally 清理                                                 |
| `tmpdir()/mikan-session-inspect-*/*.jsonl`                      | read-only inspection snapshot                                           | 0600 file，finally 清理；仍是真實內容副本                                          |
| `<target>.mikan-stage`, `.mikan-stage.b64`, `.mikan-append.b64` | native file operation intermediates                                     | executor/host backend 產生，abort/crash 可能殘留                                   |
| `.<filename>.<pid>.<random>.tmp`                                | atomic private writes 暫存 sibling                                      | 0600；crash 可留 orphan temp                                                       |
| session `.v3.bak`, `.pi-084.bak`, `.v4.tmp`, `.pi-085.tmp`      | session migration originals/intermediates                               | 原文備份仍可能含秘密，migration 不等於 erasure                                     |
| Docker container writable layer                                 | 安裝軟體、CLI 設定、可自行複製的秘密                                    | 不在 W/S 檔案樹內                                                                  |
| Docker `mikan-migrate:<containerName>` image                    | preserve writable layer / migration recovery，labels 含 mounts metadata | 改掛載會保留 layer；unmount 不是清除歷史副本                                       |
| PM2 `dump.pm2`, `dump.pm2.bak`                                  | 程序還原狀態，通常包含 process env                                      | 不是 mikan writer；可能是 bootstrap secrets 的第二份持久副本，不能只保護 mikan.env |
| PM2 logs / remote Sentry/OTLP / platform messages               | 運行記錄、工具錯誤、已交付資料                                          | 並非本機設定檔；依外部 retention。內容是否有 secret 不能僅憑 filename 判定         |
| 外部 OpenConnector DB                                           | token hashes、provider OAuth connections、policy                        | 由 OpenConnector 管理；mikan local delete 不撤銷遠端                               |

來源：`sandbox/container.ts:180-202`、`harness/prompt.ts:84-101`、`sessions/session-store.ts:348-373`、`file-guards.ts:105-145`、`sandbox/provisioner.ts:277-570`、`sessions/migrate-{v3,pi-084,common}.ts`。PM2 env persistence 是需進一步以安裝版 PM2 確認的外部機制；本輪沒讀 dump 內容，不能宣稱其中已確認有特定秘密。

## 6. Pi / ambient credentials：不要混為同一個登入系統

目前 `MikanModels.create()` 用 `builtinModels()`，未注入 file credential store；安裝 Pi models 預設為 `InMemoryCredentialStore`。沒有找到 mikan 的 `auth.json` 載入呼叫；`main.ts:494-495` 的 auth.json 註解是漂移，不能當成現行 contract。

- `~/.pi/agent/auth.json` 是 Pi 工具可能使用的 state，不能因存在就說 mikan 正在使用。
- `~/.mikan/auth.json` 並非本輪找到的現行 mikan 憑證來源。
- Pi provider 的 ambient credentials 仍可在別處：Google `GOOGLE_APPLICATION_CREDENTIALS` 或 `~/.config/gcloud/application_default_credentials.json`；AWS profile/env/web-identity token file/role chain 等。
- Host MCP 子程式與 host backend 可使用各工具自己的 `~/.config/gh/hosts.yml`、`.ssh`、`.kube`、`.aws`、`.docker/config.json`、`.npmrc`、`.sentryclirc` 等。這些不是 mikan 統一管理的檔案，也不保證全被使用。

來源：`harness/models.ts:249-252`；安裝 `pi-ai/dist/models.js:31-33`、`auth/context.js`、`providers/{google-vertex,amazon-bedrock}.js`；`harness/mcp.ts:186-207`。沒有執行任何 provider auth resolution。

## 7. Legacy 與 VM 實際發現

### 程式支援或保留的舊位置

- `W/<rawConversationId>/` → `W/K/`：OfficeRegistry journal/claim migration。
- `S/conversations/<rawConversationId>/` → `S/conversations/K/`。
- `W/K/settings.json` → `S/conversations/K/settings.json`：首次讀取遷移，沒有舊檔則建立空 marker；**不可隨意刪 marker 讓 Agent 檔案重新被信任**。
- `S/vaults/<legacy-derived-conversation-key>/` → `S/vaults/K/`：registry 驅動；collision 不覆蓋。
- 其他舊 user/container key 精確 fallback；未識別的 keys 不應猜測 owner。
- 舊 extensions/extension-data 不再代表有效 executable extension，但檔案可能保留。
- `~/.pi/{mom,mama,mikan,agent}`：不能只看名稱就自動搬/刪，可能属于其他程式。

來源：`office/index.ts:1029-1293`、`config.ts:258-302`、`vault/index.ts:369-388`、`sandbox/identity.ts`、ADR 0006。

### VM metadata（本輪新查，不含內容）

| 項目                                                   | 數量／狀態                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `S/conversations/*/settings.json`                      | 297，全部 0600                                                                                             |
| `dream.json`                                           | 178，全部 0600                                                                                             |
| `channel-kind`                                         | 55，全部 0600                                                                                              |
| OpenConnector runtime token file                       | 44，全部 0600                                                                                              |
| Office state 其他目錄                                  | `git` 1、`extension-data` 1、`extensions` 2；用途未從內容確認                                              |
| Vault root directories                                 | 83 OfficeKey dirs、277 未歸類 keys、1 shared namespace；277 不能未映射就判定無用                           |
| Vault files                                            | 1,444，全部 0600                                                                                           |
| Office/其他 key 的 immediate 檔名                      | `env`、`gcloud-adc.json`、`gws.json`、`.sentryclirc` 各 360；不代表內容相同                                |
| shared profile files                                   | env 1、其他 files 3；未讀 profile 名稱／內容                                                               |
| env backups                                            | 6 份，全部 0600；仍應視為可能 secret 副本                                                                  |
| models backups                                         | 2 份，0600                                                                                                 |
| `S/global/extension-data`                              | 存在，legacy/外部用途待確認                                                                                |
| `S/workspace`                                          | 存在但空；實際 workspace 在 `/root/.mom/data`                                                              |
| `/root/.pi/agent/`                                     | auth.json 0600；models.json、models.json.bak、settings.json 0644；sessions/bin dirs；不代表目前 mikan 消費 |
| `/root/.pm2/dump.pm2` 與 `.bak`                        | 存在，0644；未讀內容                                                                                       |
| `/root/.sentryclirc`                                   | 存在，0644；未讀內容                                                                                       |
| host gcloud ADC、gh hosts.yml                          | 存在，0600                                                                                                 |
| host gws credentials、.kube、.aws、.docker/config.json | 本輪指定位置未找到                                                                                         |

S root 0700、Vault root 0700。部分子目錄與 PM2 是 0755/0644；單看 mode 不代表其他使用者能讀，還取決於 `/root` 的 traversal 權限，不能據此宣稱已外洩。也不能把 host `/root/.config/gws` 不存在，誤認為 Vault 掛進 container 的 gws credentials 不存在：那是不同 filesystem。

## 8. 已確認的不一致與未完成盤點

1. stateDir、models、PM2 env 三個 root 選擇不一致。
2. secrets 分散在 bootstrap env、settings MCP、models、Vault、derived integration files、ambient CLI credentials；「settings 不含 secrets」不成立。
3. Office state 與 Office Vault 分在兩棵樹；另有大量未分類 Vault keys，需 registry 映射後才能解釋。
4. workspace 同時放工作資料、排程控制、auto-reply policy、session pointer/history、共享可执行 guidance。
5. 登入 capability 一部分 memory-only，一部分 persisted file，一部分 external service；統一搬目錄不會統一生命週期。
6. PM2 dumps、備份、Docker writable layer、temp、session output 都可能是秘密副本，不能只盤主要 JSON。
7. paused OpenConnector experiment 尚未復原/採納；本次未改產品檔或 VM。

**仍待驗證**：277 Vault keys 的逐一 metadata 映射、歷史 extension 目錄內容的來源、安裝版 PM2 dump 語意與有效上層 permissions、Docker images/containers 的完整 mounted-source inventory、外部 MCP/Cloudflare/LLM provider 的實際啟用與任意自訂路徑。需先明確範圍再讀，不能以「所有」為由讀出一切秘密或整台 host 使用者資料。

這份盤點優先回答現況；不再以一個新的 integrations 目錄代替對整體 ownership 的決定。
