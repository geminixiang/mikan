# RFC: Sandbox Provider 架構與 Secret 注入安全模型

- 狀態：Draft
- 範圍：`src/sandbox/`、`src/vault/`、`src/provisioner.ts`、`src/execution-resolver.ts`
- 目標：解耦 sandbox 抽象，使其能以「外掛 provider」方式兼容第三方沙盒（Cloudflare Sandbox、E2B、gondolin、Docker Sandboxes），並把 vault secret 注入從「secrets 與 untrusted code 同處一室」升級為業界標準的 control-plane 託管模型。

---

## 1. 現況問題盤點

### 1.1 `Executor` 介面太薄，lifecycle 被外掛

`src/sandbox/types.ts` 的 `Executor` 只有 `exec()` + path 三件套。沒有 lifecycle（create/start/stop/destroy）、沒有 fs API、沒有 secret 模型。結果是：

- Lifecycle 以 `ensureReady?: () => Promise<void>` callback 形式從外部塞進來，而且只對 `image → container` 這一條路徑生效（`execution-resolver.ts` 中 `baseConfig.type !== "image" || config.type !== "container"` 的硬編判斷）。
- 其他後端（firecracker、cloudflare）拿到 `ensureReady` 但直接忽略，介面契約名存實亡。
- E2B / gondolin 這類「sandbox 由 SDK 建立與回收」的後端塞不進這個模型：它們的 create/connect/pause/kill 沒有地方放。

### 1.2 跨層 type-switch：vault 與 sandbox 互相知道對方細節

- `vault/routing.ts` 枚舉 sandbox type（`container` / `image` / `cloudflare` / `firecracker`）決定 vault key，還 import `DockerContainerManager.sanitizeSegment` —— **vault 層依賴 Docker provisioner**。
- `FileVaultManager.getSandboxConfig()` 特判 `cloudflare` 改寫 `sandboxId` —— **vault 層改寫 sandbox config**。
- `ResolvedVault.mounts` 的 target 直接是容器內路徑（`/root/.ssh` 等）—— **vault 層假設執行環境是 Docker 容器**。

每新增一種沙盒，至少要改 vault routing、vault manager、execution resolver、sandbox index 四處。這就是目前「加第三方沙盒阻力很大」的直接原因。

### 1.3 `image:` 是偽 config，「模板 → 執行個體」沒有被建模

`imageSandboxAdapter.createExecutor()` 直接 throw；`image:` config 必須在 `ActorExecutionResolver.resolveSandboxConfig()` 內被換成 `container:` config。「規格（spec/template）→ 取得執行個體（instance）」這個階段轉換沒有抽象，所以：

- per-conversation 命名、idle auto-stop、resource limits、boost 全部只對 image 模式存在（見 `docs/sandbox.md` 能力表），其他後端無法復用。
- 每加一個 managed 後端（E2B template、gondolin VM、Docker Sandboxes）都得在 resolver 再寫一條特例。

### 1.4 `DockerContainerManager` 是頂層單例式依賴

`src/provisioner.ts`（650 行，Docker-only）被 `execution-resolver.ts` 與 `vault/routing.ts` 直接 import，包括其 static naming function。Provisioning 應該是某個 provider 的內部實作細節，而不是 control plane 的公共依賴。

### 1.5 Vault 注入的安全隱患

| 模式 | 注入方式 | 風險 |
| --- | --- | --- |
| `container:` / `image:` | 每次 exec 寫 secrets 到 host tmpdir env file（0600）→ `docker exec --env-file` | secrets 進入容器內整個 process tree 的 env；沙盒內 untrusted code 用 `env` 或 `/proc/*/environ` 即可整包讀走後 exfiltrate。host 端 crash 時 env file 可能殘留。 |
| `cloudflare:` | 每次 exec 把整包 vault env 放進 HTTP POST body 送 bridge | secrets 每次過網路；可能進 Worker logs / observability pipeline；bridge 只有單一 static bearer token。 |
| `firecracker:` | SSH stdin 注入 | 同樣是「整包 env 進 VM」。 |
| vault file mounts | 直接 bind mount（`/root/.ssh`、gcloud ADC 等） | 沙盒內 agent code 可直接讀走私鑰原文。 |

根本問題只有一個：**secrets 與 untrusted code 同處一室**。只要 agent 生成的程式碼在沙盒內能讀到真值，任何網路出口都是 exfiltration 通道。這不是哪個注入管道實作得不夠細的問題，而是模型問題。

---

## 2. 業界標準對照

2025–2026 年主要 agent sandbox 的 API 都收斂到同一個形狀：**provider 建立/連接 sandbox instance → instance 提供 exec / fs / lifecycle**。

| | 建立/連接 | 執行 | 檔案 | Secrets |
| --- | --- | --- | --- | --- |
| **E2B** | `Sandbox.create({envs})` / `Sandbox.connect(id)` / `pause()` / `kill()` | `sbx.commands.run(cmd, {cwd, envs, timeoutMs, background})` | `sbx.files.read/write/list` | create-time 或 per-run envs |
| **Cloudflare Sandbox SDK** | `getSandbox(ns, id)` | `sandbox.exec(cmd, {cwd, env})`、`startProcess` | `sandbox.writeFile/readFile` | per-exec env |
| **Docker Sandboxes (`sbx`)** | microVM per sandbox，自帶獨立 dockerd | `sbx run` / agent 直接在內 | VM 內檔案系統 | 環境隔離靠 microVM 邊界 |
| **gondolin** | `VM.create({httpHooks, env})` / `vm.close()` | `vm.exec(cmd)` | programmable VFS mounts | **guest 只看到 placeholder；host 端 egress proxy 在 allowlisted 目的地替換真值** |

兩個關鍵結論：

1. **API 形狀**：`Provider.acquire() → Instance.{exec, fs, lifecycle}` 是事實標準。mikan 目前的 `createExecutor(config, env, ensureReady)` 與它不同構，所以每接一家都很痛。
2. **Secret 模型**：gondolin 的「placeholder + host-side egress 替換」是目前 agent sandbox secrets 的最高標準（Docker Sandboxes 用 microVM 邊界 + 即將推出的 proxy 政策走同方向）。E2B/Cloudflare 仍是 env 注入，但至少是 **create-time / session-scoped**，而非 mikan 目前的 per-exec 整包重送。

---

## 3. 目標架構

### 3.1 SPI：`SandboxProvider` / `SandboxInstance`

```ts
// src/sandbox/spi.ts —— 新的穩定介面（provider 作者面對的全部）

export interface SandboxProvider<TSpec extends SandboxSpec = SandboxSpec> {
  readonly name: string; // "host" | "docker" | "cloudflare" | "e2b" | "gondolin" | ...
  readonly capabilities: SandboxCapabilities;

  /** 解析 CLI 字串（"image:x"、"e2b:tmpl"…）為 spec；不匹配回傳 undefined */
  parseSpec(value: string): TSpec | undefined;
  /** 啟動時驗證（docker 可用、bridge 健康、API key 存在…） */
  validate(spec: TSpec): Promise<void>;
  /** spec（模板）+ actor context → 可用的執行個體。冪等：已存在則 connect/start。 */
  acquire(spec: TSpec, ctx: AcquireContext): Promise<SandboxInstance>;
}

export interface AcquireContext {
  userId: string;
  conversationId: string;
  /** control plane 計算出的 scope key（取代散落各處的 vault key 推導） */
  scopeKey: string;
  workspace: WorkspaceSpec; // host root + 想要的掛載/同步模式
  secrets: SecretSource;    // 見 3.3；provider 依自身 capability 取用
}

export interface SandboxInstance {
  readonly id: string;
  readonly paths: RuntimePathContext;

  exec(command: string, opts?: ExecOptions): Promise<ExecResult>; // 與現有 Executor.exec 相容

  /** optional capability：有 fs API 的後端（E2B、Cloudflare、gondolin VFS）用它投影 vault file，不再 bind mount */
  readonly fs?: SandboxFs;

  suspend?(): Promise<void>; // idle-stop（docker stop / e2b pause）
  destroy?(): Promise<void>;
}

export interface SandboxCapabilities {
  /** external：使用者自管（container:、firecracker:）；managed：mikan 負責 lifecycle */
  lifecycle: "external" | "managed";
  /** shared：所有人同一執行環境；per-acquire：每個 scopeKey 一個 instance */
  isolation: "shared" | "per-acquire";
  /** secrets 注入能力，control plane 據此選擇注入策略，見 3.3 */
  secretInjection: ("at-create" | "per-exec" | "file-push" | "egress-broker")[];
  bindMounts: boolean;
  networkPolicy: boolean; // gondolin httpHooks / 未來 Docker Sandboxes proxy
}
```

要點：

- **兩階段模型**取代 `ensureReady`：`image:` 偽 config、provisioner 注入、per-conversation 命名全部收進 docker provider 的 `acquire()` 內部。`DockerContainerManager` 降級為 `src/sandbox/providers/docker/` 的私有實作。
- **`Executor` 保持相容**：tools（bash/read/write/edit）與 agent.ts 只用 `exec` + path 三件套，`SandboxInstance` 是其超集，舊介面可以 `type Executor = Pick<SandboxInstance, "exec" | ...>` 過渡，tools 層零改動。
- **CLI 字串格式不變**：`host` / `container:` / `image:` / `firecracker:` / `cloudflare:` 照舊，新增 `e2b:<template>`、`gondolin[:<profile>]`。

### 3.2 用 capabilities 取代跨層 type-switch

`vault/routing.ts` 的 type 枚舉刪除，改成由 control plane 依 capability 推導 scope：

```ts
function resolveScopeKey(provider: SandboxProvider, spec, userId, conversationId): string {
  if (provider.capabilities.isolation === "shared") {
    return provider.sharedScopeKey(spec); // e.g. "container-<name>"
  }
  return sanitizeSegment(conversationId);  // per-acquire：1 conversation = 1 vault = 1 instance
}
```

`FileVaultManager.getSandboxConfig()`（cloudflare 特判）整個刪除——derived sandbox id 是 cloudflare provider 在 `acquire()` 內用 `ctx.scopeKey` 自己算的事。`docs/sandbox.md` 那張能力表從文件變成程式內的 `capabilities` 宣告，文件改為由它生成或對照。

### 3.3 Secret 注入：分層模型（核心安全改進）

`VaultManager` 不再輸出「一包 env + 一串 mount」，改輸出 `SecretSource`，由 control plane 依 provider capability 選擇**最高可用等級**的注入策略：

```
Tier 0  per-exec env 注入（現狀）        —— 僅作為相容 fallback，標記 deprecated
Tier 1  at-create env + file-push        —— instance 建立時注入一次；檔案經 fs API 寫入，
                                            不再 bind mount host vault 目錄
Tier 2  egress broker（gondolin 模型）   —— guest 只拿 placeholder（如 $GH_TOKEN 形式的
                                            不透明 token），host 端 proxy 在 allowlisted
                                            目的地替換真值；secrets 永不進 sandbox
```

- **Tier 2 是目標**。gondolin provider 先天支援（`VM.create({ httpHooks })` 把 vault secrets 映射為 host-allowlist 替換規則）；Cloudflare bridge 可在 Worker 端加同款 egress proxy；docker provider 可用 sidecar proxy（容器 network 已是 per-conversation bridge，把出口導向 host broker 即可）。
- **Tier 1 是近期落地點**：
  - cloudflare：停止每次 `/exec` 重送整包 env，改為 create-time `setEnvVars` / session-scoped 注入；bridge token 改為 per-sandbox derive 或短效。
  - container/image：以 `docker exec -e KEY` + stdin 或 create-time `-e` 取代 tmpdir env file，消除殘留風險。
  - file credentials：有 `fs` capability 的後端用 `fs.writeFile` 投影（E2B/Cloudflare 因此首次獲得 vault file 支援），bind mount 僅剩 docker 的 fallback。
- 所有注入動作經過單一 chokepoint（`SecretInjector`），統一打 audit log（哪個 scopeKey、哪些 key、哪個 tier、哪個 instance）。

### 3.4 落地後的模組結構

```
src/sandbox/
├── spi.ts                  # SandboxProvider / SandboxInstance / capabilities（穩定 SPI）
├── registry.ts             # provider 註冊、parseSpec 輪詢、錯誤提示
├── secret-injector.ts      # Tier 選擇 + audit chokepoint
├── providers/
│   ├── host.ts
│   ├── docker/             # container: 與 image: 合併於此；provisioner.ts 移入為私有
│   ├── firecracker.ts
│   ├── cloudflare.ts
│   ├── e2b.ts              # 新增：Sandbox.create/connect/pause + commands.run + files
│   └── gondolin.ts         # 新增：VM.create({httpHooks}) + vm.exec；Tier 2 參考實作
```

`src/execution-resolver.ts` 縮減為：算 scopeKey → 取 provider → `provider.acquire(spec, ctx)`，不再 import provisioner、不再特判任何 type。

---

## 4. 遷移計畫

| Phase | 內容 | 行為變化 |
| --- | --- | --- |
| **1. SPI 抽取** | 定義 spi.ts / registry.ts；五個現有後端原樣搬進 provider 形狀；`image:` 特例與 `ensureReady` 收進 docker provider；vault routing 改走 capabilities | 無（CLI 字串、vault 目錄、容器命名全部不變；以現有 test suite 驗證） |
| **2. Secret Tier 1** | `SecretInjector` + at-create 注入 + fs file-push；cloudflare 停止 per-exec env；docker 移除 tmpdir env file | 安全性提升，使用者無感 |
| **3. 新 providers** | `e2b:<template>`、`gondolin` provider | 新功能 |
| **4. Secret Tier 2** | gondolin httpHooks 接 vault；cloudflare bridge / docker sidecar egress broker | secrets 不再進 sandbox（per-provider 漸進啟用） |

Phase 1 是純重構且可完全由現有測試覆蓋，建議先做——它直接解掉「加第三方沙盒要改四處」的阻力；Phase 2 解掉最痛的注入隱患；3、4 之後都是在穩定 SPI 上加 provider，不再動 control plane。

---

## 5. 參考

- gondolin（micro-VM + host-side policy/egress secret 替換）：<https://github.com/earendil-works/gondolin>、<https://earendil-works.github.io/gondolin/security/>
- E2B SDK（Sandbox lifecycle / commands / files）：<https://e2b.dev/docs>
- Cloudflare Sandbox SDK：<https://developers.cloudflare.com/sandbox/>
- Docker Sandboxes（microVM per agent sandbox，`sbx` CLI）：<https://docs.docker.com/ai/sandboxes/>
