---
title: Image sandbox
description: 使用 mikan 管理的 per-conversation Docker container 與 vault 隔離。
---

```bash
# Pull the prebuilt image from GHCR
# Release builds publish :tools, :<version>, and :latest / :beta
# Pushes to main also publish :edge
docker pull ghcr.io/geminixiang/mikan-sandbox:tools

# Run mikan with managed per-conversation containers
mikan --sandbox=image:ghcr.io/geminixiang/mikan-sandbox:tools /path/to/workspace
```

如果你想自行客製 image，也可以本地 build：

```bash
docker build -f deploy/docker/mikan-sandbox.Dockerfile -t mikan-sandbox:tools .
mikan --sandbox=image:mikan-sandbox:tools /path/to/workspace
```

特性：

- mikan 會為每個 conversation 建立一個獨立 vault 與 container
- 每個 container 都有自己的 Docker bridge network，隔離直接的 container-to-container networking；outbound network access 仍保持啟用
- 建立 managed container 時會加上 `--cap-drop=ALL`、`--security-opt=no-new-privileges` 與 `--pids-limit=1024`
- container 內只會看到 `/workspace/MEMORY.md`、`/workspace/skills`、`/workspace/events` 與當前 conversation 目錄
- vault env 會在執行時注入
- vault file credential 會依 target path 自動 bind mount 進 container
- 每 10 分鐘檢查一次閒置 containers，至少閒置 10 分鐘後停止；視掃描時間而定，約在最後一次追蹤使用後 10–20 分鐘停止

Vault key 選擇邏輯：

1. 將 conversation ID 正規化為小寫、把連續的非英數字元替換為 `-`、移除首尾 dash；若沒有剩餘內容則使用 `unknown`
2. 將該 conversation 的 credentials、mounts 與 env 寫入正規化的 vault key
3. 受管理 container 使用相同的正規化 key，例如 `mikan-sandbox-d123`

由於正規化可能把不同的 raw IDs 合併成相同值，請避免手動建構僅有標點符號或大小寫不同的平台 ID。

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
- `/pi-sandbox` 會顯示目前 conversation 的有效限制
- `/pi-sandbox boost` 會把目前 conversation 暫時升級到 `sandbox.boost` 規格；boost 狀態跟著 container，container stop 後就結束
- agent 可用內建 `sandbox` tool 查詢或暫時設定目前 conversation 的 CPU / memory limit；這類 override 也會在 container stop 後清除
