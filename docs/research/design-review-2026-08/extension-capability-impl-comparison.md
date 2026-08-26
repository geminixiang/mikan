# Capability contract:三個獨立實作的對比(2026-08-26)

同一規格(`/tmp/mikan-ext-capability-spec.md`)由三個 agent 獨立實作:
A(本 branch)、B(`impl-b` worktree)、C(`impl-c` worktree)。

## 快速結果

| 項目                      | A     | B                                              | C                                                          |
| ------------------------- | ----- | ---------------------------------------------- | ---------------------------------------------------------- |
| build / 相關測試          | ✅    | ✅                                             | ✅                                                         |
| 全 gate(lint+knip+全測試) | ✅    | ❌ knip:unused export `EXTENSION_CAPABILITIES` | ❌ public-api snapshot 未更新                              |
| 範例正確性                | ✅    | ✅                                             | ❌ periodic spec 漏必填 `timezone`(型別錯誤,scaffold 同病) |
| 淨行數                    | ~+430 | +437                                           | +370                                                       |

## 設計差異與判斷

**Capability 命名**:A 鏡射 `ExtensionHostServices` 欄位語意(`messaging` =
postMessage);B/C 用 extension 作者可見的 API 面命名(`messaging.notify`、
`reactions`、`uploads`)。**B/C 的方向對**:作者宣告的是「我要用
`api.notify`」,不是「host 要有 postMessage service」——名字應跟著作者看得到
的表面。已把 B 的命名併入 A(`schedules.text`/`schedules.callback`/
`messaging.notify`/`messaging.open-dm`/`messaging.history`/`messaging.users`/
`blockkit`/`reactions`/`uploads`/`secrets`/`subagent`)。

**單一 authority 的位置**:A 放 loader.ts 內部表;B 開新檔
`capabilities.ts`;C 放 types.ts。B 的新檔以 File-Split Scale 檢驗不成立
(單一消費者、無獨立變化軸);C 把帶邏輯的 const 放 types.ts 違反
「types.ts 放型別」慣例。**A 的位置對**:表住在唯一消費它的 loader 裡,
型別住 types.ts。

**未知名稱處理**:三版一致收斂(validate 警告、activation fail-closed)——
獨立同構是好訊號,этот決策寫進了 ADR。

**檢查順序**:B 把 capability 檢查放在 secrets 檢查之前,理由是「結構性缺失
先於供裝缺失」。有道理但影響極小(兩者都在 import 前、都 fail-closed),
A 保持 secrets 先(與既有測試序一致),不採。

**`has()` 簽名**:B 接受任意 string(方便探測來自設定的名稱);A/C 只收
union type。**A/C 對**:寬鬆簽名犧牲拼字檢查,設定驅動的場景可以 cast。

**C 的獨有貢獻**:範例用 tmp+rename 原子寫入示範。好實踐,但 golden-path
範例的首要目標是最小可理解,不採;`api.state`(deferred item 2)落地時
把原子性做進 primitive 才是正解。

## 結論

以 A 為基底(唯一全 gate 通過),併入 B 的 capability 命名。B/C worktree
保留至 PR merge 後刪除。
