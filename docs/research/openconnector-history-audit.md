# OpenConnector 串接歷史與殘留清點

2026-09-15；本輪只查 source/history，上線現況以 mikan HEAD `c615047` 為程式基準，不把未提交 provisioning-removal 實驗當成現行。OpenConnector 參考上游 `95b2babf91e20a8686c3362b7fb4e4c717cc0bc2`，未確認 VM 同版。未改產品程式、未搬 token、未呼叫遠端 token API。本文件補充 [storage ownership](openconnector-state-ownership.md) 與 [全域位置盤點](mikan-storage-inventory.md)。

## 歷史先分清楚

| 提交                 | 做了什麼                                                                                                 | 與 HEAD 的關係                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `d5759ac` / #137     | 早期 host connector gateway、connection store、login portal、connector.env                               | `git merge-base --is-ancestor d5759ac HEAD` 為 false；不是當前 main 祖先，不能說它的目錄現在仍在執行 |
| `97ecc66`            | 加入 generic MCP 上的 OpenConnector 特例：逐 Office token、自動 connection selection、Marketplace preset | 是當前實作來源                                                                                       |
| `a650655`            | 為 provisioning fetch 接上 shutdown abort signal                                                         | 真正的 lifecycle 修補，不是純相容垃圾                                                                |
| `3b39a48`            | 改 startup endpoint、移除 Marketplace preset、移除舊 ORIGIN 環境介面                                     | **保留逐 Office provisioning**，不是改共用 runtime token                                             |
| `5d83b65`, `374b11e` | 模組收斂／搬到 harness                                                                                   | 主要是 ownership/layout，不是另一套 token flow                                                       |
| 本輪未提交實驗       | 改 manual runtime token、刪 provisioning、加 oct_ 檢查                                                   | 未被接受；9 個 tracked files 的修改仍停留 worktree，與本清點隔離                                     |

舊 gateway 的 `S/connector/connections.json`、`.connections.lock`、`connector.env` 不存在於 HEAD 的 active implementation；不能從 all-branch history 把它們算成現行殘留。`git grep HEAD` 未找到 `OPENCONNECTOR_ORIGIN` active 引用。

## 現行唯一主路徑

`main` endpoint → runtime options → runner (Office + workspaceId + trust) →
`provisionOfficeOpenConnectorToken` → 本機五欄 token state 或 remote create →
resolved MCP map → generic loader → host MCP calls。

主路徑只有一套，沒有確認三代 gateway 同時執行。真正問題是設定控制面不一致、provider-specific coupling、未完成的 credential lifecycle，而不是所有額外欄位都沒用途。

## 可確認的殘留與半套行為

### A. Admin 宣告與 runner 實際值不一致

- `config.ts` schema 允許任意 `mcpServers` 名稱，也保存 `open-connector`。
- `open-connector.ts:176-181` runner 永遠丟棄該保留名稱，改用 startup provisioning。
- `admin/portal.ts:1445-1462,1513-1554` generic import/toggle/remove/test 沒有拒絕保留名；verification 直接 `loadMcpTools`，不走 runner 的 reserved replacement。

所以 Admin 可保存／驗證一份設定，但真實 runner 使用另一份。不是只留了無害舊欄位；有兩套控制語意。這是 source-level call-chain 確認，未進行線上操作。應統一保留名在 configuration ingress 的處理，不讓 UI 假装控制 startup-owned server。

### B. Generic MCP loader 包含 OpenConnector 專用工具參數修補

`harness/mcp.ts` 匯入 `prepareOpenConnectorToolArguments`；每次 `get_action_guide` /
`execute_action` 缺 connectionName 時，多呼叫一次 `list_connections`，以 service
唯一連線補參數。這是活的功能，不是 unused helper，但把 provider selection 規則
放進通用 transport，且有額外 request/latency。

Helper 同時接受 `payload.data` 或 `payload.connections`。上游當前 `src/mcp.ts`
用 `successPayload` 返回列表；另一形狀是未證實仍有 consumer 的相容分支。
不能未查線上版本就刪；也不能當成永遠需要的 compatibility layer。

**不能直接拿掉整個 helper**：上游 `connection-service.ts:886` 省略 name 會選
`default`；mikan 目前是唯一具名 connection 時自動選它。兩者語意不一定相同。
需要以 default/唯一非 default/多 connection 的 fixtures 比較。

### C. Office identity 的宣稱大於實際授權

建立 token 僅複製 deployment actions/proxies，沒有送 `allowedConnections`。
上游 `action-policy.ts:176-195` 的空 connection allowlist 代表不限 connections。
因此獨立 token ID/name 提供識別、未來個別撤銷能力，不等於 Office 資料 ACL。
`ARCHITECTURE.md`、CONTEXT 和 module README 的 scoped authority 說法需要更精確。

逐 Office 命名所需 `platformWorkspaceId` 經 Slack → runtime → runner 傳遞，HEAD
確實有使用，不是可直接刪的 unused field。未提交實驗刪掉消費者後留下的 plumbing
才是該實驗自己引入的未完成收斂。

### D. Token 生命週期只做 create/reuse

`open-connector.ts:191-227` 有持久化與同程序 single-flight，沒有 revoke、policy
update、遠端失效後 recovery。保留檔案即使 remote token 已被撤銷仍先回傳它，之後
由 MCP authentication 失敗。不能把本機 record 說成完整 token manager。

即使已有 token，入口 `:243-249` 仍要求 admin env 存在；因此不是只在需要 mint 時
才需要 bootstrap authority。這是實際耦合，是否解除需明確定義而非偷改啟動行為。

同一程序的 pending key 只有 `origin:office.key`，沒含 stateDir/name(workspaceId)。
單部署通常不暴露，但多 workspace embedder 同時建立相同 OfficeKey、不同 state
時可共用錯誤 pending result。這是可推導的 scoping 缺口，尚未新增並行重現測試。
共享 creation promise 也共用首位 caller 的 abort signal；不同 waiter 的取消並非
獨立。不能把 single-flight 等同完整 concurrency ownership。

### E. 五個欄位逐一判定

| 欄位    | HEAD 真正使用                                         | 判定                                                                               |
| ------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| version | schema 固定 1，沒有多版本 migration branch            | 格式檢查，不是權限；若嵌入 settings 可重新考量是否需要自己的版本                   |
| origin  | reuse 前比對目前 endpoint.origin                      | **有效的錯送憑證防護**，不是每 Office 的可選 endpoint                              |
| name    | remote create/response 校驗、本機 reuse identity 校驗 | 衍生冗餘，但有驗證用途；移除需替代 Office/workspace binding                        |
| id      | create response required、保存、建立 log              | 正常工具呼叫只用 token；id 是 remote revoke/update 所需 handle，manager 尚未使用它 |
| token   | MCP Authorization bearer                              | 必需秘密；遠端只存 hash，不能無代價取消本機持久化                                  |

`origin` 比對只保護 origin 改變；同 origin 後端換部署/路徑不等於可識別 integration
更換。不要把它說成完整 endpoint binding，也不要把限制不足當成完全無作用。

### F. 重複讀取與失敗分支

`loadOrCreateRuntimeToken` 先 read、create closure 再 read。第二次讀取是在 effect 前
重查磁碟，不能只因看似重複就刪；但它不構成跨程序 lock，內層也沒重做 origin/name
驗證。atomicWritePrivateFile 保證單檔可見性，不保證 remote create 與 local save 的
原子交易；remote 成功/local 失敗可能留下 orphan token。

`disabledServer`、open-trigger gate、reserved endpoint、timeout/abort、0600 atomic
write 都有當前責任，不應作為垃圾一併移除。

## 如果改放 Office settings，需一起收斂的真實程式點

使用者傾向 `S/conversations/K/settings.json`；本輪不重新推銷 integrations 路徑。

- Schema 要有 system-owned credential record，但不要混入可繼承的 `mcpServers`。
- `config.ts:compactSettingsConfig` 只重建 llm/sentry/sandbox/slack/mcpServers；直接手工
  加新欄位，後續 model/settings mutation 可把它丟掉。必須先補 preservation tests。
- Runner 的 `normalizeSettingsConfig` 不應把 raw token 散播到一般 config/context。
- Admin serializers/redaction、每種 settings patch、門政策 writer、migration marker
  都要驗證，不只是搬 JSON。
- 自動取得 token 需在 await remote 返回後讀最新設定並保存，不能用舊 settings snapshot
  覆蓋使用者剛改的 model/MCP。多程序並行另有協調需求。
- 舊 file migration 不能用 arbitrary `full` 或 global defaults 推導另一個 Office 身分。
- 保留 startup provisioning 與權限語意；位置合併不等於改 credential principal。

## 未提交實驗與本輪驗證限制

未提交 experiment 是需要隔離處理的額外改動，不能算修好歷史垃圾：手動 token、
必填新 env、startup fail、取消 provisioning、prefix 判斷都尚未獲接受。
此輪沒有執行該 experiment 的 tests 來替 HEAD 背書，也沒有刪它。只新增本研究檔。

後續需以 HEAD 合成測試確認：Admin reserved-name 行為、settings 保存新 record、
pending 多 stateDir/取消、remote revoke 後行為、唯一非 default connection 與舊回應
形狀。既有 HEAD 七個 provisioning tests 是 mocked fetch，主要覆蓋成功、重用、
同 Office concurrent、startup endpoint、防止非 Slack/open-trigger、provision failure；
沒有把這些新增問題覆蓋完整。
