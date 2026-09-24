# Sandbox container 管理通盤檢查（2026-09）

範圍：`image:*` 受管容器（`src/sandbox/provisioner.ts`）。決策依據為 [ADR 0009](../adr/0009-sandbox-persistence-model.md)。
`container:*`、host、Cloudflare 模式不受影響。

## 核心問題：image 更新後，使用者容器不會跟著更新

根因有兩個：

1. 容器一旦建立就只會 `docker start`，不會比對 image。
2. mount 或 network 漂移時，mikan 先 `docker commit` 再從 snapshot 重建，於是舊 base image 被永久釘住。

生產環境（2026-09-23）：`1.0.0-beta.77` 之後，51 個容器中有 49 個仍跑舊 image；writable layer 的變更約 95% 在 `/root`。

### 解法（已實作）

| 項目               | 做法                                                                                                                                                                                                                  | 程式位置                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 使用者狀態         | 每個 office 一個 named volume `mikan-home-<key>`，掛在 `/root`，帶有 `mikan.managed` 與 `mikan.vault-id` label                                                                                                        | `runContainer`、`ensureHomeVolume`           |
| 偵測 image 漂移    | 比對容器的 `.Image` 與本機 tag 的 `docker image inspect .Id`。本機沒有該 image 時不算漂移，mikan 不會 pull                                                                                                            | `hasImageDrift`                              |
| 替換時機           | 只替換已停止的 home-volume 容器：閒置停止後，下一次 provision 時以 `docker rm` + `docker run` 搭配同一個 volume 替換。執行中的容器不中斷                                                                              | `runtimeDrift`、`replaceHomeVolumeContainer` |
| mount/network 漂移 | home-volume 容器直接替換，不 commit，順便換上新 image；legacy 容器維持原本的 commit 路徑                                                                                                                              | `provisionInner`                             |
| 既有容器遷移       | `mikan sandbox migrate`：commit，以 snapshot 在空 volume 上跑一次（由 Docker 把 `/root` 複製進 volume），接著 rm，再從目前 image 以原本的 binds 與 conversation label 重建；原本停止的容器維持停止，最後刪除 snapshot | `migrateToHomeVolume`、`src/cli/sandbox.ts`  |
| 升級前檢視         | `mikan sandbox diff <key>`：列出 `docker diff` 中 `/root`、`/workspace` 以外會被丟棄的路徑                                                                                                                            | `systemChanges`                              |
| 盤點               | `mikan sandbox status`：列出 legacy/home-volume、running/stopped、current/stale image                                                                                                                                 | `inventory`                                  |
| 回滾               | 把 tag 指回舊 image ID，容器會再被替換，volume 不變                                                                                                                                                                   | —                                            |

### Operator 升級流程

```bash
docker pull ghcr.io/geminixiang/mikan-sandbox:latest      # 保留舊 image ID 以便回滾
mikan sandbox status --image ghcr.io/geminixiang/mikan-sandbox:latest
# 以下先停止 daemon，小批次進行
mikan sandbox diff <key> --image …
mikan sandbox migrate <key> [<key>...] --image …
# 啟動 daemon。home-volume 容器閒置停止後，會自動換到新 image
```

## 其他管理問題

| #   | 問題                                | 發現                                                                                                           | 處置                                                                                                                                                                               |
| --- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `stop` 與 `provision` 競態          | 原本只有 `provision` 做 in-flight 去重。`stopIdle` 的 `docker stop` 可能插進 provision 的 inspect 與 exec 之間 | 已修：`provision`、`stop`、`remove`、`migrateToHomeVolume` 按 key 串行化（ADR 0009 §6）                                                                                            |
| 2   | `/login` 重建會清掉使用者安裝的內容 | `refreshCopiedVaultRuntime` 會呼叫 `remove()`，連同整個 writable layer 一起刪除                                | 已改善：`remove()` 預設保留 home volume，重建後 `/root` 仍在                                                                                                                       |
| 3   | office 被移除後，資源殘留           | 原本只移除容器和 network                                                                                       | 已修：`removeContainersForConversations` 一併刪除 home volume；`remove(key, { purgeHome: true })` 可供明確清除                                                                     |
| 4   | 單檔 vault bind 與 inode 問題       | re-login 以原子 rename 寫檔，容器仍持有舊 inode，所以靠 `mount-signature` 內容雜湊觸發重建                     | 暫不處理（ADR rollout 2）。home-volume 容器的重建已改成便宜的 rm+run，且保留 `/root`，因此代價從「丟掉所有安裝」降為「重啟容器」。改成目錄 bind 會改變憑證路徑，應獨立進行         |
| 5   | 一直忙碌、從不閒置的容器不會升級    | 替換只發生在停止之後                                                                                           | 刻意設計：不中斷執行中的工作。operator 可在 `status` 看到 `stale-image`，並手動 `docker stop`                                                                                      |
| 6   | 舊 image 與停止的容器佔用磁碟       | 停止的 stale 容器仍引用舊 image，`docker image prune` 無法清除                                                 | home-volume 容器可以安全地 `docker rm`（下一則訊息會以 volume 重建）；清除後再 prune。volume 用量以 `docker system df -v` 查看                                                     |
| 7   | 遷移中斷                            | commit 之後、run 之前失敗                                                                                      | snapshot `mikan-migrate:<name>` 仍在；volume 若已建立，下次 `migrate` 會因容器已不存在而回報 `missing`。此時可用 snapshot 手動恢復；開機時的 layout sweep 會清理 dangling snapshot |
| 8   | legacy commit 路徑仍在              | legacy 容器發生 mount 漂移時仍會 commit                                                                        | ADR rollout 5：待 `status` 顯示已無 legacy 容器，再刪除 commit、`mikan-migrate` 與 stale-mountpoint 相關程式碼                                                                     |
| 9   | 資源限制                            | 替換後以 `effectiveLimits` 重新帶入 `--cpus`/`--memory`；boost 本來就隨停止而清除                              | 無需改動                                                                                                                                                                           |
| 10  | 安全基線                            | 替換與遷移都走 `runContainer`，一樣帶 `--cap-drop ALL`、`no-new-privileges`、`--pids-limit`、獨立 network      | 無需改動；遷移時的 seed 容器以 `--network none` 執行                                                                                                                               |

## 驗證

- 單元測試：`src/test/provisioner-home-volume.test.ts`、`src/test/provisioner.test.ts`、`src/test/cli-sandbox.test.ts`。
- 真實 Docker（colima，Docker 29.5.2），使用 `dist/sandbox/provisioner.js`，以 retag 模擬 image 發版：
  - 新容器：binds 為 `["mikan-home-e2e-home:/root", …]`。
  - 發版後仍在執行的容器沒有被動到；`inventory` 顯示 `imageStale: true`。
  - `stop` 後 provision 時換成新 image：`/root/state` 保留，`/etc/sysfile` 被丟棄。
  - legacy 容器：`diff` 回報 `A /usr/bin/custom`；`migrate` 之後 `/root/.npm/x` 保留，image 為目前版本，conversation label 保留，再次 migrate 回報 `already-migrated`，沒有殘留 snapshot。
  - `remove(..., { purgeHome: true })` 會刪除 volume。
