# mikan Sandbox / Vault / Execution Resolver 設計審查

審查框架：AGENTS.md File-Split Scale（Slot / Authority / Weight）與 ADR 0003–0005 的 Conversation Office 隔離模型。

範圍：`src/sandbox/`、`src/execution-resolver.ts`、`src/provisioner.ts`、`src/workspace-projection/`、`src/vault/`，以及確認 authority 是否被 caller 繞過所需的直接呼叫點。

> 本文件記錄目前已完成的 findings；審查為只讀，未修改 repository source。

## High severity

### 1. `/login copy` 把 credential key 當成 runtime resource key

- **Severity:** High
- **檔案：行號：**
  - `src/commands/login.ts:40-47`
  - `src/commands/login.ts:56-76`
  - `src/sandbox/identity.ts:30-36`
  - `src/sandbox/identity.ts:63-70`
  - `src/execution-resolver.ts:44-51`

#### 問題

`ensureLoginVault()` 回傳的是 `credentialAuthorizationKey()`；image 模式下它是 office key。但 image runtime 的 container key 是 `runtimeResourceKey()`，目前仍由 raw conversation ID 派生。

`refreshCopiedVaultRuntime()` 卻直接執行：

```ts
await context.services.provisioner.remove(vaultId);
```

因此它把兩種不同 authority 的 identity 混在一起。可能結果是 session cache 被清掉，但真正持有舊 credential file mounts 的 container 沒被刪除；使用者卻收到 container 已移除的成功訊息。

這也是 `ActorExecutionResolver` 的 execution-plan authority 被 caller 繞過後產生的具體錯誤。

#### 最小修正方向

不要讓 `refreshCopiedVaultRuntime()` 接受語義不明的裸 `vaultId`。用 target `OfficeAddress` 經由同一個 resource identity authority 取得 `resourceKey`，或由 resolver/identity plan 回傳 `{ credentialKey, resourceKey }`，只將 `resourceKey` 傳給 provisioner。

---

### 2. Runtime resource identity 仍由 raw conversation ID 派生，跨平台 office 可能共用 runtime slot

- **Severity:** High
- **檔案：行號：**
  - `src/sandbox/identity.ts:56-70`
  - `src/execution-resolver.ts:44-51`
  - `src/execution-resolver.ts:105-119`
  - `src/provisioner.ts:114-165`

#### 問題

ADR 0005 已將 office、vault、host state 改為 platform-aware `OfficeAddress` / office key；但 `runtimeResourceKey()` 只接受 `{ userId, conversationId }`，不含 platform。

image container、Gondolin instance、Cloudflare sandbox scope 因此仍可能讓不同平台的相同 raw ID 指向同一 resource key。

這不只是多 recreate 一次：Docker provisioner 發現 mount drift 時，預設會保留既有 writable layer 再以新 mounts 重建。兩個 office 可能交替接手同一 writable layer。Gondolin 也以相同 `instanceId` 使用同一 session slot，只靠 fingerprint replacement。

這與 ADR 0003「每個 conversation 保持獨立執行環境」不一致。mount drift detection 不能取代唯一的 runtime identity。

#### 最小修正方向

讓 `runtimeResourceKey()` 接受 `OfficeAddress`。Conversation-scoped backends 應使用 office key，或使用由 office key 派生的 resource-safe key。升級時做一次明確的 resource naming migration。

---

### 3. Direct `container:*` 未驗證 `/workspace` mount，卻宣稱可映射回 host workspace

- **Severity:** High
- **檔案：行號：**
  - `src/sandbox/container.ts:95-102`
  - `src/sandbox/container.ts:136-142`
  - `src/sandbox/container.ts:149-155`
  - `src/sandbox/types.ts:116-123`

#### 問題

同一個 `ContainerExecutor` 同時服務：

1. image 模式解析後的 mikan-managed container；
2. 使用者提供的既有 `container:<name>`。

但 `getPathContext()` 無條件建立：

```ts
createMountedRuntimePathContext(hostWorkspaceRoot, "/workspace");
```

這等同宣稱 runtime 的 `/workspace/x` 與 mikan host workspace 的 `x` 是同一檔案。Direct container validation 只檢查 container 是否 running，沒有 inspect `/workspace` bind source，也沒有證明它指向傳入的 `hostWorkspaceRoot`。

Caller 因而可能透過 `runtimeToHostPath` 讀到 host 上錯誤的同名檔案、繞過 container transport，或錯誤處理 runtime attachment。

#### 最小修正方向

區分 managed image container 與 direct container 的 path semantics。Direct `container:*` 預設不提供 `runtimeToHostPath`；只有 mounts 已由 provisioner authority 保證的 image container 才提供 host mapping。

---

### 4. Exec-backed binary read 受 10 MiB output cap 靜默截斷

- **Severity:** High
- **檔案：行號：**
  - `src/sandbox/host.ts:56-67`
  - `src/sandbox/container.ts:95-96`
  - `src/sandbox/container.ts:124-130`
  - `src/sandbox/firecracker.ts:109-116`
  - `src/sandbox/utils.ts:67-83`

#### 問題

`HostExecutor.exec()` 對 stdout/stderr 超過 10 MiB 時保留前 10 MiB，沒有 error 或 truncated marker。

Container 的 binary read 路徑是：

```text
base64 command
  → ContainerExecutor.exec()
  → HostExecutor.exec()
  → stdout 靜默截斷
```

約 7.5 MiB 以上的 binary file 就可能得到被截斷的 base64。Firecracker 也存在相同 cap；Host native file read、Gondolin 與 Cloudflare 則有不同語義。

`Executor.readFileBase64()` 因而沒有一致的 binary transport contract，而且會成功回傳損壞內容，而非明確失敗。

#### 最小修正方向

Binary transport 不應共用一般 command output 的靜默 cap。至少在超限時 throw；較完整的修正是使用 streaming/chunking 或 backend-native binary channel。

---

### 5. Vault `targetPath` 只被驗證，沒有被保存

- **Severity:** High
- **檔案：行號：**
  - `src/vault/types.ts:36-38`
  - `src/vault/index.ts:189-204`
  - `src/vault/index.ts:208-220`
  - `src/vault/index.ts:225-235`

#### 問題

`VaultManager.upsertFile()` 允許 caller 指定 `targetPath`。實作會驗證它，但之後只把內容寫到 `relativePath`；`targetPath` 沒有存進 metadata。

重新 resolve vault 時，`inferMountsFromDir()` 只根據 top-level filename 呼叫 `inferredVaultTargetPath()`。因此 caller 指定的合法 custom target 會被忽略，credential file target authority 分裂成 login/OAuth output 與 vault filename heuristic。

目前內建的已知檔名可能剛好推導出相同 target，因此會掩蓋問題；custom OAuth 或 extension output 不保證如此。

#### 最小修正方向

二選一：

1. 若只允許固定檔名規則，從 interface 移除 `targetPath`，由單一 mapping authority 決定；
2. 若支援 custom target，將 mount manifest 與 vault 一起原子保存，`buildResolved()` 讀 manifest，不再靠檔名猜測。

---

### 6. Cloudflare 被建模成 selectable persistent office backend，違反 ADR 0004

- **Severity:** High
- **檔案：行號：**
  - `src/sandbox/types.ts:3-9`
  - `src/sandbox/types.ts:64-67`
  - `src/sandbox/index.ts:27-34`
  - `src/sandbox/index.ts:71-100`
  - `src/execution-resolver.ts:105-110`
  - `src/sandbox/cloudflare.ts:69-78`
  - `src/sandbox/cloudflare.ts:175-180`

#### 問題

ADR 0004 明確決定 Cloudflare Sandbox 應屬於 ephemeral Factory floor，不應存在於 conversation `SandboxConfig` 或成為 default office runtime。

目前 Cloudflare：

- 是 `SandboxConfig` union 成員；
- 可由 CLI `cloudflare:<id>` 選取；
- 可被 `ActorExecutionResolver` 解析；
- 以 conversation resource key scope sandbox ID；
- 沒有 factory job 所要求的 explicit input/result/teardown contract；
- 假設固定 `/workspace` 可跨 turn 使用。

這是 seam placement 錯誤，不只是 lifecycle 尚未補完。

#### 最小修正方向

從 conversation sandbox adapter inventory 與 `SandboxConfig` 移除 Cloudflare selectable path，保留 implementation 給未來 factory-job interface。不要在 `ActorExecutionResolver` 內補 persistent lifecycle，因為 seam 本身放錯了。

## Medium severity

### 7. `ActorExecutionResolver` 的 public interface 沒有暴露 execution identity plan，caller 被迫重算 key

- **Severity:** Medium
- **檔案：行號：**
  - `src/execution-resolver.ts:35-79`
  - `src/execution-resolver.ts:105-119`
  - `src/commands/login.ts:40-47`
  - `src/commands/login.ts:56-76`
  - `src/commands/sandbox.ts:67-70`
  - `src/tools/sandbox.ts:61-65`

#### 問題

Resolver 內部集中組合 credential key、resource key、vault injection、workspace projection、concrete sandbox config 與 mounts，但 `resolvePlan()` 是 private，public interface 只回傳 `Executor`。

需要操作 vault、resource limits 或 container lifecycle 的 caller 因而只能繞開 resolver，再次呼叫 identity helpers。實際 authority 分散在：

- `sandbox/identity.ts`：credential/resource naming；
- `vault/index.ts`：credential injection；
- `workspace-projection/index.ts`：mount policy；
- resolver：最後組裝；
- callers：重新推算 resource/credential identity。

第 1 項的 credential/resource 混用就是具體後果。

#### 最小修正方向

讓 resolver interface 回傳 typed execution plan，例如 `{ executor, credentialKey, resourceKey }`，或抽出可供 login/runtime/tools 共用的 resolved execution identity。避免跨模組傳遞裸 `string` key。

---

### 8. Gondolin file methods 丟棄 `ExecOptions`

- **Severity:** Medium
- **檔案：行號：**
  - `src/sandbox/types.ts:77-97`
  - `src/sandbox/gondolin.ts:916-934`
  - `src/sandbox/utils.ts:67-120`

#### 問題

`Executor` interface 允許 `readFile`、`readFileBase64`、`writeFile` 接受 `ExecOptions`。Container、Firecracker、Cloudflare 都把 options 傳入 exec-backed file transport。

Gondolin methods 沒有 options 參數，且呼叫：

```ts
execReadFile(this, path);
execReadFileBase64(this, path);
execWriteFile(this, path, content);
```

Tool 傳入的 abort signal 因而在 Gondolin file operation 中失效。Chunked write 尤其可能在使用者 abort 後繼續執行並完成 rename。

#### 最小修正方向

讓三個 methods 接受並向下傳遞 `ExecOptions`，與其他 exec-backed adapters 一致；增加 abort-during-chunked-write contract test。

---

### 9. Host file methods 完全忽略 `ExecOptions`

- **Severity:** Medium
- **檔案：行號：**
  - `src/sandbox/types.ts:77-97`
  - `src/sandbox/host.ts:95-107`

#### 問題

Host 的 `readFile`、`readFileBase64`、`writeFile` 沒有接收 options，因此 caller 傳入的 signal 不會生效。相較之下 remote backends 多半透過 command transport 處理 signal。

同一 tool、同一 signal 會因 backend 不同而決定 operation 是否仍完成 side effect。

#### 最小修正方向

明確定義 Executor file cancellation contract，讓 host 實作使用支援 signal 的 `fs/promises` options。若無法提供完整 cancellation，interface 文件應明確限定 guarantee。

---

### 10. HostExecutor 未處理 child process `error` event

- **Severity:** Medium
- **檔案：行號：**
  - `src/sandbox/host.ts:21-30`
  - `src/sandbox/host.ts:70-92`

#### 問題

Promise 只監聽 `close`，沒有監聽 `child.on("error")`。若 `spawn()` 無法啟動 shell，可能成為 unhandled error，promise 也沒有可靠 reject path。

Firecracker 無 env 分支與 Container executor 都依賴 HostExecutor；Firecracker 有 env 的直接 spawn 分支反而有處理 `error`，顯示 backend error contract 分歧。

#### 最小修正方向

加入單次 settle 的 `error` handler，清除 timeout/signal listener 後 reject。Host 與 Firecracker 可共用同一 process execution primitive，避免兩份近似但不同的 signal/error implementation。

---

### 11. Container credential env transport 靜默改寫 secret value

- **Severity:** Medium
- **檔案：行號：**
  - `src/vault/index.ts:45-75`
  - `src/sandbox/container.ts:176-188`
  - `src/sandbox/firecracker.ts:246-259`
  - `src/sandbox/cloudflare.ts:97-104`
  - `src/sandbox/gondolin.ts:646-653`

#### 問題

Container env file 對 value 執行：

```ts
value.replace(/\r?\n/g, "");
```

Multiline secret 因而被無聲改值。env key 也未驗證便寫入 Docker env file。

其他 backend 的行為不同：Firecracker 驗證 key 並 throw；Gondolin 傳 session env array；Cloudflare 以 JSON object 傳送。相同 vault 在不同 backend 可能得到不同 credential 值或不同錯誤結果。

#### 最小修正方向

在 vault injection 的單一 authority 定義並驗證共同 env contract。若 multiline 不支援，所有 backend 一致拒絕並指出 key；不要由 Container adapter 靜默改寫 secret。

---

### 12. Provisioner `remove()` 吞掉 removal failure，仍刪除 ownership state

- **Severity:** Medium
- **檔案：行號：**
  - `src/provisioner.ts:221-246`
  - `src/provisioner.ts:991-1007`

#### 問題

`forceRemoveContainer()` 捕捉所有錯誤只記 warning，不把成功/失敗回傳。`remove()` 接著無條件清除 state、boost 與 override limits。

可能出現 container 仍在 running，但 manager 已認為 teardown 完成；caller 收到 resolved promise，舊 mounts/credentials 繼續存在直到之後的 reconcile 或 provision。

對 credential refresh 與隔離切換而言，這不是單純 best-effort cleanup，而是 teardown correctness。

#### 最小修正方向

`forceRemoveContainer()` 應回傳結果，或在非「already missing」錯誤時 throw。只有確認 container missing 後才能清除 ownership state；network/image cleanup 可另外維持 best effort。

## 疑問／需確認 contract

### Q1. Cloudflare abort 是否真的終止 remote command？

- **Severity:** Question
- **檔案：行號：** `src/sandbox/cloudflare.ts:80-143`

#### 問題

目前 abort 只中止 host 到 bridge 的 HTTP request。除非 bridge 保證 HTTP disconnect 會 kill sandbox command，否則 `Executor.exec()` reject 後 remote process 仍可能繼續產生 side effects。

#### 最小修正方向

Bridge protocol 提供 command ID 與 explicit cancel，或以文件及 integration test 證明 request abort 等同 remote kill。

---

### Q2. Firecracker 的 `hostPath` 由誰保證出現在 guest `/workspace`？

- **Severity:** Question
- **檔案：行號：**
  - `src/sandbox/firecracker.ts:21-48`
  - `src/sandbox/firecracker.ts:89-97`
  - `src/sandbox/firecracker.ts:224-241`

#### 問題

Validation 只確認 host path 存在；executor 固定在 guest 使用 `/workspace`，但目前審查範圍內看不到 mount/provision authority。若依賴外部 VM 預配置，`hostPath` 只是未驗證宣告，不是實際 projection。

#### 最小修正方向

在 validation inspect/驗證 guest mount identity，或從 config 移除造成錯誤保證的 `hostPath`，明確將 workspace mapping 列為外部前置條件。
