---
title: mikan 架构
description: 了解 mikan 的平台接入、工作阶段、agent、sandbox、vault 与 web portal 如何串接。
---

## 1. 系统总览

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

## 2. 主要分层

### A. 平台接入层

平台接入层的完整说明请见 [平台接入层](platform-adapters.md)，各平台细节请见 [Slack](platform-adapters/slack.md)、[Discord](platform-adapters/discord.md)、[Telegram](platform-adapters/telegram.md)。

- `src/adapters/slack/*`
- `src/adapters/telegram/*`
- `src/adapters/discord/*`
- `src/adapter.ts`

职责：

- 接收 Slack / Telegram / Discord 原生事件
- 转成统一的 `BotEvent`、`ChatMessage`、`ChatResponseContext`
- 依平台规则计算 `sessionKey`
- 封装回覆、typing、working、档案上传等平台差异

### B. 核心协调层

- `src/main.ts`
- `src/runtime/session-runtime.ts`
- `src/runtime/conversation-orchestrator.ts`
- `src/sessions/store.ts`
- `src/sessions/chat-session-manager.ts`

职责：

- 启动 CLI、读取 env / args / `settings.json`
- 建立 `SessionRuntime` 作为各平台 bot 的 `BotHandler`
- 透过 `ConversationOrchestrator` dispatch `/login`、`/session`、`stop`、`new` 等控制命令
- 管理 `conversationStates` 与 per-session queue，避免同一 session 重复执行
- 决定每个 session scope 对应哪个 `AgentRunner`

### C. Agent 执行层

- `src/agent.ts`
- `src/context.ts`
- `src/tools/*`

职责：

- 建立 `AgentRunner`
- 载入模型、skills、memory、session context
- 将使用者讯息送入 `pi-agent-core` / `pi-coding-agent`
- 把 tool calls 接到本地 `read/bash/edit/write/event/attach`
- 把 tool 结果回写 session，并透过 adapter 回传给平台

### D. 执行环境层

- `src/sandbox/*`
- `src/provisioner.ts`
- `src/execution-resolver.ts`

职责：

- 统一抽象 `Executor`
- sandbox runtime 分成两类：
  - shared: `host` / `container:<name>`，同一个 host 或指定 container 共用
  - isolated: `image:<image>` / `firecracker:*` / `cloudflare:*`，依 actor/conversation/vault 路由到隔离的执行环境
- 透过 `ActorExecutionResolver` 依 user/conversation/vault 决定实际 executor
- 在 `image` 模式下自动建立与回收 Docker container，并把 `image:<image>` 解析成 concrete `container:<name>` executor

### E. 状态与持久化层

- `src/sessions/store.ts`
- `src/sessions/chat-session-manager.ts`
- `src/context.ts`
- `src/vault/index.ts`

职责：

- session 档案管理： `sessions/current` 与 `*.jsonl`
- `log.jsonl` 与 structured session 的双轨历史保存
- workspace / conversation 级别 `MEMORY.md`
- per-conversation vault 凭证与 mount / env 注入

### F. 辅助服务层

- `src/web/login/*`
- `src/web/admin/*`
- `src/web/session-view/*`
- `src/events.ts`

职责：

- `src/web/login/portal.ts` 目前是 link server host，会挂接 login/vault、admin、session-view routes
- 提供 Web login portal，支援 API key 与 OAuth 写入 vault
- 提供 admin portal，支援 conversation/settings/workspace/events/skills 管理与 link generation
- 提供 session viewer；目前可显示 session timeline，且在 interactive wiring 启用时可透过 `/session/message` 送讯息
- 监看 `events/*.json`，把排程事件重新注入 bot 流程

## 3. 讯息处理流程

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

## 4. Session 与档案布局

`mikan` 的上下文不是只靠记忆体，而是主要落在 workspace 目录:

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

设计重点：

- `log.jsonl` 是平台对话纪录：Slack/Discord/Telegram 实际发生过什么
- `sessions/*.jsonl` 是 LLM 工作上下文/工作纪录：mikan 拿什么给 LLM 看，以及 LLM/tool 做了什么
- top-level session 用 `current` 指标，但 `current` 不是 channel history；缺失时可从 `log.jsonl` 重建最近 top-level 工作上下文
- thread / reply session 用固定档名，让 scoped session 可被单独追踪
- Slack top-level 讯息共用 channel session；Slack thread replies 使用 `conversationId:threadTs`
- Slack events 会先建立 top-level anchor message，再用 `conversationId:anchorTs` 执行

## 5. Login / Vault / Sandbox 关系

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

重点：

- 凭证不直接进 workspace
- vault 存在 `--state-dir`
- 执行时才由 conversation vault 路由到对应 sandbox
- `image` / `firecracker` / `cloudflare` 模式使用 per-actor/per-conversation vault routing；`container:<name>` 使用 shared container vault；`host` 不注入 vault env

## 6. Events 与一般对话的差异

`events/*.json` 会被 `EventsWatcher` 监看，之后转成 `BotEvent` 再走一次正常流程。
也就是说 events 不是独立执行器，而是「另一个讯息入口」。

这让下列能力共用同一套机制:

- session context
- vault routing
- tool execution
- 平台回覆
- stop / running state 管理

## 7. 架构结论

如果用一句话总结，`mikan` 的核心其实是：

> 一个以 `main.ts` 为协调中心、以 `agent.ts` 为执行核心、以 `session/vault/sandbox` 为基础设施的多平台 AI agent bot。

可以把它理解成 6 个核心子系统:

1. 平台转接器
2. Bot runtime 协调
3. Agent + tools
4. Session/context 持久化
5. Vault + sandbox execution routing
6. Web/event side services
