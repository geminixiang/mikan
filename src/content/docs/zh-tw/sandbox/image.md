---
title: Image sandbox
description: 使用 mikan 管理的 per-conversation Docker container 與 vault 隔離。
---

```bash
# Pull the prebuilt image from GHCR
# Release builds publish :tools, :<version>, and :latest / :beta
# Pushes to main also publish :edge
docker pull ghcr.io/geminixiang/mikan-sandbox:latest

# Run mikan with managed per-conversation containers
mikan --sandbox=image:ghcr.io/geminixiang/mikan-sandbox:latest /path/to/workspace
```

如果你想自行客製 image，也可以本地 build：

```bash
docker build -f deploy/docker/mikan-sandbox.Dockerfile -t mikan-sandbox:latest .
mikan --sandbox=image:mikan-sandbox:latest /path/to/workspace
```

特性：

- mikan 會為每個 conversation 建立一個獨立 vault 與 container
- 每個 container 都有自己的 Docker bridge network，隔離直接的 container-to-container networking；outbound network access 仍保持啟用
- 建立 managed container 時會加上 `--cap-drop=ALL`、`--security-opt=no-new-privileges` 與 `--pids-limit=1024`
- container 內在預設的 isolated policy 下只會看到該對話自己的 office 目錄；Admin 可明確選擇 trusted 的 shared-support 或 full-workspace layout
- vault env 會在執行時注入
- vault file credential 會自動 bind mount 進 container，target 由每個檔案的名稱推斷（見 [Vault](/zh-tw/sandbox/vault/)）
- 每 10 分鐘檢查一次閒置 containers，至少閒置 10 分鐘後停止；視掃描時間而定，約在最後一次追蹤使用後 10–20 分鐘停止

## Mount 與 conversation office

該對話的 office 目錄會以可讀寫的方式 bind mount 在 `/workspace/<office-key>`，其中 office key 就是 `v1-<platform>-<readable-id>-<hash>` 這段、同時也是宿主機上該目錄的名稱。在預設的 `isolated` door policy 下，這是唯一的 workspace mount；trusted 的 `shared-support` layout 會再加上 workspace 全域的 `MEMORY.md`、`skills/` 與 `events/`；`trusted` / `full` 則把整個 workspace root 掛在 `/workspace`。由 package 提供的 skills 會以唯讀方式掛在 `/workspace` 之外的 `/mikan/packages/<slug>/skills`。

變更 door policy 不會重置 container。當期望的 mount 與執行中的 container 不再相符時，mikan 會對它做 snapshot、用轉譯後的 mount 重新建立並再次啟動，因此在 container 自有檔案系統中安裝或寫入的東西都會在變更後存活下來。開機時 layout 遷移所做的 office 目錄改名，也走同一條路徑。

## Vault key 與 container key

Credentials 以 **office key** 為 key：某個對話的 vault 目錄是 `~/.mikan/vaults/<office-key>/`。這個 key 由平台名稱與該平台的原始 conversation id 一起雜湊而來，因此就算兩個平台剛好使用相同的 raw id，也絕不可能解析到對方的憑證。在舊的 raw-id 機制下寫入的 conversation vault 目錄，會由開機時的遷移改名為 office key。

受管 container 名為 `mikan-sandbox-<resource-key>`，其 network 則是 `mikan-sandbox-net-<resource-key>`。resource key 仍由原始 conversation id 推導（一段清理過的前綴加上短 digest）——改動它會讓每一個已佈建的 container 都被翻攪，因此它是分開遷移的。這裡發生碰撞的代價是一次 container 重建，絕不會影響憑證存取。

適合：

- 多使用者共用一個 mikan instance
- 需要 per-conversation env/file credential isolation
- 想比 shared container 更安全，但又不想直接上 Firecracker

## 容器資源限制

在 `settings.json` 中可設定每個 managed container 的 CPU 與記憶體上限：

```json
{
  "sandbox": {
    "cpus": "0.5",
    "memory": "512m",
    "boost": {
      "cpus": "2",
      "memory": "4g"
    }
  }
}
```

| 欄位                   | 說明                                       | 範例值           |
| ---------------------- | ------------------------------------------ | ---------------- |
| `sandbox.cpus`         | CPU 核心數上限（浮點數字串）               | `"0.5"`, `"2"`   |
| `sandbox.memory`       | 記憶體上限（Docker memory 格式）           | `"512m"`, `"2g"` |
| `sandbox.boost.cpus`   | `/pi-sandbox boost` 暫時套用的 CPU 上限    | `"2"`, `"4"`     |
| `sandbox.boost.memory` | `/pi-sandbox boost` 暫時套用的 memory 上限 | `"4g"`, `"8g"`   |

- 建立新 container 時，限制直接加進 `docker run` 參數
- 已在執行的 container 會在下次 provision 時透過 `docker update` 立即套用新限制，不需重新建立
- `/pi-sandbox` 會顯示目前 conversation 的有效限制，以及它的 door policy 與 layout
- `/pi-sandbox boost` 會把目前 conversation 暫時升級到 `sandbox.boost` 規格；boost 狀態跟著 container，container stop 後就結束
- `/pi-sandbox door <default|isolated|shared|full>` 可切換這個 office 的 door policy；container 會在下一則訊息時以新的 mount 重建，並保留原本的內容
- agent 可用內建 `sandbox` tool 查詢或暫時設定目前 conversation 的 CPU / memory limit；這類 override 也會在 container stop 後清除
