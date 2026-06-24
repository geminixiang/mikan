---
title: mikan 架構
description: 了解 mikan 的平台接入、工作階段、agent、sandbox、vault 與 web portal 如何串接。
---

## 1. 系統總覽

```mermaid
flowchart LR
  subgraph Clients["聊天平台"]
    Slack["Slack"]
    Telegram["Telegram"]
    Discord["Discord"]
  end

  subgraph Adapters["平台轉接器"]
    SlackAdapter["src/adapters/slack/*"]
    TelegramAdapter["src/adapters/telegram/*"]
    DiscordAdapter["src/adapters/discord/*"]
  end

  subgraph Runtime["核心執行階段"]
    Main["src/main.ts\nCLI 啟動"]
    SessionRuntime["src/runtime/session-runtime.ts\nSessionRuntime + runner 快取"]
    Orchestrator["src/runtime/conversation-orchestrator.ts\n執行生命週期 + 指令"]
    AgentRunner["src/agent.ts\ncreateRunner()"]
  end

  subgraph AgentStack["Agent 堆疊"]
    PiAgent["@earendil-works/pi-agent-core\nAgent"]
    PiCoding["@earendil-works/pi-coding-agent\nAgentSession / SessionManager / Skills"]
    PiAI["@earendil-works/pi-ai\nprovider + 模型"]
    MikanTools["src/tools/*\nread / bash / edit / write / event / attach"]
    Executor["src/sandbox/*\nExecutor\nshared: host / container\nisolated: image / firecracker / cloudflare"]
  end

  subgraph Persistence["專案工作區"]
    ConversationDir["<workspace>/<conversation>/\nlog.jsonl / MEMORY.md / attachments / skills"]
    Sessions["sessions/\ncurrent + *.jsonl"]
    EventsDir["events/*.json"]
    LocalSettings["<conversation>/settings.json"]
  end

  subgraph StateDir["狀態目錄 (~/.mikan 或 --state-dir)"]
    GlobalSettings["settings.json\nglobal defaults"]
    Vaults["vaults/\nconversation-scoped secret 目錄"]
    LinkTokens["admin/login/session tokens\nin-memory stores"]
  end

  subgraph Services["輔助服務"]
    VaultManager["src/vault/index.ts\nFileVaultManager"]
    Provisioner["src/provisioner.ts\nDockerContainerManager"]
    LinkServer["src/web/login/portal.ts\nlink/admin/session portal host"]
    SessionViewer["src/web/session-view/*\nweb session viewer"]
    EventsWatcher["src/events.ts\n監看 + 排程事件"]
  end

  Slack --> SlackAdapter
  Telegram --> TelegramAdapter
  Discord --> DiscordAdapter

  SlackAdapter --> Main
  TelegramAdapter --> Main
  DiscordAdapter --> Main

  Main --> SessionRuntime
  SessionRuntime --> Orchestrator
  SessionRuntime --> AgentRunner

  AgentRunner --> PiAgent
  AgentRunner --> PiCoding
  AgentRunner --> PiAI
  AgentRunner --> MikanTools
  MikanTools --> Executor

  Main --> VaultManager
  Main --> Provisioner
  Main --> LinkServer
  Main --> EventsWatcher
  LinkServer --> SessionViewer

  AgentRunner --> ConversationDir
  AgentRunner --> Sessions
  Main --> GlobalSettings
  EventsWatcher --> EventsDir
  VaultManager --> Vaults
  LinkServer --> LinkTokens

  Executor -. shared: host / container; isolated: image / firecracker / cloudflare .-> ConversationDir
  Provisioner -. isolated image sandbox lifecycle .-> Executor
  VaultManager -. env + mount routing .-> Executor
  EventsWatcher -. enqueue BotEvent .-> Main
```

## 2. 主要分層

### A. 平台接入層

平台接入層的完整說明請見 [平台接入層](platform-adapters.md)，各平台細節請見 [Slack](platform-adapters/slack.md)、[Discord](platform-adapters/discord.md)、[Telegram](platform-adapters/telegram.md)。

- `src/adapters/slack/*`
- `src/adapters/telegram/*`
- `src/adapters/discord/*`
- `src/adapter.ts`

職責：

- 接收 Slack / Telegram / Discord 原生事件
- 轉成統一的 `BotEvent`、`ChatMessage`、`ChatResponseContext`
- 依平台規則計算 `sessionKey`
- 封裝回覆、typing、working、檔案上傳等平台差異

### B. 核心協調層

- `src/main.ts`
- `src/runtime/session-runtime.ts`
- `src/runtime/conversation-orchestrator.ts`
- `src/sessions/store.ts`
- `src/sessions/chat-session-manager.ts`

職責：

- 啟動 CLI、讀取 env / args / `settings.json`
- 建立 `SessionRuntime` 作為各平台 bot 的 `BotHandler`
- 透過 `ConversationOrchestrator` dispatch `/login`、`/session`、`stop`、`new` 等控制命令
- 管理 `conversationStates` 與 per-session queue，避免同一 session 重複執行
- 決定每個 session scope 對應哪個 `AgentRunner`

### C. Agent 執行層

- `src/agent.ts`
- `src/context.ts`
- `src/tools/*`

職責：

- 建立 `AgentRunner`
- 載入模型、skills、memory、session context
- 將使用者訊息送入 `pi-agent-core` / `pi-coding-agent`
- 把 tool calls 接到本地 `read/bash/edit/write/event/attach`
- 把 tool 結果回寫 session，並透過 adapter 回傳給平台

### D. 執行環境層

- `src/sandbox/*`
- `src/provisioner.ts`
- `src/execution-resolver.ts`

職責：

- 統一抽象 `Executor`
- sandbox runtime 分成兩類：
  - shared: `host` / `container:<name>`，同一個 host 或指定 container 共用
  - isolated: `image:<image>` / `firecracker:*` / `cloudflare:*`，依 actor/conversation/vault 路由到隔離的執行環境
- 透過 `ActorExecutionResolver` 依 user/conversation/vault 決定實際 executor
- 在 `image` 模式下自動建立與回收 Docker container，並把 `image:<image>` 解析成 concrete `container:<name>` executor

### E. 狀態與持久化層

- `src/sessions/store.ts`
- `src/sessions/chat-session-manager.ts`
- `src/context.ts`
- `src/vault/index.ts`

職責：

- session 檔案管理： `sessions/current` 與 `*.jsonl`
- `log.jsonl` 與 structured session 的雙軌歷史保存
- workspace / conversation 級別 `MEMORY.md`
- per-conversation vault 憑證與 mount / env 注入

### F. 輔助服務層

- `src/web/login/*`
- `src/web/admin/*`
- `src/web/session-view/*`
- `src/events.ts`

職責：

- `src/web/login/portal.ts` 目前是 link server host，會掛接 login/vault、admin、session-view routes
- 提供 Web login portal，支援 API key 與 OAuth 寫入 vault
- 提供 admin portal，支援 conversation/settings/workspace/events/skills 管理與 link generation
- 提供 session viewer；目前可顯示 session timeline，且在 interactive wiring 啟用時可透過 `/session/message` 送訊息
- 監看 `events/*.json`，把排程事件重新注入 bot 流程

## 3. 訊息處理流程

```mermaid
sequenceDiagram
  participant U as User
  participant P as Slack / Telegram / Discord
  participant A as Adapter
  participant M as SessionRuntime / Orchestrator
  participant S as sessions/store.ts
  participant R as agent.ts / AgentRunner
  participant T as tools/*
  participant X as sandbox Executor
  participant W as Workspace / sessions

  U->>P: 發送訊息 / mention / reply
  P->>A: 平台事件
  A->>M: BotEvent + ChatMessage + ResponseContext
  M->>M: queue event + dispatch commands
  M->>S: resolve session scope
  S-->>M: contextFile + sessionDir
  M->>R: getState() / run()
  R->>W: 讀取 MEMORY.md / sessions/*.jsonl；必要時查 log.jsonl
  R->>R: 建立 system prompt / skills / model / session context
  R->>T: 執行工具
  T->>X: read / bash / edit / write / event / attach
  X-->>T: tool result
  T-->>R: 結果回傳
  R->>W: 寫入 structured session；adapter 記錄平台 log
  R-->>M: final response
  M-->>A: 回覆內容 / 診斷 / 檔案
  A-->>P: 平台訊息更新
  P-->>U: 使用者看到回覆
```

## 4. Session 與檔案佈局

`mikan` 的上下文不是只靠記憶體，而是主要落在 workspace 目錄:

```text
<workspace>/
├── MEMORY.md                  # workspace 級記憶
├── events/                    # 排程與外部事件
└── <conversationId>/
    ├── settings.json          # conversation-local overrides
    ├── MEMORY.md              # conversation 級記憶
    ├── log.jsonl              # 可 grep 的人類可讀訊息歷史
    ├── attachments/           # 平台附件下載
    ├── scratch/               # 執行中的工作區
    ├── skills/                # conversation 自訂 skills
    └── sessions/
        ├── current            # top-level session pointer
        ├── <timestamp>_<id>.jsonl
        └── <scope_id>.jsonl   # thread / reply scoped sessions
```

設計重點：

- `log.jsonl` 是平台對話紀錄：Slack/Discord/Telegram 實際發生過什麼
- `sessions/*.jsonl` 是 LLM 工作上下文/工作紀錄：mikan 拿什麼給 LLM 看，以及 LLM/tool 做了什麼
- top-level session 用 `current` 指標，但 `current` 不是 channel history；缺失時可從 `log.jsonl` 重建最近 top-level 工作上下文
- thread / reply session 用固定檔名，讓 scoped session 可被單獨追蹤
- Slack top-level 訊息共用 channel session；Slack thread replies 使用 `conversationId:threadTs`
- Slack events 會先建立 top-level anchor message，再用 `conversationId:anchorTs` 執行

## 5. Login / Vault / Sandbox 關係

```mermaid
flowchart TD
  User["User in DM"] --> LoginCmd["/login"]
  LoginCmd --> Main["main.ts"]
  Main --> LinkToken["InMemoryLinkTokenStore"]
  Main --> VaultRouting["vault-routing.ts"]
  Main --> LinkServer["web/login/portal.ts"]
  LinkServer --> Browser["Browser Portal"]
  Browser --> OAuth["OAuth provider / API key form"]
  OAuth --> LinkServer
  LinkServer --> VaultManager["vault.ts\nwrite env/file into vault"]
  VaultManager --> VaultDir["state-dir/vaults/<vaultId>/"]
  VaultManager --> Resolver["execution-resolver.ts"]
  Resolver --> Sandbox["host / container / image / firecracker / cloudflare"]
```

重點：

- 憑證不直接進 workspace
- vault 存在 `--state-dir`
- 執行時才由 conversation vault 路由到對應 sandbox
- `image` / `firecracker` / `cloudflare` 模式使用 per-actor/per-conversation vault routing；`container:<name>` 使用 shared container vault；`host` 不注入 vault env

## 6. Events 與一般對話的差異

`events/*.json` 會被 `EventsWatcher` 監看，之後轉成 `BotEvent` 再走一次正常流程。
也就是說 events 不是獨立執行器，而是「另一個訊息入口」。

這讓下列能力共用同一套機制:

- session context
- vault routing
- tool execution
- 平台回覆
- stop / running state 管理

## 7. 架構結論

如果用一句話總結，`mikan` 的核心其實是：

> 一個以 `main.ts` 為協調中心、以 `agent.ts` 為執行核心、以 `session/vault/sandbox` 為基礎設施的多平台 AI agent bot。

可以把它理解成 6 個核心子系統:

1. 平台轉接器
2. Bot runtime 協調
3. Agent + tools
4. Session/context 持久化
5. Vault + sandbox execution routing
6. Web/event side services
