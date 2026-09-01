# 開源 AI Agent 產品的 MCP Marketplace 與 Catalog 實作研究（2026-09）

## 範圍與方法

本報告比較具代表性的開源 AI coding agent 與官方 MCP Registry 生態，涵蓋：catalog、preset server、one-click installation、credential setup、更新與移除語意，以及 security boundary；最後與 mikan 現有的 settings-declared、host-side MCP 架構比較。

本文只引用第一方來源：官方 repository、source code、schema、文件與官方 catalog/registry endpoint。檢視的固定版本如下：

- mikan：[`5a3713c`](https://github.com/geminixiang/mikan/tree/5a3713c1bbad2d22f016c35c1f04a9ea9104a2d0)（2026-09-01）
- Cline：[`8eb5f3d`](https://github.com/cline/cline/tree/8eb5f3d57f3eb87f21262f6ec2326ce460445dea)（2026-08-31）
- Continue：[`5522c6f`](https://github.com/continuedev/continue/tree/5522c6f44ca0ac3528b37244818fbfa39b5af470)（2026-07-20）
- Block/goose：[`4ad43df`](https://github.com/block/goose/tree/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de)（2026-09-01）
- 官方 MCP Registry：[`6036804`](https://github.com/modelcontextprotocol/registry/tree/6036804f1c62633b5e7d2927f411a6f4127f148a)（2026-08-21）

除「建議」章節外，以下內容均為從上述第一方來源驗證的事實；建議則明確標示為對 mikan 的設計判斷。

## 執行摘要

**已驗證事實：**代表性產品並未把 MCP marketplace 實作成完整的應用商店或套件管理器。共同模式較小：catalog entry 是一份可執行 recipe 或 remote endpoint 描述，安裝後被 materialize 成產品原有的 MCP settings。Host 通常不擁有下載後的套件 artifact，也不維護獨立的 installed-version database、dependency resolution 或 transactional upgrade。

**建議：**mikan 的最小方向應是把小型、repository-owned、經 review 的 preset catalog 加到既有 Admin MCP surface。Preset 安裝只需解析成目前的 `McpServerConfig`，在寫入前顯示 command/args 或 remote origin、credential names、scope 與來源。第一版不需要 marketplace database、publishing service、background updater、package manager abstraction、評分排行或通用 Registry ingestion。

## 比較表

| 產品／生態        | Catalog 模型                                                   | 安裝結果                            | Credential setup                                                                | 更新／移除                                         | 主要 security boundary                                                        |
| ----------------- | -------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| 官方 MCP Registry | 以 `server.json` 為 portable unit 的中立 metadata metaregistry | 由各 host 決定；Registry 本身不安裝 | 描述 env/header/URL inputs、required、default 與 `isSecret`                     | 發布版本不可變；另有 soft lifecycle status         | 驗證 namespace/package ownership，不保證程式安全                              |
| Cline             | 第一方 remote static JSON catalog                              | 寫入既有 MCP settings               | Catalog 顯示 required env names；目前 marketplace install path 不完成秘密值設定 | 依名稱推斷 installed；覆寫、toggle 或刪除 settings | Enterprise admission policy 與 tool approval；local MCP 仍是 host process     |
| goose             | 第一方 curated static catalog，加 `goose://` deep link         | 確認後寫入 extension config         | Required env values 進 secret store；HTTP headers 需額外小心                    | Toggle/remove config；同名不代表 upgrade           | Deep-link command allowlist、optional admin allowlist、tool permission system |
| Continue          | 本機 YAML/JSON declaration；舊 Hub slug resolver 已移除        | 手動設定                            | `${{ secrets.NAME }}` 從本機 env files/process env 解析                         | 編輯／刪除設定；freshness 交給 package runner      | Extension-host process，加 per-tool approval policy                           |
| mikan 現況        | 管理員手動宣告 settings                                        | 既有 `McpServerConfig` entry        | 值存在 host-private settings；Admin read redacted                               | Set/remove/disable entry                           | Secrets 不進 model/sandbox；stdio MCP server 本身仍在 host 執行               |

## 第一方來源詳細發現

### 官方 MCP Registry 生態

#### 定位與資料模型

官方 MCP Registry 是 **metadata metaregistry**，不是 package host：它記錄 MCP server 的 package 或 remote endpoint 位於何處；npm、PyPI、OCI registry 等既有系統仍負責散布 executable code。官方設計明確區分中立 Registry 與 downstream subregistry/marketplace；後者可以加入 curation、rating、scan 等帶立場的 metadata。第一方文件建議 host application 使用實作標準 Registry OpenAPI 的 downstream registry，而非直接依賴官方服務。來源：[ecosystem vision](https://github.com/modelcontextprotocol/registry/blob/6036804f1c62633b5e7d2927f411a6f4127f148a/docs/design/ecosystem-vision.md)、[about](https://github.com/modelcontextprotocol/registry/blob/6036804f1c62633b5e7d2927f411a6f4127f148a/docs/modelcontextprotocol-io/about.mdx)。

Portable unit 是 `server.json`。它描述 reverse-DNS server identity、精確 release version，以及一個以上的 local package 或 remote endpoint。Package entry 可宣告 registry type、identifier、**特定 package version**、runtime/package arguments、environment inputs 與 transport；remote entry 可宣告 Streamable HTTP 或 SSE URL、URL-template variables 與 request headers。Input metadata 可包含 description、required、default、choices 與 `isSecret`；固定值與應由 client 詢問使用者的值分開表示。來源：[schema](https://github.com/modelcontextprotocol/registry/blob/6036804f1c62633b5e7d2927f411a6f4127f148a/docs/reference/server-json/draft/server.schema.json)、[format examples](https://github.com/modelcontextprotocol/registry/blob/6036804f1c62633b5e7d2927f411a6f4127f148a/docs/reference/server-json/generic-server-json.md)、[remote servers](https://github.com/modelcontextprotocol/registry/blob/6036804f1c62633b5e7d2927f411a6f4127f148a/docs/modelcontextprotocol-io/remote-servers.mdx)。

官方服務支援 npm、PyPI、NuGet、Cargo、部分 OCI registry 與 MCPB release artifact，並驗證 claimed MCP name 與 package 的關係。例如 npm metadata 的 `mcpName`、PyPI/NuGet/Cargo 的 `mcp-name` marker，或 OCI annotation。MCPB entry 必須提供 SHA-256，但 hash validation 仍由安裝 client 負責。來源：[package types](https://github.com/modelcontextprotocol/registry/blob/6036804f1c62633b5e7d2927f411a6f4127f148a/docs/modelcontextprotocol-io/package-types.mdx)、[official requirements](https://github.com/modelcontextprotocol/registry/blob/6036804f1c62633b5e7d2927f411a6f4127f148a/docs/reference/server-json/official-registry-requirements.md)。

#### Discovery、版本、更新與移除

Generic read API 可列出 servers、列出 versions、取得特定版本或 `latest`，並使用 opaque cursor pagination。官方 API 另提供 name search、`version=latest`、`updated_since` 與 `include_deleted`，使 downstream catalog 能同步 lifecycle change。官方 aggregator guidance 建議低頻抓取並自行持久化，因官方服務不承諾 uptime 或 data durability。來源：[generic API](https://github.com/modelcontextprotocol/registry/blob/6036804f1c62633b5e7d2927f411a6f4127f148a/docs/reference/api/generic-registry-api.md)、[official API](https://github.com/modelcontextprotocol/registry/blob/6036804f1c62633b5e7d2927f411a6f4127f148a/docs/reference/api/official-registry-api.md)、[aggregator guidance](https://github.com/modelcontextprotocol/registry/blob/6036804f1c62633b5e7d2927f411a6f4127f148a/docs/modelcontextprotocol-io/registry-aggregators.mdx)。

已發布的 version metadata 不可變；作者要修改 metadata，必須發布新的 unique version。Lifecycle status 另行處理，可為 `active`、`deprecated` 或 `deleted`，並可套用到單一或全部 versions。`deleted` 是 soft deletion：預設 discovery 隱藏，但仍可用 `include_deleted=true` 查詢，也能恢復成 `active`。Registry 因此不定義 host-side automatic upgrade 或 local uninstall。來源：[versioning](https://github.com/modelcontextprotocol/registry/blob/6036804f1c62633b5e7d2927f411a6f4127f148a/docs/modelcontextprotocol-io/versioning.mdx)、[FAQ](https://github.com/modelcontextprotocol/registry/blob/6036804f1c62633b5e7d2927f411a6f4127f148a/docs/modelcontextprotocol-io/faq.mdx)、[status API](https://github.com/modelcontextprotocol/registry/blob/6036804f1c62633b5e7d2927f411a6f4127f148a/docs/reference/api/official-registry-api.md#status-endpoints)。

#### Trust 與 security boundary

Registry authentication 證明 namespace control，不證明 server 安全。GitHub identity／organization owner 可發布相應 `io.github.*` namespace；domain namespace 透過 DNS 或 HTTP challenge 證明，package ownership 另行驗證。官方 Registry 不做全面 code security scanning，要求 consumer 假設只有最低限度甚至沒有 moderation，也不會只因 vulnerability 或低品質就移除 server。Code scanning 交給 package registry，更強的 trust signals 交給 downstream marketplace。來源：[authentication](https://github.com/modelcontextprotocol/registry/blob/6036804f1c62633b5e7d2927f411a6f4127f148a/docs/modelcontextprotocol-io/authentication.mdx)、[trust and security](https://github.com/modelcontextprotocol/registry/blob/6036804f1c62633b5e7d2927f411a6f4127f148a/docs/modelcontextprotocol-io/about.mdx#trust-and-security)、[moderation policy](https://github.com/modelcontextprotocol/registry/blob/6036804f1c62633b5e7d2927f411a6f4127f148a/docs/modelcontextprotocol-io/moderation-policy.mdx)。

Schema 也指出 host responsibility：把 arguments 拼成 shell command 可能造成 command injection，因此應使用 non-shell spawn 或取得明確 consent；有 package hash 時，執行前應驗證；repository ID 可協助偵測 delete-and-recreate attack；SVG icon 需防範 active content。Catalog membership 不會取代這些責任。來源：[server schema](https://github.com/modelcontextprotocol/registry/blob/6036804f1c62633b5e7d2927f411a6f4127f148a/docs/reference/server-json/draft/server.schema.json)。

### Cline：remote static catalog materialized 成 settings

Cline 的 Customize marketplace 從第一方 static JSON endpoint `https://cline.github.io/marketplace/catalog.json` 取得 catalog。Catalog 同時包含 MCP servers、skills 與 plugins；client 會清理 display/source/install metadata，搜尋與 filter 在本機完成。對 MCP entry，enterprise configuration 可隱藏 marketplace，或先以 `allowedMCPServers` 過濾，再在 install backend 重複檢查。來源：[catalog fetch and policy](https://github.com/cline/cline/blob/8eb5f3d57f3eb87f21262f6ec2326ce460445dea/apps/vscode/src/core/controller/marketplace/marketplace-helpers.ts)、[official catalog](https://cline.github.io/marketplace/catalog.json)、[enterprise controls](https://github.com/cline/cline/blob/8eb5f3d57f3eb87f21262f6ec2326ce460445dea/docs/enterprise-solutions/configuration/infrastructure-configuration/control-other-cline-features/mcp-server-controls.mdx)。

MCP entry 的 `install.args` 是 CLI-shaped data：server name 後接 stdio command vector，或 remote transport/URL；entry 也可顯示 required environment-variable names、description 與 help URL。點擊 Install 後，目前 marketplace row 直接把 entry 傳給 backend，沒有獨立 command preview/confirmation；backend 把 arguments 解析成既有 MCP transport config，寫入具名 settings entry。來源：[marketplace UI](https://github.com/cline/cline/blob/8eb5f3d57f3eb87f21262f6ec2326ce460445dea/apps/vscode/webview-ui/src/components/marketplace/MarketplaceView.tsx)、[install parser/write](https://github.com/cline/cline/blob/8eb5f3d57f3eb87f21262f6ec2326ce460445dea/sdk/packages/core/src/services/mcp-install.ts)、[backend dispatcher](https://github.com/cline/cline/blob/8eb5f3d57f3eb87f21262f6ec2326ce460445dea/apps/vscode/src/core/controller/marketplace/marketplace-helpers.ts)。

Environment metadata 只顯示成「Requires …」摘要，未傳入 MCP install parser，也未由此 marketplace path 寫入。Credential completion 仍屬一般 MCP configuration；第一方 guide 展示 literal `env`/`headers` settings，並建議使用 environment variables。來源：[marketplace UI](https://github.com/cline/cline/blob/8eb5f3d57f3eb87f21262f6ec2326ce460445dea/apps/vscode/webview-ui/src/components/marketplace/MarketplaceView.tsx)、[install parser](https://github.com/cline/cline/blob/8eb5f3d57f3eb87f21262f6ec2326ce460445dea/sdk/packages/core/src/services/mcp-install.ts)、[MCP guide](https://github.com/cline/cline/blob/8eb5f3d57f3eb87f21262f6ec2326ce460445dea/docs/mcp/mcp-overview.mdx)。

對 MCP entry，installed state 是以 catalog id/name/install server name 與已設定 MCP names 比對推斷。Catalog 與 installed-entry protocol 沒有 catalog version 或 package digest。安裝同名 entry 會覆寫 settings，uninstall 會刪除，Installed view 支援 enable/disable。多個 catalog recipe 使用 `@latest`，把 executable freshness 交給 package runner，而非 Cline upgrade transaction。來源：[marketplace protocol](https://github.com/cline/cline/blob/8eb5f3d57f3eb87f21262f6ec2326ce460445dea/apps/vscode/proto/cline/marketplace.proto)、[matching and lifecycle](https://github.com/cline/cline/blob/8eb5f3d57f3eb87f21262f6ec2326ce460445dea/apps/vscode/src/core/controller/marketplace/marketplace-helpers.ts)、[core uninstall](https://github.com/cline/cline/blob/8eb5f3d57f3eb87f21262f6ec2326ce460445dea/sdk/packages/core/src/services/marketplace.ts)、[catalog](https://cline.github.io/marketplace/catalog.json)。

Cline 的主要控制是 admission policy 與 per-tool approval，而非 MCP process isolation。Enterprise admin 可禁止 local MCP、allowlist identifiers、推送 managed remotes，並禁止 personal remotes；安全文件要求只安裝可信 server、只對安全 tools 使用 `autoApprove`，並 review tool calls。Catalog install 最終仍會 materialize 成 host-side command 或 remote endpoint。來源：[enterprise controls](https://github.com/cline/cline/blob/8eb5f3d57f3eb87f21262f6ec2326ce460445dea/docs/enterprise-solutions/configuration/infrastructure-configuration/control-other-cline-features/mcp-server-controls.mdx)、[security guidance](https://github.com/cline/cline/blob/8eb5f3d57f3eb87f21262f6ec2326ce460445dea/docs/mcp/mcp-overview.mdx#security-basics)、[tool approval fields](https://github.com/cline/cline/blob/8eb5f3d57f3eb87f21262f6ec2326ce460445dea/apps/vscode/src/services/mcp/McpHub.ts)。

### Block/goose：curated static catalog 與 deep-link installer

goose 官方 Extensions 頁面從同站 `/servers.json` 讀取 catalog，在 client side 搜尋 name/description，並分成 Built-in 與 Community。Catalog record 包含 identity/display metadata、command 或 URL、notes、endorsement 及 required env/header metadata，但沒有 package signature、digest、publisher proof 或 installed-version field，因此是 curated static catalog，不是 package registry。來源：[catalog page](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/documentation/src/pages/extensions/index.tsx)、[fetch/search](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/documentation/src/utils/mcp-servers.ts)、[catalog type](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/documentation/src/types/server.ts)、[catalog data](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/documentation/static/servers.json)。

One-click installation 使用 `goose://extension?...` deep link。Catalog 把 local command 序列化成 `cmd` 與重複的 `arg`，或把 remote server 表示成 `url/type`，並帶上 required env/header metadata。Desktop 解析連結、顯示 confirmation modal，再寫入 goose extension config。若需要 credentials，流程會先導向 Extensions form；不需要 credentials 時，新 extension 仍從下一個 session 開始使用。來源：[link generator](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/documentation/src/utils/install-links.ts)、[install card](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/documentation/src/components/server-card.tsx)、[deep-link parser](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/ui/desktop/src/components/settings/extensions/deeplink.ts)、[confirmation modal](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/ui/desktop/src/components/ExtensionInstallModal.tsx)。

Deep-link parser 只接受 `cu`、`docker`、`jbang`、`npx`、`uvx`、`goose` 與 `npx.cmd`，並拒絕 `npx -c` injection pattern。Desktop 另支援 administrator allowlist：未配置時可安裝任意 extension；配置後可 block，或以 warning mode 讓使用者 override。第一方文件描述 exact matching，但檢視版本的 modal source 使用 `command.startsWith(allowedCmd)`，實作上是 prefix check。來源：[parser checks](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/ui/desktop/src/components/settings/extensions/deeplink.ts)、[modal allowlist](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/ui/desktop/src/components/ExtensionInstallModal.tsx)、[allowlist docs](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/documentation/docs/guides/allowlist.md)。

Required environment variable 在 installer 中先建立空欄位，再開啟設定 form。提交後，secret value 經 secret ACP API 進 goose secret store，extension YAML 只保留 `env_keys`。Runtime secret precedence 是 process environment，再到 OS keyring；設定 `GOOSE_DISABLE_KEYRING` 時改存 `~/.config/goose/secrets.yaml`。目前 form 會把 Streamable HTTP headers 組入 extension config；敏感 header 應使用 environment substitution 配合 `env_keys`，不能假定任意 header value 都自動進 keyring。來源：[credential form](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/ui/desktop/src/components/settings/extensions/modal/ExtensionModal.tsx)、[form to config](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/ui/desktop/src/components/settings/extensions/utils.ts)、[secret store](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/crates/goose/src/config/base.rs)、[runtime substitution](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/crates/goose/src/agents/extension.rs)。

Install 保存的是 executable recipe 或 remote URL，不是 goose-owned package artifact。Delete 只移除 config entry；enable/disable 只修改 default state；同名 entry 只回報 already installed，不會執行 upgrade。Marketplace 沒有 version transaction 或 package-runner cache uninstall hook，且 catalog 有許多未 pin 的 `npx -y`／`uvx` recipe。來源：[config mutation](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/crates/goose/src/config/extensions.rs)、[desktop lifecycle](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/ui/desktop/src/components/settings/extensions/extension-manager.ts)、[duplicate handling](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/ui/desktop/src/components/ExtensionInstallModal.tsx)、[catalog commands](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/documentation/static/servers.json)。

Bundled preset 有另一套有限 lifecycle：Desktop startup 會從 `bundled-extensions.json` 加入缺少的 entries，並保留 user enabled state；已存在的 bundled entry 直接略過，deprecated list 則可 prune preset。它支援 bundled default 的新增／移除，但不會重寫既有 bundled definition，也不是一般 update engine。來源：[bundled sync/prune](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/ui/desktop/src/components/settings/extensions/bundled-extensions.ts)、[startup wiring](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/ui/desktop/src/components/ConfigContext.tsx)、[bundled data](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/ui/desktop/src/components/settings/extensions/bundled-extensions.json)。

Stdio extension 以 host child process 啟動，working directory 是 session workspace；confirmation 與 allowlist 因而是 source-admission controls，不是 sandbox。goose 另有 global/per-tool permission modes，但第一方文件明示 Autonomous 是預設值；存在 permission subsystem 不代表每次 MCP call 預設都詢問。來源：[child-process manager](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/crates/goose/src/agents/extension_manager.rs)、[permission config](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/crates/goose/src/config/permission.rs)、[permission docs](https://github.com/block/goose/blob/4ad43df42d8e6f5c9dae962d4cf4cbad2aadf3de/documentation/docs/guides/managing-tools/goose-permissions.md)。

### Continue：declarative local MCP，不是仍可運作的 marketplace

Continue 目前從 `config.yaml` 的 `mcpServers`，或 workspace/global `.continue/mcpServers/` 下的 YAML/JSON 載入 MCP，也接受 Claude Desktop/Claude Code-style JSON。第一方 quick start 是手動建立檔案，MCP tools 只用於 agent mode。來源：[MCP docs](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/docs/customize/deep-dives/mcp.mdx)、[JSON loader](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/context/mcp/json/loadJsonMcpConfigs.ts)。

部分文件仍展示 `uses: continuedev/continue-docs-mcp`，但目前 registry client 會丟出 `Slug-based package resolution is not supported`，onboarding source 也記錄 Hub/slug resolution 已移除。因此舊 `uses` UX 不能視為 2026-09 仍可運作的 marketplace。來源：[remaining `uses` docs](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/docs/reference/continue-mcp.mdx)、[registry client](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/packages/config-yaml/src/registryClient.ts)、[onboarding removal note](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/config/onboarding.ts)。

Credential interpolation 使用 `${{ secrets.NAME }}`。Local resolver 依序查找 `~/.continue/.env`、workspace `.continue/.env`、workspace `.env`，最後才是 `process.env`；沒有 marketplace-specific credential object 或 installation wizard。來源：[MCP secrets docs](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/docs/customize/deep-dives/mcp.mdx)、[local platform resolver](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/config/yaml/LocalPlatformClient.ts)。

Lifecycle 就是 configuration-file lifecycle：新增、更新與移除等同建立、編輯與刪除 MCP block/file。只有 declaration 自行使用 `@latest` 等 unpinned specifier 時，package manager 才會取得較新版本；Continue 不維護 catalog version、installed version、upgrade transaction 或 package artifact ownership。來源：[Playwright example](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/docs/customize/deep-dives/mcp.mdx)、[local block loading](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/config/loadLocalAssistants.ts)。

Stdio server 由 Continue extension host spawn，working directory 可指向 workspace；child environment 由少量 common environment fields、PATH 與 declared server env 組成，並非 sandbox。Remote MCP 支援 SSE、Streamable HTTP 與 WebSocket，SSE 有 OAuth flow。未設定個別 policy 的 tool 會落到 UI 預設 `allowedWithPermission`，需要 approval。來源：[MCP connection/spawn](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/context/mcp/MCPConnection.ts)、[default policy](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/gui/src/redux/slices/uiSlice.ts)、[policy evaluation](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/gui/src/redux/thunks/evaluateToolPolicies.ts)。

Continue 也提供一個 lifecycle 警示：catalog documentation 與 resolver 不應有彼此獨立的生命週期。mikan 的 static preset 應直接編譯成當前支援的 settings shape，而不是宣告依賴另一個可被移除的 remote slug backend。

## 跨產品模式歸納

### Catalog

**已驗證模式：**

- Cline 與 goose 使用第一方 static catalog；搜尋與 installed-state matching 多在 client 或既有 settings 上完成。
- 官方 Registry 提供 portable metadata 與 ownership proof，但刻意不承擔完整 curation 或 code-safety endorsement。
- Continue 顯示：若 catalog identifier 與 resolver 分離，resolver 被移除後，文件與 preset contract 會失效。

**對 mikan 的含意：**第一版只需要 repository-owned preset manifest；catalog entry 必須能直接解析成當前 `McpServerConfig`。

### One-click installation

**已驗證模式：**one-click 通常不是 package installation transaction，而是「catalog recipe → 普通 MCP settings」。goose 會先顯示 confirmation；Cline 現行 marketplace row 則直接送 backend。

**對 mikan 的含意：**採 goose 較明確的 preview/confirm boundary，但安裝結果仍應是一次既有 settings mutation。

### Credentials

**已驗證模式：**官方 Registry schema 只描述 client 應詢問哪些 input，以及哪些是 secret；它不取得 credential。goose 把 env secret 實值放入 keyring/secret store，只在 config 留 keys；Continue 從 env files/process env 解析；Cline marketplace 只顯示 required env metadata，credential completion 留給一般設定。

**對 mikan 的含意：**preset metadata 只需描述 field name、說明、required 與 secret handling。第一版應沿用 mikan 現有 host-private settings 與 Admin redaction，不應誤稱已使用 vault-backed secret references。

### 更新與移除

**已驗證模式：**產品通常只擁有 settings entry，不擁有 package artifact。Remove 刪除 declaration；disable/toggle 修改 enabled state；package cache 不一定被移除。未 pin 的 `@latest`、`npx -y` 或 `uvx` 把 freshness 隱含交給外部 runner，並非產品的 controlled update。

**對 mikan 的含意：**preset 應 pin exact package version。Update 應是使用者明確選擇新版 preset、查看 config diff 後重新套用；remove 不應宣稱清除 npm/uv/docker artifact。

### Security boundary

**已驗證模式：**catalog admission、publisher identity、command allowlist、install confirmation、runtime tool approval 與 process sandbox 是不同控制面。官方 Registry 只證明 identity/ownership；Cline、goose、Continue 的 local stdio server 仍可能是 host process。goose 甚至在預設 Autonomous mode 下不保證每次 MCP call 都詢問。

**對 mikan 的含意：**Admin UI 必須明示「local preset 會在 host 執行程式碼」或「remote preset 會把 tool request/data 傳給外部服務」。Catalog presence 不能顯示成安全認證，也不應把 install capability 暴露成 model-callable tool。

## mikan 現況與可重用能力

mikan 已具備小型 catalog 所需的 installation target。`McpServerConfig` 支援 host-spawned stdio `command` 搭配 `args`/`env`，或 Streamable HTTP `url` 搭配 `headers`，另有 `disabled`；runtime validation 確保只使用一種 transport。Loader 會獨立連接 enabled servers，以 `mcp__<server>__<tool>` namespace tools，並隨 runner dispose clients；單一 server failure 不阻止其他 server 載入。來源：[types](https://github.com/geminixiang/mikan/blob/5a3713c1bbad2d22f016c35c1f04a9ea9104a2d0/src/mcp/types.ts)、[loader](https://github.com/geminixiang/mikan/blob/5a3713c1bbad2d22f016c35c1f04a9ea9104a2d0/src/mcp/loader.ts)、[runner wiring](https://github.com/geminixiang/mikan/blob/5a3713c1bbad2d22f016c35c1f04a9ea9104a2d0/src/agent/runner.ts#L286-L314)。

Configuration 已有 global 與 conversation scopes。Maps 依 server name merge，conversation entry 優先，`disabled: true` 可抑制 inherited global server。Admin endpoint 可 set、remove 或 toggle 單一 entry；write 經 settings-mutation seam 觸發 runner cache refresh。Conversation busy 時，conversation-scoped mutation 會被拒絕，避免在 live runner 下修改設定。來源：[merge](https://github.com/geminixiang/mikan/blob/5a3713c1bbad2d22f016c35c1f04a9ea9104a2d0/src/config.ts#L357-L386)、[Admin mutation](https://github.com/geminixiang/mikan/blob/5a3713c1bbad2d22f016c35c1f04a9ea9104a2d0/src/web/admin/portal.ts#L1534-L1638)、[cache mutation policy](https://github.com/geminixiang/mikan/blob/5a3713c1bbad2d22f016c35c1f04a9ea9104a2d0/src/settings-mutation.ts)。

mikan 的 credential boundary 比 model-visible workspace file 更強：conversation settings 位於 host-only office state directory，重要 writes 使用 private atomic files；stdio credentials 以 child environment 傳入，HTTP credentials 以 request headers 傳入；Admin list response 只回傳 env/header key names。Secrets 不會進 model 或 sandbox，但 MCP server 本身**沒有被 sandbox**：stdio 是在 host 啟動的 executable code，remote server 則會接收傳給它的 tool calls 與 data。來源：[host-only settings](https://github.com/geminixiang/mikan/blob/5a3713c1bbad2d22f016c35c1f04a9ea9104a2d0/src/config.ts#L299-L349)、[private write](https://github.com/geminixiang/mikan/blob/5a3713c1bbad2d22f016c35c1f04a9ea9104a2d0/src/config.ts#L603-L624)、[credential transport](https://github.com/geminixiang/mikan/blob/5a3713c1bbad2d22f016c35c1f04a9ea9104a2d0/src/mcp/loader.ts#L19-L44)、[Admin redaction](https://github.com/geminixiang/mikan/blob/5a3713c1bbad2d22f016c35c1f04a9ea9104a2d0/src/web/admin/portal.ts#L1464-L1510)。

與 goose 不同，mikan 目前不把 MCP values 放入 vault，也不在 `mcpServers` 中保存 secret references；MCP `env` 與 `headers` values 直接存在 host-private settings file。最小 catalog 應維持並清楚描述這個現況，不應聲稱已有 vault-backed credential design。來源：[MCP config type](https://github.com/geminixiang/mikan/blob/5a3713c1bbad2d22f016c35c1f04a9ea9104a2d0/src/mcp/types.ts)、[settings schema/write](https://github.com/geminixiang/mikan/blob/5a3713c1bbad2d22f016c35c1f04a9ea9104a2d0/src/config.ts)、[Admin redaction](https://github.com/geminixiang/mikan/blob/5a3713c1bbad2d22f016c35c1f04a9ea9104a2d0/src/web/admin/portal.ts#L1464-L1510)。

## 對 mikan 的最小建議範圍

以下為**建議**，不是現況描述。

1. **在既有 Admin MCP surface 加入小型 repository-owned preset catalog。** 每個 reviewed preset 只需 display name、description、source/setup links，以及可直接解析為現有 `McpServerConfig` 的 template。Installed state 繼續由既有 `mcpServers` settings map 表示。
2. **只支援 mikan 現在能忠實執行的 shapes。** 第一版支援 Streamable HTTP remote，以及少數使用已知 non-shell command/argument vector 的 reviewed stdio preset。不要宣稱支援 SSE、WebSocket、MCPB、OCI mounts、所有 Registry package types 或 OAuth。
3. **使用 preview/confirm installation flow。** 一次 settings write 前，顯示 exact executable 與 arguments 或 remote origin、requested credential names、target scope、source repository，以及 pinned package/preset version。Catalog presence 不代表 security endorsement。
4. **Credential collection 沿用現有 host-private settings boundary。** `secret` fields 使用 password input，Admin read 保持 redacted。第一版只需 API-key environment variables 與 headers。Preset 的 `isSecret` metadata 只控制 UI handling，不是 OAuth 或 credential acquisition protocol。
5. **Local package version 必須 pin。** 安裝建立 fixed settings snapshot。Update 是顯示 config diff 後，由管理員明確重新套用新版 preset；不做 automatic updater。
6. **重用現有 disable/remove semantics。** Disable 對應 `disabled`；remove 刪除 scope-local declaration；conversation-level disable 仍用來抑制 inherited global server。移除 declaration 不宣稱卸載 npm/uv/docker cache。
7. **Installation 維持 administrator-driven。** 不把 marketplace discovery 或 install 做成 model-callable tool。Local stdio preset 代表 host code execution；remote preset 代表 external service 可接觸送出的 tool data，operator confirmation 才是 admission boundary。

### 建議的最小 preset metadata

這不是新的公開標準，只是足以產生現有 settings entry 的內部資料：

- stable preset id
- display name 與簡短 description
- first-party source/setup URL
- exact preset revision
- 一種 transport template：pinned `command` + `args`，或 fixed Streamable HTTP `url`
- credential field descriptors：name、description、required、secret
- optional default scope recommendation，但由管理員最終選擇 scope

不需要另設 installed record；安裝後的 authority 仍是 `mcpServers` settings entry。

## 拒絕或延後的複雜度

以下均應延後，除非未來有明確需求：

- MCP publishing service 或 private registry
- Marketplace database、ratings、reviews、rankings、download counts
- Package manager abstraction 或 dependency solver
- Background Registry synchronization 或 automatic update daemon
- 與 `mcpServers` 分離的 installed-artifact/version database
- Generic ingestion 所有 `server.json` package/runtime shapes
- 沒有具體 server 需求時先建 OAuth/DCR infrastructure
- 為已移除的 catalog/slug contract 建 compatibility layer
- 把 catalog membership、Registry ownership 或 endorsed flag 當成安全認證
- 自動清除 npm/uv/docker caches 的 uninstall framework

## 結論

**已驗證事實：**Cline 與 goose 證明，實用的 discovery 與 one-click setup 可以只是 catalog-to-settings conversion；Continue 證明 catalog documentation 與 resolver 分開演進會留下失效 contract；官方 MCP Registry 提供有用的 portable metadata vocabulary，但也明確把 execution、credentials、integrity 與 local lifecycle 責任留給 host。

**建議：**mikan 現有 settings map、mutation seam、runner refresh、disable/remove behavior、host-private storage 與 Admin redaction 已經是足夠的核心 authority。缺少的是一層小型、reviewed、可預覽與確認的 preset presentation/resolution layer，而不是新的安裝基礎設施。
