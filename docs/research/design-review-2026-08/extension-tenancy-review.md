# mikan extension tenancy model 架構評審

## 結論摘要

草案抓對了兩個核心方向：**安裝 code、啟用功能、使用資料必須是不同權限與生命週期**；以及 extension 不應自行拼接 mikan 的 state-dir 路徑。但四條主張目前仍混合了三件不同的事：

1. code 是否被部署信任並可供使用（availability / trust）；
2. 哪個 office 實際啟用哪個 extension 與版本（activation / binding）；
3. extension callback 以誰的權限、資料與執行環境運作（runtime principal）。

我的主要判斷如下：

- **主張 1：方向正確，但現況沒有真正實作三 actor 的權限邊界。**
- **主張 2：部分反對。** code 應由 deployment 管理並留在 host-only catalog，但「global install 只是預設啟用的糖」在多團隊共用部署時不成立；global availability、office activation、deployment rollout policy 必須分開。
- **主張 3：同意方向，反對只用 `(slug, scope)` 當完整 identity。** 應提供 capability-based storage，但 namespace 至少要綁定 deployment、穩定 extension identity、activation instance/office；並明定 schema migration、quota、刪除與共享資料治理。
- **主張 4：前半與後半互相矛盾。** extension 只要仍是載入 host process 的任意 Node.js code，就能直接 import `node:fs` / `node:child_process`；「不給 fs API」無法形成安全邊界。若要強制所有 office I/O 經 executor，extension code 必須移出主進程或被真正 capability sandbox 隔離。短期只能把它定義成 trusted deployment code 的規範，不可宣稱已隔離。
- **Schedules 必須有 principal。** 現有 callback schedule 是 office-owned activation 的排程，即使觸發時沒有聊天訊息，仍歸建立它的 office；真正 deployment/workspace 級 daemon job 應是另一種 service activation，不應借用任意 office。

---

## 一、現況模型

### 1. Code discovery 與 activation 目前是同一件事

`src/harness/extensions/loader.ts` 明確寫著掃描到的 extension 全部 activation（line 14），載入順序為 global code directory，再到 office code directory（lines 81–93）；同 slug 時 office copy shadow global copy（lines 731–740）。`loadExtensions()` 對最後勝出的每個 entrypoint 直接 import 並呼叫 `activate()`（lines 645–704）。

因此目前沒有獨立的 activation declaration：

- global package/extension 被宣告後，對所有 conversation 自動生效；
- conversation package/extension 被宣告後，對該 office 自動生效；
- 沒有 `enabledExtensions`、activation record、per-office capability grants 或 per-office extension config schema；
- package declaration 同時代表 code acquisition、availability 與 activation。

`src/config.ts` 的 scope 設定只有 `packages[]`（lines 123–124）。`resolveConversationSettings()` 特別避免把 global package list 當成 conversation list，真正的 additive resolution 留給 packages module（lines 348–367），但仍沒有 extension activation layer。

### 2. Code 目前不是「永遠 global」

目前有兩種實體 code scope：

- `<stateDir>/global/extensions/<slug>`；
- `<stateDir>/conversations/<office-key>/extensions/<slug>`。

`src/harness/extensions/LAYOUT.md` 把兩者設計成 isomorphic sibling scope，並且允許 office-local extension code。`src/packages/README.md` 與 `resolve.ts` 也規定 global 和 conversation package additive，同 package identity 時 conversation copy 勝出。這支援「某個 channel 固定 v2、其他 channel 留在 v1」。

Package Admin 的 `addPackage(scope, ...)` 可直接對 global 或 conversation scope materialize 並寫入 settings；下一個 harness instance 就 activation（`src/packages/admin.ts` lines 1–13）。

### 3. 安裝是 host trust decision，但 actor 尚未分離

現況已清楚承認 extension 是 trusted host code：

- loader 文件說 module 在 mikan host process 以完整權限執行，可接觸 platform tokens、vault、host filesystem；
- `src/packages/README.md` lines 96–99 說 materialized code 以完整權限 import；
- package materialization 會在 host 執行 `git` 與 `npm install`，而 npm dependency lifecycle scripts 也會執行（`src/packages/materialize.ts`）。

這表示「安裝 code 是部署管理員行為」在 trust model 上已成立。但目前同一套 Admin package mutation 能寫 global 或 conversation package declaration，並沒有程式層的 deployment administrator 與 conversation owner authorization model。換句話說，三 actor 目前主要是概念，不是 enforced principal。

Extension author 的 manifest 現在只可宣告 entrypoint、display metadata、skills 與 secrets；required secrets 會在 import 前檢查（`loader.ts` lines 658–675）。作者尚不能宣告：

- activation requirements；
- storage scope/capability；
- office executor/fs/exec capability；
- platform operation capability；
- schedule種類與 ownership；
- config schema/default/migration。

### 4. Storage 現況直接暴露 host path

目前 API 提供：

- `api.paths.dataDir` → office-private host directory；
- `api.paths.sharedDataDir` → deployment-global cross-conversation host directory。

loader 直接 `join()` state dir 並 `mkdirSync()` 後回傳 absolute path（`loader.ts` lines 443–455）。Extension 可以用 Node fs、sqlite path 或任何 native library 操作它，backend 實際上不可透明替換。

更重要的是，這不是唯一可碰的路徑。Extension 本身已擁有 host process 權限，所以它可以忽略 API，讀寫任意 host path。`dataDir` 是 convention，不是 capability boundary。

目前 `sharedDataDir` 要 extension 作者自行按 conversation id partition 並處理 concurrency；`src/harness/README.md` lines 321–327 明確承認這一點。這對可信的單一部署 app 可以運作，但不是安全的 multi-tenant storage abstraction。

### 5. Secrets 現況是 global-by-slug，不跟 activation scope 走

Vault 對 extension 保留 `vaults/extensions/<slug>` namespace（`src/vault/README.md` lines 20–26；`src/vault/index.ts` lines 20–27）。`buildExtensionHostServices()` 以 `vaultManager.resolve("extensions/${slug}")` 提供 secrets（`src/agent/catalog.ts` lines 185–191）。

所以同 slug extension 在所有 offices 看到同一份 extension secret：

- 沒有 office-scoped extension secret；
- 沒有 activation-specific secret binding；
- office-local v2 shadow global v1 時仍共用同 slug secrets；
- conversation owner 無法自然地只為自己的 activation 提供 credential，而不影響其他 tenant。

這與草案「config 跟著 activation」存在明顯差距，也會被該模型判為錯誤。

### 6. Schedules 現況其實已有 office principal

`src/extension-schedules.ts` 的 callback schedule 保存於：

`<stateDir>/conversations/<officeKey>/extension-schedules/<slug>.<name>.json`

record 內保存 platform、conversationId、slug 與 callback。開機時 process-wide scheduler 掃描所有 office schedule；fire 時 dispatch 到該 conversation runtime，materialize 該 office 的 runner/extensions，再執行對應 callback，且不啟動 model turn（file header lines 1–15；dispatch lines 253–269）。

因此它雖然「無聊天訊息觸發」，並不是「無 tenant」：目前 owner 是建立 schedule 的 office activation。這是現況中最接近草案正確 tenancy 的部分。

另外 text schedules 與 callback schedules 是不同 authority；`ARCHITECTURE.md` lines 155–168 已要求不能合併成 generic scheduler。

---

## 二、四條主張與現況差距，以及哪些現有機制會被判為錯

## 主張 1：三 actor

### 與現況差距

概念上已有角色影子，但沒有完整 enforcement：

| 草案 actor               | 現況                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 部署管理員：安裝 code    | host-only materialization 與 full-trust import 符合；但 global/conversation package mutation 使用同一 Admin 能力 |
| 對話擁有者：啟用與設定   | 沒有獨立 activation/config record，也沒有明確 conversation-owner principal                                       |
| extension 作者：宣告需求 | 只能宣告 secrets/entrypoint/metadata；無 capability、config、storage、schedule requirements                      |

### 會被模型判錯的現有機制

1. `packages[]` 同時表示「抓 code」與「啟用功能」。
2. conversation-scoped package add 會讓 conversation-side declaration 直接導致 host import；若 conversation owner 真是低於 deployment admin 的 actor，這是不允許的 trust escalation。
3. extension required secret declaration只檢查 global-by-slug secret 存不存在，沒有由 activation owner 明確 grant。
4. Admin 權限若是 deployment-wide，不能直接等同 conversation ownership；若未來有多團隊，必須有 office ACL 或外部 identity mapping。

### 評價

**同意主張，但 ADR 必須把「actor」寫成 authorization principal，而不是 UI persona。** 特別要回答誰能：approve artifact、bind version、grant capability、set secret、disable activation、inspect shared data、delete schedules。

---

## 主張 2：code global；activation per-office；global install 只是 default activation 的糖；config/data 跟 activation

### 與現況差距

現況正好相反地耦合：

- code 有 global 與 conversation scope；
- activation 是 discovery 的副作用，沒有獨立 scope；
- global package 永遠對所有 offices activation，不只是可撤銷的 default；
- data 同時有 office-private 與 global shared；
- secrets 是 deployment-global by slug；
- package version override 是靠 office-local code copy shadow global copy完成。

### 會被模型判錯的現有機制

1. `conversations/<office>/extensions` 與 conversation package checkout，因為 code 不再應由 office scope「安裝」。
2. global scan directory 中每個 extension自動 activation。
3. `packages[]` additive inheritance；global package 無法在單一 office opt out。
4. 以 code shadowing 實作 office version pin，而不是 activation binding 指定 artifact/version。
5. `sharedDataDir` 不跟單一 activation 生命週期。
6. `vaults/extensions/<slug>` 不跟 office activation/config 走。

### 「global install 只是糖」是否成立

**在多團隊共用一個 deployment 時不成立，至少不能作為唯一語義。**

理由：

1. **Install 是 trust/availability；activate 是 tenant consent。** 部署管理員批准一段 code 可被使用，不代表所有團隊同意讓它觀察 hooks、攔截 tool calls、註冊 commands、讀取訊息或發送通知。
2. **Global default 若動態繼承，blast radius 過大。** 管理員新增或升級 package 後，既有所有 offices 在下一次 runner materialization 都會執行新 code。目前就是這種行為。對 shared deployment，這是 rollout policy，不是語法糖。
3. **團隊需要 opt-out、版本 pin 與 staged rollout。** 若 default 永遠覆蓋，owner 沒有 consent；若 owner 可 override，就必須定義 inherited、explicit enabled、explicit disabled 三態，已不再只是糖。
4. **不同平台 trust model 不同。** GitHub open-trigger conversation 與 membership-gated Slack channel 不應自動接受同一組 extension capabilities。
5. **hooks 是旁路權限。** 即使 extension 不使用 secrets，它仍能看到 context、tool calls/results、message lifecycle，對 tenant 而言 activation 本身就是資料授權。

### 替代方案

將三層重新命名並解耦：

1. **Deployment artifact catalog（global）**
   - deployment admin approve/materialize code；
   - artifact 以穩定 extension identity + immutable version/digest 表示；
   - code 僅存在 host-controlled deployment store；
   - 「global」只表示 availability/trust，不表示 activation。

2. **Office activation binding（per-office）**
   - `(office, extension-id) -> artifact version, status, config, grants, secret bindings`；
   - office owner可 enable/disable 可用 artifact；
   - deployment policy 可禁止某 extension、鎖版本或要求 capabilities 不可由 owner grant。

3. **Deployment rollout policy（不是 install 的糖）**
   - 可設定 eligible office selector、recommended/default-enabled、mandatory、blocked、version channel；
   - default-enabled 最安全的語義是**建立 office 時複製成 explicit activation**，避免日後修改 default 無聲改變既有 tenants；
   - 若確實需要動態 inheritance，activation state 至少要有 `inherited-enabled | explicit-enabled | explicit-disabled`，並提供 audit/preview/staged rollout。

4. **Version override**
   - 不再靠 office-local code checkout shadow global；改由 activation binding 指向 catalog 中的 artifact digest；
   - 物理上可為 cache 效率保留多份 checkout，但那是 deployment storage implementation，不是 tenancy ownership。

因此我同意「code trust authority 是 global」，但反對「global install = default activation」。應改成：

> Code approval and availability are deployment-scoped. Activation is office-scoped. Deployment policy may propose, mandate, or seed activations, but installation alone never implies tenant activation.

---

## 主張 3：只給 `(slug, scope)` namespace storage handle；不可拼路徑；backend 可換

### 同意之處

這會修正目前最明顯的 abstraction leak：`api.paths.dataDir` / `sharedDataDir` 暴露 absolute host path，extension 直接依賴 Node fs 與 sqlite filename，無法換成 object store、database service、remote sandbox storage 或加 quota/audit。

### 主張需要修正之處

**`(slug, scope)` 不足以成為安全、長期穩定的 storage identity。**

1. slug 來自 install directory，現在雖會 normalize，但不是 publisher-qualified identity；不同作者可碰撞。
2. 同 slug 的不同版本可能需要 migration，不可默認讀寫相同 schema。
3. `scope` 若只有 global/office，沒有指出是哪個 office、哪次 activation、哪個 deployment。
4. extension uninstall/reinstall、rename、fork、ownership transfer 的資料處置不清楚。
5. cross-office shared store 的讀寫權限不是僅靠 namespace 就能解決；需要 activation grants 與資料治理。

### 替代方案

提供 capability handle，但 identity 建議至少是：

`(deployment-id, extension-id, storage-class, tenant-key)`

其中：

- `extension-id` 是 manifest 中穩定、publisher-qualified 或由 deployment catalog 指派的不可變 ID，不是 display slug；
- `storage-class` 至少區分 `office-private`、`deployment-shared`；未來若需要可增 `workspace/org`，不要先假設只有兩層；
- `tenant-key` 對 office-private 是 office key 或 activation id；shared store 則是明確的 shared app instance；
- activation record 決定 extension 拿到哪些 handles。

API 不應只是把 path 包成薄 wrapper。它至少要提供可替換 backend 的實質語義，例如 transaction/compare-and-set、key/value 或 blob API、list/delete、quota、locking/concurrency、schema version/migration、backup/export、activation deletion retention。若 extension 必須使用 SQLite，則應明確提供一個「managed database handle」或受控 local database capability；單純回傳另一種 opaque path 最終仍綁死 filesystem backend。

此外必須分開：

- **extension private state**：走 storage handle，host-authoritative；
- **office workspace files**：走 office executor；
- **temporary transfer/upload data**：走明確的 blob/attachment capability，而不是任意 host path。

`sharedDataDir` 的替代物不應預設授予。它應是 extension manifest 宣告 + deployment admin approve + office owner知情的 cross-tenant capability，並有 audit 與資料刪除規則。

---

## 主張 4：hooks/commands/schedules 跑 host；fs/exec 一律走 office executor；不給獨立 fs API

### 與現況差距

目前 hooks、commands、actions、schedule callbacks 確實在 host process 的 extension registry/runner 中執行；但 extension module 本身是 unrestricted Node.js code。它可：

- import `node:fs` 讀寫任意 host file；
- import `node:child_process` 執行 host command；
- 讀 `process.env`；
- 存取 module 可到達的 process-global resources；
- 跳過任何 MikanExtensionApi capability。

所以現有整套 extension loader、package import 與 direct path API 都會被嚴格 capability model 判錯。`api.uploadFile(filePath)` 目前甚至直接接受 host file path（`loader.ts` lines 597–601）。

### 主張本身的矛盾

**只要 arbitrary extension code 仍在 host process，移除 fs API 並不能禁止 fs/exec。** TypeScript interface、documentation、lint 或 module import convention 都不是 security boundary。Node ESM 沒有可靠的 per-module builtin denylist 可用來保護同一 process 的 secrets 與 filesystem。

此外「所有 fs 都走 office executor」也太絕對：

- extension private state 不應寫進 office sandbox filesystem，否則 agent可能讀改 host control-plane state；它應走 storage handle；
- package install/materialization 是 deployment action，應由 deployment package service執行，不屬於任何 office executor；
- schedule metadata 是 host-authoritative control-plane state，也不應交給 sandbox executor；
- 只有 extension 要操作該 office 的 workspace、執行命令或讀取 runtime path 時，才應走 office executor。

### 替代方案

建議 ADR 明確選擇下列二者之一，不可混寫：

#### 方案 A：短期 trusted in-process extension model

- extension 是 deployment-admin-approved、等同 mikan plugin 的 trusted code；
- capability API 是正確用法與可移植性界面，但**不是安全隔離**；
- office workspace fs/exec 必須依規範使用 executor；private state 使用 storage handle；
- 可用 static scan、review、signed artifacts、audit logs 降低風險，但不能宣稱禁止 direct fs/exec；
- secrets/platform APIs 仍應只透過最小 capability 提供，以降低 accidental misuse，但需承認 malicious extension 可繞過。

這最符合現況，改造成本最低。

#### 方案 B：真正 capability-isolated extension runtime

- extension code 移出主 mikan process，放到獨立 process/worker/VM/container；
- runtime 不注入 host env、state dir、platform token；
- IPC/RPC 只暴露 hooks event、storage、office executor、notify、schedule 等 capabilities；
- 每個 invocation 或 activation 綁定 office principal；
- host 驗證所有 target office、rate limit、payload size、timeout 與 cancellation；
- 若需要 npm native dependencies，隔離單位與 artifact build pipeline 必須一起設計。

若 ADR 想把「不能 direct fs/exec」寫成 invariant，就必須選 B；否則只能寫成 future target/deviation。

---

## 三、Schedules 到底歸誰

「沒有對話訊息觸發」不等於沒有 owner。應按 schedule 執行時使用的 authority 分類。

### 1. Office activation callback（現有類型）

Owner 應是：

`office activation = (office, extension-id, activation-id/version)`

它：

- 由該 office activation 建立；
- 使用該 office 的 config、secret bindings、storage handles 與 executor；
- 經該 office runtime serialization；
- activation disable/delete 時必須 pause 或刪除；
- version upgrade 時需定義 callback compatibility；
- schedule record 不應只靠 slug 找 handler，最好記 activation/artifact identity 與 callback schema version。

現有 `extension-schedules.ts` 大致已遵循 office ownership，但只記 platform/conversationId/slug/name/callback，activation identity 與版本語義不足。若 global code 不再自動 activation，fire 時必須先驗證 activation 仍有效；不能因 catalog 仍有 code 就執行。

### 2. Cross-office application schedule

如果 agent-pm 類 app 需要處理多個 offices，不應讓它任意選一個 office 當假 owner。可建立明確的 **shared app instance / workspace service activation**：

- deployment admin 或 organization/workspace owner建立；
- 有自己的 config、shared storage、secret bindings 與 scheduler principal；
- 被授權的 offices 僅是 membership/targets；
- 對某 office 執行動作時，host 重新做該 office capability check；
- 不自動取得所有 office executor 或 credentials。

### 3. Deployment maintenance schedule

例如 artifact refresh、cleanup、migration、health check，owner 是 deployment control plane，不是 extension office activation。它不應使用 conversation vault 或 office executor，除非透過明確 delegated job。

### 4. Text/user-facing schedules

維持現有與 callback scheduler 的分離。會合成 conversation event、進入 model/session/queue 的 schedule，和直接執行 trusted callback 的 schedule 有不同 authority、failure semantics 與 audit trail，不能因共用 cron backend 就合成同一 domain object。

---

## 四、建議 ADR 採用的修正版決策

建議將草案改寫為以下六條，而不是原四條：

1. **Artifact trust is deployment-scoped.** 只有 deployment administrator 可批准或 materialize 會被 host 執行的 code。Office owner 不可用 conversation config 引入未批准 code。

2. **Activation is explicitly office-scoped.** 每個 extension 對每個 office 都有 activation record，包含 artifact/version、enabled state、config、capability grants、secret bindings 與 lifecycle metadata。

3. **Installation does not imply activation.** Deployment policy 可 seed、recommend、mandate 或 dynamically inherit activation，但這是獨立、可 audit 的 rollout policy；不能把 global install 本身定義成 default activation。

4. **Extension state is capability-scoped.** Extension 不取得 state-dir path。Private state、shared app state、office workspace I/O 使用不同 handles；stable identity 不只依賴 slug，並明定 migration/quota/retention/concurrency。

5. **Runtime authority follows the activation principal.** Hooks、commands、actions與 office callbacks 都以其 office activation 執行。無 office owner 的 shared/deployment jobs 使用不同 service principal，不借用任意 conversation。

6. **In-process extensions remain fully trusted until isolated.** 在完成 out-of-process/capability sandbox 前，「不得 direct fs/exec」只能是 API contract 與 portability rule，不是 enforceable security invariant。Office workspace fs/exec 走 executor；extension private state與host control-plane state不走 executor。

---

## 五、若採用修正版，現有機制的遷移優先序

### 第一階段：先拆語義，不先搬 runtime

1. 新增 deployment artifact catalog 與 office activation record。
2. 現有 global packages migration 成「approved artifacts + legacy inherited activation policy」。
3. 現有 conversation packages migration 成「office activation pin」，但 code materialization authority移到 deployment catalog；對 local source需標成 dev-only administrator capability。
4. loader 改成只載入 resolved active bindings，不再掃到即 activation。
5. 增加 explicit disabled，讓 office 可 opt out non-mandatory deployment defaults。
6. schedule fire 前驗證 activation id/status，disable/uninstall 時處理 schedules。

### 第二階段：修正 secrets/config/data scope

1. extension manifest 加 stable extension ID、config schema、capability requirements。
2. secrets 從 `extensions/<slug>` 演進為 activation secret bindings；可引用 deployment secret、office-owned secret或 shared app secret，但不直接複製值。
3. 以 managed storage handle取代 `paths.dataDir/sharedDataDir`；先提供 compatibility adapter，並把 direct paths 標為 trusted legacy API。
4. 定義 activation deletion、office deletion、extension upgrade 的 data/schedule lifecycle。

### 第三階段：若需要真正第三方隔離，再移出 process

1. IPC hook protocol；
2. storage/executor/platform/schedule capability service；
3. timeout、memory、network與concurrency policy；
4. artifact signing/build與native dependency策略；
5. 將 direct Node host imports 列為不支援，而不只是 lint warning。

---

## 最終評語

這篇 ADR 值得立，但不應把「global」同時用來表示 code trust、default rollout、shared data 與 service ownership。Mikan 已經以 Office 作為 conversation 隔離與 authority 的核心，extension model 應延續同一原則：**所有 runtime 行為都要能回答是哪一個 activation principal；所有跨 office 行為都必須是額外、顯式的 service authority。**

最重要的兩個修正是：

1. 把「global install 只是糖」改為「deployment availability 與 rollout policy 分離，installation alone never activates」；
2. 把「host 內執行但不能碰 fs/exec」改成誠實的二選一：目前是 fully trusted in-process code，或未來移到真正 capability-isolated runtime。
