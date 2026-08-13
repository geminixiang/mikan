# mikan Web 網站化架構規劃（以 deepseek-harness 為參考）

> 研究日期：2026-06-09。目標：把現有的 `session / admin / vault（login）` 三個 server-rendered HTML portal 重構成一個真正的網站（React + Vite 全 SPA），架構對齊 `../deepseek-harness`（下稱 DSH）的 web 層。研究期間未修改 production code。
>
> 已確認之決策：
>
> 1. 前端框架採用 **React + Vite**（最貼近 DSH 的 `@deepseek-ai/dsh-client-web` shell）。
> 2. mikan 由單一 package 改為 **workspace monorepo**，但**只拆「網站相關」packages**，既有 daemon `src/` 維持原狀（或僅包成 `packages/daemon` 而不動其 import）。
> 3. 本文件先交付規劃，確認後再動工。

## 摘要與建議

今天 mikan 的 web 是「單一 Node HTTP server + 三份 server-rendered HTML 字串 + 內嵌 JS/CSS」，只解決「把連結開給使用者看單一 session / 管理操作 / 收 credential」。它已具備 DSH 的「host API」一半（每個 portal 內有具名的 JSON/SSE route），但**缺少** DSH 的另一半：前端 build 與 bundling、SPA client shell、boot-manifest 注入、static-dist fallback seat、與 `/plugins` bundle route。

建議採分階段、以「host seam」與「client boot」對齊 DSH 的混和落地，而非一次把整個既有 `src/` 搬進 packages：

1. **先建立 pnpm workspace + packages 骨架**（`packages/web-host`、`packages/web-client`、`packages/ui-*`、`packages/web-bundle`、`apps/web`），不動任何既有檔案。
2. **把 `src/web/server.ts` 泛化成 DSH 的 route-registry 服務**（`register(kind/path/handler)`、`registerUpgrade`、`registerFallback`、`tapIndex`），既有 portal route 先「平移」成具名 route，行為不變。
3. **新增 React Vite client**，採用 DSH 的 `__DSH_BOOT__` boot-manifest：host 在 `index.html` 注入 boot graph，shell 讀取後載入各 UI bundle，取代 `renderPortalShell` + 內嵌 script。
4. **逐 portal 遷移**：session-view → admin → vault/login，每步以既有 JSON API 為新 host API，前端 React 直接 fetch/SSE。
5. 最後才考慮把新 web packages 真正接上既有 `main.ts` 的 boot（`startWebServer`），並用既有 `dist/main.js` 跑起驗證。

## 研究標記

- **[觀察]**: 由本 repo 或 DSH 原始碼直接確認。
- **[實測]**: 可本地重現；命令與輸出列於文末。
- **[假說]**: 尚未 end-to-end 證明，附驗證方式。

---

## Part 1 — 現況分析

### 1.1 現有 mikan web 表面

**[觀察]** 單一 `createServer`（`src/web/server.ts::startWebServer`）依序掛載 route；portals 共用 `src/web/portal-shell.ts::renderPortalShell`（浮動三鈕 nav + topbar + CSS）。

| 區塊         | 檔案                                                       | 目前表面                                                                                                                                                               |
| ------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| admin        | `src/web/admin/portal.ts`（~3400 行）                      | `GET /admin` + ~26 支具名 `/admin/api/*`（models/conversations/settings/workspace tree/skills/packages/extension-secrets/events/session-usage…），30 分鐘 `AdminToken` |
| session-view | `src/web/session-view/portal.ts`（~1800 行）+ `service.ts` | `GET /session?token&session`（頁）、`GET /session/stream`（SSE）、`POST /session/message`（聊天送出）；24 小時 `SessionViewToken`                                      |
| vault/login  | `src/web/login/portal.ts` + `oauth.ts`                     | `GET /link`、`POST /api/link/complete`（API key）、`POST /api/oauth/start` + `GET /oauth/callback`（OAuth/PKCE）、CSRF；15 分鐘 `LinkToken`                            |

**[觀察]** token 都是 in-memory TTL store（`InMemoryAdminTokenStore`、`InMemorySessionViewTokenStore`、`InMemoryLinkTokenStore`，皆基於 `src/web/token-store.ts::InMemoryTokenStore`）。無 cookie、無 session cookie；連結攜帶 token query/body。bind 規則：`MIKAN_LINK_URL` 設了才 `0.0.0.0`，否則 `127.0.0.1`（`src/web/server.ts:119`）。

**[觀察]** session 資料落在 office 的 `<office>/sessions/*.jsonl`（v3 append-only JSONL，`src/harness/session-store.ts::SessionStore`，header + entries tree：`message` / `model_change` / `compaction` / `branch_summary` / `custom` / `label` / `session_info`…）。`session-view/service.ts::loadSessionViewModel` 已是現成的「session → UI model」載入器，含 parent/thread lineage。**沒有跨 office 的單一 session listing API**；admin 用 office registry + `readdirSync` + `SessionStore.open` 逐檔掃。

**[觀察]** vault 落在 `<state-dir>/vaults/<key>`，key 由 sandbox identity 依 office 推導（`src/sandbox/identity.ts::credentialAuthorizationKey`），`FileVaultManager`（`src/vault/index.ts`）提供 `resolve/list/upsertEnv/deleteEnvKey/upsertFile/hasEntry/isEnabled` 與 shared-profile 操作。

**[觀察]** 三 portal 的 UI 全部是 HTML 字串 + 內嵌 `<script>`/`<style>`，沒有前端 build；admin/login UI 文案為繁體中文。

### 1.2 DSH 的 web 架構（參考模型）

**[觀察]** DSH 是 monorepo（pnpm workspace），web 分「host seam」與「client boot」兩半，中間靠 `window.__DSH_BOOT__` 傳遞：

- **host seam**（`packages/host/*`）：
  - `@deepseek-ai/dsh-host-webserver`：一個 `node:http` server + 屬性註冊服務。`register({kind:'exact'|'prefix', path, handler})`、`registerUpgrade({path, handler})`、單一 `registerFallback(handler)` seat、`tapIndex(transform)`。exact 優先、prefix 最長匹配。
  - `@deepseek-ai/dsh-host-frontend-static`：認領 fallback seat，serve built dist；path traversal → 403；任何 miss（含 `/`、`index.html`）→ serve `index.html` with 200（SPA routing），並跑過所有 index taps。
  - `@deepseek-ai/dsh-client-modules`（node half）：掃 loader entries 中宣告 `dsh.client` 的 packages，解析每支 client bundle 並 hash（`rev`），serve `/plugins/<id>/client.js`，並注入 `__DSH_BOOT__` 到 `<head>` 第一個 script。
- **client boot**（`packages/client/*`）：
  - `@deepseek-ai/dsh-client-web`：`boot.tsx` 的 `AppWebEntry`。讀 `__DSH_BOOT__` → `ClientModuleSystem`（module table）→ prefetch → mount Cordis Loader → 每支 plugin 一個 entry → `loader.await()` + `assertEntriesActive()`。
  - `@deepseek-ai/dsh-client-web-react`：slot renderer（`renderRoot` + `SlotRenderer`）。
  - 每支 UI feature 是獨立 package（`ui-slots`、`ui-layout`、`ui-conversation`、`ui-settings*`…），`dsh.client.platform:'web'` + `./client` export，由共用 `tsdown.client.ts` 編成 CJS closure-factory，並有「purity gate」防止跨 package value import。
- **bundle**（`packages/bundle/web-app`）：`cordis.patch.yml` 組合所有 web 列（webserver、frontend-static、connection、modules、每個 ui-*），`src/index.ts` 認領 dist、印 URL line。
- **apps/web**：薄 Vite entry（`main.ts` 只 `new AppWebEntry(el).run()`），`vite.config.ts` 將 shell-only packages alias 到 source、`manualChunks` 拆 vendor、`define` 修掉 loader 的 Node probe。

**[觀察]** 瀏覽器 ↔ host 的 runtime API：無名 RPC `POST /api/<domain>.<method>`（`ClientRequest` envelope → trust fence → `apiProxy` gateway）+ WebSocket 下行流 `/api/events.mux` `/api/events.host`（`ConnectionController` reconnection loop）+ HMR SSE `/plugins/events`（node half stat-poll → `rebuilt` frame → client hot-swap）。

---

## Part 2 — 目標架構

### 2.1 Monorepo package 佈局（只拆網站相關）

```
mikan/
  package.json               # 根；private + scripts（pnpm -r 聚合）
  pnpm-workspace.yaml        # 新增
  src/                       # 既有 daemon 維持原狀（不動 import）
  packages/
    daemon-web-bridge/       # 新增（薄型：連接 token store / runtime bridge 給 host，避免直接碰 src/*）
    web-host/                # 新增：route registry + fallback seat + boot-manifest 注入 + static dist
    web-client/              # 新增：React shell（讀 __DSH_BOOT__ → 載入 ui-* bundles）
    ui-session/              # 新增：session-view SPA 頁
    ui-admin/                # 新增：admin SPA 頁
    ui-vault/                # 新增：vault/login SPA 頁
    web-bundle/              # 新增：組合清單（要載入哪些 ui-*）；產出 boot graph
  apps/web/                  # 新增：薄 Vite entry（main.ts + index.html）
  web-dist/                  # 建置產出（.gitignore）
```

> 「只拆網站相關」的落點：**不動 `src/`**。`web-host` 與既有 `src/web/server.ts` 的關係是「host 保留在 daemon 內，`src/web/server.ts` 呼叫/包 `web-host` 的 registry 服務」——詳見 §5 遷移順序。若只想先不動既有 portal，則 `web-host` 可作為新增 route 的註冊面，舊 portal 維持原 route 直到逐個替換。

### 2.2 host seam（`packages/web-host`）

對齊 DSH 的抽象，但用 mikan 既有的 `node:http`（不引入 Cordis）：

```ts
// packages/web-host/src/router.ts
export type WebRouteKind = "exact" | "prefix";
export interface WebRoute {
  kind: WebRouteKind;
  path: string;
  handler: (req, res) => void | Promise<void>;
}
export interface WebUpgradeRoute {
  path: string;
  handler: (req, socket, head) => void | Promise<void>;
}

export class WebServer {
  // 取代/包裹 src/web/server.ts::createServer 的 dispatch
  register(route): () => void;
  registerUpgrade(route): () => void;
  registerFallback(handler): () => void; // 單一 seat，static dist 認領
  tapIndex(fn): () => void; // 對每個 index.html 依序套用
  applyIndexTaps(html): string;
  listen(port, host);
}
```

- 既有 route（`/admin*`、`/session*`、`/link`、`/api/*`、`/health`、agent-events SSE、github webhook）平移為具名 route，**行為不變**。
- `client-boot` 或 `web-bundle` 認領 fallback seat + 注入 `__DSH_BOOT__` + serve `/plugins/<id>/client.{js,map}`。
- 保留現有 bind/`MIKAN_LINK_URL`/`127.0.0.1` 規則與 token store。

### 2.3 client shell（`packages/web-client`）

對齊 DSH `boot.tsx` 但**只用 React + react-router**（不搬 Cordis/plugin 那套，因為 mikan 無此生態、也不需要動態掛 plugin）：

```ts
// apps/web/src/main.ts
const el = document.getElementById("root");
const manifest = parseBootManifest(globalThis.__DSH_BOOT__); // {rev, entries:[{id,url,rev}]}
void createApp(el, manifest).run();
```

- `__DSH_BOOT__` 由 host 注入，內容是「該頁需要的 ui-* bundle 清單」。shell 用動態 `import()` 載入各 `ui-*` 的 vanilla/React 頁，透過一個輕量 **slot/route 註冊面**（見下）組合，但不需要 Cordis。
- **跨模組通訊**：用一個純 TypeScript 的 「web service context」（`packages/web-client/src/context.ts`），提供 `api`（fetch wrapper）、`sessions`、`host` 描述；不引入重的 IoC。

### 2.4 boot manifest 與 bundle 組合

參考 DSH 的 wire 形狀（`WebBootGraph { rev, entries }`），但簡化：

```ts
interface WebBootEntry {
  id: string;
  url: string;
  rev: string;
  immediately?: boolean;
}
interface WebBootGraph {
  rev: string;
  entries: WebBootEntry[];
}
```

- `packages/web-bundle` 設定「這個 deploy 要含哪些 ui-*」（session / admin / vault 的頁）。
- host 在 serve `index.html` 前用 `tapIndex` 注入 `window.__DSH_BOOT__ = {…}`（先於 shell bundle），並 serve 每支 bundle。
- 每支 `ui-*` bundle = 獨立 Vite build 產物（CJS/IIFE closure-factory，對 `web-client` 的 export 保持 external），類似 DSH 的 `tsdown.client.ts`。**若不想整套「runtime-fetch plugin」**，退路是：單一支 app bundle（所有 ui-* 一起 build），`__DSH_BOOT__` 只帶 `rev`/版本資訊當快取錨。第一階段建議先做**單支 app bundle**（低複雜度、行為一致），需要動態加減 features 時再切成多支。

### 2.5 host JSON API 表面（給 React SPA 用）

沿用既有 portal 的 API 路線，把它們定義為 host 端具名 route（每個 `ui-*` 對應一組）：

| UI           | Host API                                                                                                                                            | 用既有來源                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ui-session` | `GET /api/session/<file>`（view model）、`GET /api/session/<file>/stream`（SSE）、`POST /api/session/<file>/message`、`GET /api/offices`（listing） | `session-view/service.ts::loadSessionViewModel`；`admin/portal.ts::listAdminOffices` |
| `ui-admin`   | `GET/POST /api/admin/*`                                                                                                                             | 既有 `/admin/api/*` handler 平移                                                     |
| `ui-vault`   | `GET /api/link`、`POST /api/link/complete`、`POST /api/oauth/start`、`GET /api/oauth/callback`                                                      | 既有 login/portal.ts 平移                                                            |

> **token 模型保持不變**：不引入 cookie；React SPA 從 URL/token store 讀 token、放進 API call。第一階段 `ui-session` 維持 query token（`/session?token=…`），SST 路由由 shell 從 `?session=`/`?token=` 讀並導向對應頁。

---

## Part 3 — 建置與 dev 流程

- **workspace**：新增 `pnpm-workspace.yaml`（`packages:'packages/*'`、`apps/web`）；根 `package.json` `private:true`，scripts 用 `pnpm -r` 聚合 `build:web` / `dev:web`。**不使用 pnpm 改 npm**——引進 pnpm 是 monorepo 的前置決策（需使用者同意，見 §6 open question）。
- **client build**：`apps/web` Vite + `@vitejs/plugin-react`；shell/`ui-*` 由 alias 指向 source（對齊 DSH：`define` 修掉可能的 Node probe；`manualChunks` 把重 render 依賴分 vendor）。
- **dev**：`pnpm dev:web` 起 Vite dev + host；DSH 的「client-plugin HMR」在本階段可先不做（單支 bundle 時 Vite HMR 對 apps/web 原生生效）。
- **production**：`pnpm build:web` → `web-bundle` 產出 dist → `web-host` 的 static fallback 認領 dist 目錄。

---

## Part 4 — 遷移步驟與驗證（每步可獨立驗證）

> 每步完成即跑「對應的既有測試 + 手動以既有 `./dist/main.js …` 起服驗證該畫面仍正常」。

1. **S0 — 骨架**：新增 `pnpm-workspace.yaml`、根 package.json、`packages/{web-host,web-client,ui-session,ui-admin,ui-vault,web-bundle,daemon-web-bridge}`、`apps/web`；`pnpm install` 可解析；不做任何 code 變更。驗證：`pnpm -w web:...` 空 script 可跑、既有 `npm test` 不破。
2. **S1 — host route registry**：`packages/web-host` 實作 `WebServer`；`src/web/server.ts` 改用/呼叫它，既有 route 平移。驗證：既有 login/admin/session portal 的 HTML 渲染與 API 全部與改前相同（跑 `src/test/login.test.ts`、`session-*.test.ts`、手動 curl）。
3. **S2 — boot 注入 + static fallback**：`web-host` 認領 fallback seat、serve `apps/web` 的 dist（先放一個 placeholder `index.html` + `root` div）；`tapIndex` 注入 `__DSH_BOOT__`。驗證：`curl /` 回傳 index.html 且 `<head>` 有 boot script；`curl /assets/x.js` 200；`curl /unknown` 也 200（SPA fallback）。
4. **S3 — React shell + session 頁**：`ui-session` 用 React 實作 session viewer（讀 `__DSH_BOOT__` → 對 `GET /api/session/...`（或既有 `/session` 資料面）fetch → 渲染 timeline/composer/SSE），`web-client` shell 組合它。驗證：`/session?token=…&session=…` 由 React 渲染、SSE 即時、`POST /session/message` 可送出、功能與舊版 HTML 等效。
5. **S4 — admin SPA**：`ui-admin` 對既有 `/admin/api/*`（平移後的 host route）做 React 管理頁（conversations/models/settings/events/vault link…）。驗證：admin 各 tab 皆可讀寫、行為與舊 HTML 等效。
6. **S5 — vault SPA**：`ui-vault` 做 login/link/OAuth 頁（既有 `/link`、`/api/oauth/start`、`/oauth/callback`）。驗證：API key 與 OAuth 兩模式皆可存 credential 到 vault。
7. **S6 — 收束**：把新 web 接到 `main.ts`（沿用 `startWebServer`，改用 registry + fallback），移除已替換的 `renderPortalShell`/inline script 或留作 fallback；跑完整 `npm test` + 手動 e2e。

---

## Part 5 — 風險與開放問題

- **pnpm**：monorepo 前置需要引入 pnpm（目前用 npm + 單一 package）。屬「新增工具鏈」層級，需使用者明確同意才換。**替代**：繼續用 npm workspaces（`workspaces` field）也能達成 packages/* 拆分，但不完全同 DSH（DSH 用 pnpm）。→ open question。
- **不動既有 `src/`**：§2.1「只拆網站」假設 `src/web/server.ts` 仍是 host 的擁有者、由它組 `web-host`。若要更徹底（把 `src/web/*` 整個搬進 packages），風險與 import 修改正比增加，視為後續選項。
- **bundle 策略**：先「單支 app bundle」後「多支 plugin bundles」兩階段（§2.4 退路）。單支時不需要 Cordis/plugin 生態，成本最低、最貼近「網站」而非「可插拔平台」。
- **SSE / WS**：session-view 的即時性，第一階段沿用 SSE（`/session/stream`）；是否升級 WebSocket（對齊 DSH `/api/events.mux`）列為後續。
- **token in URL/cookie**：維持現有 token-in-URL 模型以不破既有 `/session?token=` 連結；新 SPA 也須處理 deep-link（重整仍帶 token）。
- **繁中 UI**：admin/login 現為繁中以字串形式寫死於 HTML template。遷移到 JSX 時應抽 `web-client` 的 `locale`/`messages`，供未來 i18n。

## 附錄：驗證命令記錄

### S0 — workspace 骨架（已完成 2026-06-09）

**[實測]** 本地 pnpm 10.10.0：

- `pnpm install` 全 workspace 8 projects 成功；git-hosted `@geminixiang/mikan-starlight-theme` 需 pnpm 的 nested CLI 下載，沙箱 read-only 的 `~/.local/share/pnpm` 需以 `XDG_DATA_HOME=<repo>/.xdg` 重定向（環境特例，非 repo 內容；`.xdg/`、`.pnpm-store/` 已 gitignore）。
- `pnpm run build`（daemon, tsgo）成功；唯一阻塞是 `src/observability/sentry.ts` 在 pnpm 嚴格 node_modules 下 `createSentryInitOptions` 推斷型別無法命名（TS2883），以 `NodeOptions` return-type 註解修復（一行、行為不變）。另 `.npmrc` 設 `shamefully-hoist=true` 以 npm 式平舖相容既有型別圖。
- `pnpm test`：**123 files / 1735 tests 全數通過**。
- 新 host packages（`web-host`、`daemon-web-bridge`）`tsgo` 編譯出 `lib/`；`apps/web` Vite build 因 shell 尚未實作（`AppWebEntry` 不存在）屬預期失敗，S3 修復。
- 既有 CI 三檔 workflow 已切換 `npm ci` → `pnpm install --frozen-lockfile` + `pnpm/action-setup` + `cache: pnpm`；`package-lock.json` 保留供外部 npm 使用者（publish 流程仍以 npm publish 出 daemon package）。

### S1 — host route registry（已完成）

**[實測]** `packages/web-host`（`webserver.ts`）實作 DSH 的 route registry 模式：`register({kind:'exact'|'prefix', path, handler})`、`registerUpgrade`、單一 `registerFallback` seat、`tapIndex`/`applyIndexTaps`；handler 用「回傳 false = 不是我的」boolean contract，既有 portal handlers 免改直接平移。`src/web/server.ts::startWebServer` 改用 registry，既有的 `/health`、`/github/webhook`、`/api/agent-events/stream`、`/admin*`、`/session*`、login 四條 exact routes 平移；listen 失敗改 log 不 crash（同舊行為）。`startWebServer` 變 async，link-server/oauth-link-server 測試改用 await。

- 驗證：`packages/web-host` 21 tests；daemon 全量 1740 tests；真實 daemon boot 後 `/health` 200、`/unknown` 404、`/link?token=bad` 400、`/admin` 403、`/session?token=bad` 400、`/github/webhook` 404 —— 與舊 if-chain 一致。

### S2 — static-dist fallback + boot-manifest 注入（已完成）

**[實測]** `packages/web-host/static.ts`（`serveStatic` + `registerStaticFallback`，DSH frontend-static 模式：traversal 403、miss→index 200、index taps 注入）；`boot-manifest.ts`（`injectBootManifest` 把 `window.__DSH_BOOT__` 注入 `<head>` 首 script、`graphRev`）；`packages/web-bundle`（`composeWebBootGraph`、`contentRev`、`entryUrlOfIndex`）。`server.ts` 在 `webDistIndex` 存在時認領 fallback + 註冊 tap；`main.ts` 從 `MIKAN_WEB_DIST`（預設 `apps/web/dist/index.html`）傳入。

- 驗證：fixture dist boot 後 `/` 回 index 且含 boot graph、`/any/path` 200（SPA routing）、具名 route 仍優先、static asset 正確 MIME。

### S3 — React shell + session SPA（已完成）

**[實測]** `packages/web-client`（shell：manifest.ts/api.ts/App.tsx/boot.tsx，react-router + 浮動 nav + topbar）、`packages/ui-session`（`SessionPage.tsx`：fetch 新增的 `GET /api/session/view` JSON endpoint，訂閱既有 `/session/stream` SSE 做 live reload，`POST /session/message` 送出；markdown 用 `marked`）。型別單一來源移到 `packages/daemon-web-bridge`，`src/web/session-view/types.ts` re-export。dist 存在時 SPA 接手 portal 頁面 URL（`/session`、`/admin`、`/link` → fallback serve index），API/stream/message routes 仍由 daemon 處理。

- 驗證：`apps/web` Vite build 成功（~276 kB bundle）；`tsc --noEmit -p apps/web` 乾淨；`session-view-api.test.ts` 4 tests；daemon 全量 1740 tests；真實 boot 後 `/session?token=x` 回 SPA index + boot graph、`/session/stream` 仍 400、`/api/session/view?token=bad` 回 JSON error。

### S4 — admin SPA（已完成）

**[實測]** `packages/ui-admin`（`AdminPage.tsx`）：Conversations / Models / Usage / Events / Settings 五個 tab，全走既有 `/admin/api/*`（GET `?token=`、POST body 帶 `token`）。Conversations：office 列表 + `conversation-state`（model/door policy/auto-reply/slack）+ model picker 切換；Models 表（access status）；Usage 表（top 20）；Events 表；Settings 讀寫。

### S5 — vault/login SPA（已完成）

**[實測]** `packages/ui-vault`（`VaultPage.tsx`）：新增 `GET /api/link/info`（JSON：valid/expiresAt/oauthServices/existingSecrets）；API key 模式 `POST /api/link/complete`、OAuth 模式 `POST /api/oauth/start` → redirect。CSRF 沿用既有 enforceCsrf。link-server.test.ts 新增 `/api/link/info` test（9 tests 全過）。

### S6 — 收束（待）

- 新 web 已透過 `main.ts`（`MIKAN_WEB_DIST`）接上既有 boot；剩餘：瀏覽器層 e2e（本環境無 headless browser）、`renderPortalShell`/內嵌 script 的移除或保留決策、DSH 式 client-plugin HMR、knip 納入新 packages 白名單。
